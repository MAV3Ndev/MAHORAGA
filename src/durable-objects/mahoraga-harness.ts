/**
 * MahoragaHarness — Thin Orchestrator
 *
 * This Durable Object is the core scheduler: it runs alarm() every 30s,
 * delegates data gathering, research, and trading decisions to the active
 * strategy (src/strategy/index.ts), and enforces policy/safety via PolicyBroker.
 *
 * Users customize their strategy in src/strategy/my-strategy/ and change ONE
 * import line in src/strategy/index.ts. This file does NOT need to be modified.
 */

import { DurableObject } from "cloudflare:workers";
import { createPolicyBroker, isWithinExtendedHoursSession } from "../core/policy-broker";
import {
  getPeriodStartMs,
  getPositionHistoryLimit,
  getPositionHistoryTimeframeCandidates,
  getPositionHistoryTimeframeMs,
  normalizePortfolioHistoryTimeframe,
} from "../core/position-history";
import { getPositionResearchCandidates, shouldRunPositionResearch } from "../core/position-research";
import {
  buildSocialSnapshot,
  getSocialSnapshotCache,
  serializeSocialSnapshot,
  updateSocialHistoryFromSnapshot,
} from "../core/social-snapshot";
import type {
  AgentState,
  LogEntry,
  PositionEntry,
  ResearchResult,
  Signal,
  SocialSnapshotCacheEntry,
} from "../core/types";
import type { Env } from "../env.d";
import {
  createDailyReportBucket,
  DAILY_REPORT_RETENTION_MS,
  formatDailyReportEmbed,
  getDailyReportBucketStart,
  pruneDailyReportBuckets,
  shouldSendDailyReport,
  summarizeDailyActivity,
} from "../lib/discord-report";
import { bearerTokenMatches, jsonAuthResponse } from "../lib/auth";
import { parseLlmJsonObject } from "../lib/llm-json";
import { getDefaultPolicyConfig } from "../policy/config";
import { createAlpacaProviders } from "../providers/alpaca";
import { createLLMProvider } from "../providers/llm/factory";
import { computeTechnicals } from "../providers/technicals";
import type { Account, LLMProvider, MarketClock, Order, Position } from "../providers/types";
import type { AgentConfig } from "../schemas/agent-config";
import { safeValidateAgentConfig } from "../schemas/agent-config";
import { createD1Client } from "../storage/d1/client";
import { activeStrategy } from "../strategy";
import { DEFAULT_STATE } from "../strategy/default/config";
import {
  checkTwitterBreakingNews,
  gatherTwitterConfirmation,
  isTwitterEnabled,
} from "../strategy/default/gatherers/twitter";
import { getCryptoSymbolAliases, isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import {
  computeAnalystRecommendationNotional,
  shouldBypassLlmMinHold,
} from "../strategy/default/helpers/analyst-guardrails";
import {
  isBroadMarketProxyTicker,
  isBuiltInTickerBlacklisted,
  isCustomTickerBlacklisted,
  isTickerBlacklisted,
  shouldRescueBuiltInBlacklistedTicker,
  tickerCache,
} from "../strategy/default/helpers/ticker";
import { runCryptoTrading } from "../strategy/default/rules/crypto-trading";
import { findBestOptionsContract } from "../strategy/default/rules/options";
import type { StrategyContext } from "../strategy/types";

interface TechnicalDataCacheEntry {
  updated_at: number;
  current_price?: number;
  rsi?: number;
  bb_lower?: number;
  bb_middle?: number;
  sma_20?: number;
  sma_50?: number;
  atr?: number;
  relative_volume?: number;
}

interface MomentumDataCacheEntry {
  updated_at: number;
  price_change_1h?: number;
  price_change_24h?: number;
  volume_change?: number;
}

// ============================================================================
// DURABLE OBJECT CLASS
// ============================================================================

export class MahoragaHarness extends DurableObject<Env> {
  private state: AgentState = { ...DEFAULT_STATE };
  private _llm: LLMProvider | null = null;
  private lastLLMReinitAttemptAt = 0;
  private _etDayFormatter: Intl.DateTimeFormat | null = null;
  private readonly MARKET_CONTEXT_TTL_MS = 10 * 60 * 1000;
  private readonly MAX_MARKET_CONTEXT_SYMBOLS = 24;
  private readonly TRANSIENT_RESEARCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  private readonly SIGNAL_RESEARCH_CACHE_TTL_MS = 180_000;
  private readonly SIGNAL_RESEARCH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
  private readonly VOLATILE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
  private readonly TWITTER_CONFIRMATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  private readonly MAX_SIGNAL_RESEARCH_COOLDOWNS = 256;
  private readonly MAX_LOG_ENTRIES = 500;
  private readonly MAX_STATUS_SIGNAL_RESEARCH_ENTRIES = 40;
  private readonly MAX_STATUS_TWITTER_CONFIRMATIONS = 24;
  private readonly LLM_REINIT_COOLDOWN_MS = 60_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this._llm = createLLMProvider(env);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${env.LLM_PROVIDER || "openai-raw"}`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured - research disabled");
    }

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>("state");
      let stateChanged = false;
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
        this.state.config = { ...DEFAULT_STATE.config, ...this.state.config };
      }
      stateChanged = this.applyStateHygiene() || stateChanged;
      this.initializeLLM();

      if (this.state.enabled) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        const now = Date.now();
        if (!existingAlarm || existingAlarm < now) {
          await this.ctx.storage.setAlarm(now + 5_000);
        }
      }

      if (stateChanged) {
        await this.ctx.storage.put("state", this.state);
      }
    });
  }

  private initializeLLM() {
    const rawProvider = (this.state.config.llm_provider || this.env.LLM_PROVIDER || "openai-raw") as string;
    const provider = rawProvider === "openai-compatible" ? "openai-raw" : rawProvider;
    const model = this.state.config.llm_model || this.env.LLM_MODEL || "gpt-4o-mini";
    const openaiBaseUrl = this.state.config.openai_base_url?.trim() || this.env.OPENAI_BASE_URL;

    const effectiveEnv: Env = {
      ...this.env,
      LLM_PROVIDER: provider as Env["LLM_PROVIDER"],
      LLM_MODEL: model,
      OPENAI_BASE_URL: openaiBaseUrl || undefined,
    };

    this._llm = createLLMProvider(effectiveEnv);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${provider} (${model})`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured");
    }
  }

  private refreshLLMProviderIfNeeded(now = Date.now()): void {
    if (this._llm || now - this.lastLLMReinitAttemptAt < this.LLM_REINIT_COOLDOWN_MS) {
      return;
    }

    this.lastLLMReinitAttemptAt = now;
    this.initializeLLM();
  }

  private getDashboardConfig(): AgentConfig {
    const provider = (((this.state.config.llm_provider as string | undefined) === "openai-compatible"
      ? "openai-raw"
      : this.state.config.llm_provider) || "openai-raw") as AgentConfig["llm_provider"];

    return {
      ...this.state.config,
      llm_provider: provider,
      openai_base_url: this.state.config.openai_base_url?.trim() || this.env.OPENAI_BASE_URL || "",
    };
  }

  private getEtDayString(epochMs: number): string {
    if (!this._etDayFormatter) {
      try {
        this._etDayFormatter = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
      } catch {
        this._etDayFormatter = null;
      }
    }

    if (!this._etDayFormatter) {
      return new Date(epochMs).toISOString().slice(0, 10);
    }

    try {
      const parts = this._etDayFormatter.formatToParts(new Date(epochMs));
      const year = parts.find((p) => p.type === "year")?.value;
      const month = parts.find((p) => p.type === "month")?.value;
      const day = parts.find((p) => p.type === "day")?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // fall through
    }
    return new Date(epochMs).toISOString().slice(0, 10);
  }

  get llm(): LLMProvider | null {
    return this._llm;
  }

  // ============================================================================
  // STRATEGY CONTEXT BUILDER
  // ============================================================================

  private buildStrategyContext(): StrategyContext {
    this.refreshLLMProviderIfNeeded();

    const self = this;
    const db = createD1Client(this.env.DB);
    const alpaca = createAlpacaProviders(this.env);
    const policyConfig = getDefaultPolicyConfig(this.env, {
      max_notional_per_trade: Math.max(
        this.state.config.max_position_value,
        this.state.config.crypto_max_position_value ?? 0
      ),
      max_open_positions: this.state.config.max_positions,
      options: {
        options_enabled: this.state.config.options_enabled,
        max_pct_per_option_trade: this.state.config.options_max_pct_per_trade,
        min_dte: this.state.config.options_min_dte,
        max_dte: this.state.config.options_max_dte,
        min_delta: this.state.config.options_min_delta,
        max_delta: this.state.config.options_max_delta,
        min_confidence_for_options: this.state.config.options_min_confidence,
      },
    });

    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db,
      log: (agent, action, details) => self.log(agent, action, details),
      cryptoSymbols: self.state.config.crypto_symbols || [],
      allowedExchanges: self.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
      equityEntryCutoffMinutesBeforeClose: self.state.config.equity_entry_cutoff_minutes_before_close,
      afterHoursExitLimitBufferPct: self.state.config.after_hours_exit_limit_buffer_pct,
      defaultStopLossPct: self.state.config.stop_loss_pct,
      onBuy: async (trade) => {
        await self.sendDiscordTradeNotification("BUY", trade);
      },
      onSell: async (trade) => {
        self.clearTrackedSymbolState(trade.symbol);
        await self.sendDiscordTradeNotification("SELL", trade);
      },
    });

    return {
      env: this.env,
      config: this.state.config,
      llm: this._llm,
      log: (agent, action, details) => self.log(agent, action, details),
      trackLLMCost: (model, tokensIn, tokensOut) => self.trackLLMCost(model, tokensIn, tokensOut),
      sleep: (ms) => self.sleep(ms),
      broker,
      state: {
        get<T>(key: string): T | undefined {
          return (self.state as unknown as Record<string, unknown>)[key] as T | undefined;
        },
        set<T>(key: string, value: T): void {
          (self.state as unknown as Record<string, unknown>)[key] = value;
        },
      },
      signals: this.state.signalCache,
      positionEntries: this.state.positionEntries,
    };
  }

  // ============================================================================
  // ALARM HANDLER — Main 30-second heartbeat
  // ============================================================================

  async alarm(): Promise<void> {
    console.log("[Alarm] Alarm triggered");
    if (!this.state.enabled) {
      this.log("System", "alarm_skipped", { reason: "Agent not enabled" });
      return;
    }

    this.applyStateHygiene();

    const now = Date.now();
    const RESEARCH_INTERVAL_MS = 120_000;
    const POSITION_RESEARCH_INTERVAL_MS = 300_000;
    const premarketPlanWindowMinutes = Math.max(1, this.state.config.premarket_plan_window_minutes ?? 5);
    const marketOpenExecuteWindowMinutes = Math.max(0, this.state.config.market_open_execute_window_minutes ?? 2);

    const ctx = this.buildStrategyContext();

    try {
      const clock = await ctx.broker.getClock();
      const clockNowMs = Number.isFinite(new Date(clock.timestamp).getTime())
        ? new Date(clock.timestamp).getTime()
        : now;
      const etDay = this.getEtDayString(clockNowMs);
      const nextOpenMs = new Date(clock.next_open).getTime();
      const nextOpenValid = Number.isFinite(nextOpenMs);

      if (!clock.is_open && nextOpenValid) {
        this.state.lastKnownNextOpenMs = nextOpenMs;
      }

      // Data gathering
      if (now - this.state.lastDataGatherRun >= this.state.config.data_poll_interval_ms) {
        console.log("[Alarm] Starting data gatherers");
        await this.runDataGatherers(ctx);
        console.log("[Alarm] Data gatherers complete");
      }

      // Signal research
      if (now - this.state.lastResearchRun >= RESEARCH_INTERVAL_MS) {
        console.log("[Alarm] Starting signal research");
        await this.researchTopSignals(ctx, this.state.config.signal_research_limit ?? 5);
        console.log("[Alarm] Signal research complete");
        this.state.lastResearchRun = now;
      }

      // Clear stale premarket plan from a previous day
      if (
        this.state.premarketPlan &&
        this.state.lastPremarketPlanDayEt &&
        this.state.lastPremarketPlanDayEt !== etDay
      ) {
        this.log("System", "clearing_stale_premarket_plan", {
          stale_day: this.state.lastPremarketPlanDayEt,
          current_day: etDay,
        });
        this.state.premarketPlan = null;
        this.state.lastPremarketPlanDayEt = null;
      }

      // Pre-market planning window
      console.log("[Alarm] Checking premarket plan", { isOpen: clock.is_open, hasPlan: !!this.state.premarketPlan });
      if (!clock.is_open && !this.state.premarketPlan) {
        const minutesToOpen = nextOpenValid ? (nextOpenMs - clockNowMs) / 60000 : Number.POSITIVE_INFINITY;
        const shouldPlan =
          minutesToOpen > 0 &&
          minutesToOpen <= premarketPlanWindowMinutes &&
          this.state.lastPremarketPlanDayEt !== etDay;
        console.log("[Alarm] Premarket check", { minutesToOpen, shouldPlan });

        if (shouldPlan) {
          console.log("[Alarm] Running premarket analysis");
          await this.runPreMarketAnalysis(ctx);
          if (this.state.premarketPlan) this.state.lastPremarketPlanDayEt = etDay;
        }
      }

      // Positions snapshot
      console.log("[Alarm] Fetching positions");
      const positions = await ctx.broker.getPositions();
      console.log("[Alarm] Got positions", { count: positions.length });
      await this.syncTrackedPositionEntries(positions);
      if (clock.is_open) {
        await ctx.broker.syncProtectiveStops(positions);
      }

      if (!clock.is_open && isWithinExtendedHoursSession(clock.timestamp)) {
        await this.runExtendedHoursExitSweep(ctx, positions);
      }

      // Crypto trading (24/7)
      if (this.state.config.crypto_enabled) {
        await runCryptoTrading(ctx, positions);
      }

      // Position research
      if (shouldRunPositionResearch(
        positions,
        clock.is_open,
        now,
        this.state.lastPositionResearchRun,
        POSITION_RESEARCH_INTERVAL_MS
      )) {
        const researchCandidates = getPositionResearchCandidates(positions, clock.is_open);
        for (const pos of researchCandidates) {
          await this.callPositionResearch(ctx, pos);
        }
        this.state.lastPositionResearchRun = now;
      }

      // Market-hours logic
      if (clock.is_open) {
        const lastKnownOpenMs = this.state.lastKnownNextOpenMs;
        const hasOpenMs = typeof lastKnownOpenMs === "number" && Number.isFinite(lastKnownOpenMs);
        const openWindowMs = marketOpenExecuteWindowMinutes * 60_000;
        const withinOpenWindow =
          hasOpenMs && clockNowMs >= lastKnownOpenMs && clockNowMs - lastKnownOpenMs <= openWindowMs;
        const clockStateUnknown = this.state.lastClockIsOpen == null;
        const marketJustOpened = this.state.lastClockIsOpen === false && clock.is_open;

        const shouldExecutePremarketPlan =
          !!this.state.premarketPlan &&
          ((hasOpenMs && withinOpenWindow) || marketJustOpened || (!hasOpenMs && clockStateUnknown));
        if (shouldExecutePremarketPlan) {
          await this.executePremarketPlan(ctx);
        }

        // Analyst cycle
        if (now - this.state.lastAnalystRun >= this.state.config.analyst_interval_ms) {
          await this.runAnalyst(ctx);
          this.state.lastAnalystRun = now;
        }

        // Options exits (checked every tick, not just analyst cycle)
        if (this.state.config.options_enabled) {
          for (const pos of positions) {
            if (pos.asset_class !== "us_option") continue;
            const ep = pos.avg_entry_price || pos.current_price;
            const plPct = ep > 0 ? ((pos.current_price - ep) / ep) * 100 : 0;
            if (plPct >= this.state.config.options_take_profit_pct) {
              await ctx.broker.sell(pos.symbol, `Options take profit at +${plPct.toFixed(1)}%`);
            } else if (plPct <= -this.state.config.options_stop_loss_pct) {
              await ctx.broker.sell(pos.symbol, `Options stop loss at ${plPct.toFixed(1)}%`);
            }
          }
        }

        // Twitter breaking news
        if (isTwitterEnabled(ctx)) {
          const heldSymbols = positions.map((p) => p.symbol);
          const breakingNews = await checkTwitterBreakingNews(ctx, heldSymbols);
          for (const news of breakingNews) {
            if (news.is_breaking) {
              this.log("System", "twitter_breaking_news", {
                symbol: news.symbol,
                headline: news.headline.slice(0, 100),
              });
            }
          }
        }
      }

      const account = await ctx.broker.getAccount().catch(() => null);
      await this.maybeSendDailyDiscordReport(account, positions, now);

      this.state.lastClockIsOpen = clock.is_open;
      console.log("[Alarm] Persisting state");
      await this.persist();
      console.log("[Alarm] State persisted");
    } catch (error) {
      this.log("System", "alarm_error", { error: String(error) });
    }

    console.log("[Alarm] Scheduling next alarm");
    await this.scheduleNextAlarm();
    console.log("[Alarm] Next alarm scheduled");
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextRun = Date.now() + 30_000;
    await this.ctx.storage.setAlarm(nextRun);
  }

  // ============================================================================
  // DATA GATHERING — delegates to strategy gatherers
  // ============================================================================

  private async runDataGatherers(ctx: StrategyContext): Promise<void> {
    this.log("System", "gathering_data", {});

    await tickerCache.refreshSecTickersIfNeeded();
    const positions = await ctx.broker.getPositions().catch(() => []);

    const results = await Promise.allSettled(activeStrategy.gatherers.map((g) => g.gather(ctx)));

    const allSignals: Signal[] = [];
    const counts: Record<string, number> = {};
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = activeStrategy.gatherers[i]?.name ?? `gatherer_${i}`;
      if (result?.status === "fulfilled") {
        allSignals.push(...result.value);
        counts[name] = result.value.length;
      } else if (result) {
        counts[name] = 0;
      }
    }

    const MAX_SIGNALS = 200;
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const recentSignals = allSignals.filter((s) => now - s.timestamp < MAX_AGE_MS);
    const eligibleSignals = await this.filterEligibleSignals(ctx, recentSignals);

    const socialSnapshot = buildSocialSnapshot(eligibleSignals);
    updateSocialHistoryFromSnapshot(this.state.socialHistory, socialSnapshot, now);
    this.state.socialSnapshotCache = serializeSocialSnapshot(socialSnapshot);
    this.state.socialSnapshotCacheUpdatedAt = now;

    const freshSignals = eligibleSignals
      .slice()
      .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
      .slice(0, MAX_SIGNALS);

    this.state.signalCache = freshSignals;
    this.state.lastDataGatherRun = now;
    await this.refreshMarketContext(ctx, freshSignals, positions);

    this.log("System", "data_gathered", { ...counts, total: this.state.signalCache.length });
  }

  private async filterEligibleSignals(ctx: StrategyContext, signals: Signal[]): Promise<Signal[]> {
    const alpaca = createAlpacaProviders(this.env);
    const filtered: Signal[] = [];

    for (const signal of signals) {
      const symbol = signal.symbol?.toUpperCase().trim();
      if (!symbol) continue;

      if (isBroadMarketProxyTicker(symbol)) {
        ctx.log("System", "signal_filtered_broad_market_proxy", { symbol });
        continue;
      }

      if (signal.isCrypto || isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
        if (isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
          filtered.push({ ...signal, symbol: normalizeCryptoSymbol(symbol), isCrypto: true });
        } else {
          ctx.log("System", "signal_filtered_unconfigured_crypto", { symbol });
        }
        continue;
      }

      const customBlacklisted = isCustomTickerBlacklisted(symbol, ctx.config.ticker_blacklist);
      const builtInBlacklisted = isBuiltInTickerBlacklisted(symbol);
      const blacklisted = builtInBlacklisted || customBlacklisted;

      if (tickerCache.isKnownSecTicker(symbol)) {
        if (isTickerBlacklisted(symbol, ctx.config.ticker_blacklist) && !shouldRescueBuiltInBlacklistedTicker(symbol, {
          customBlacklist: ctx.config.ticker_blacklist,
          knownSecTicker: true,
        })) {
          ctx.log("System", "signal_filtered_blacklist", { symbol });
          continue;
        }
        if (shouldRescueBuiltInBlacklistedTicker(symbol, {
          customBlacklist: ctx.config.ticker_blacklist,
          knownSecTicker: true,
        })) {
          ctx.log("System", "signal_rescued_builtin_blacklist", { symbol, source: "sec" });
        }
        filtered.push({ ...signal, symbol });
        continue;
      }

      if (blacklisted && customBlacklisted) {
        ctx.log("System", "signal_filtered_blacklist", { symbol });
        continue;
      }

      const cached = tickerCache.getCachedValidation(symbol);
      const isValid = cached ?? (await tickerCache.validateWithAlpaca(symbol, alpaca));
      if (!isValid) {
        if (blacklisted) {
          ctx.log("System", "signal_filtered_blacklist", { symbol });
        } else {
          ctx.log("System", "signal_filtered_invalid_ticker", { symbol });
        }
        continue;
      }

      if (shouldRescueBuiltInBlacklistedTicker(symbol, {
        customBlacklist: ctx.config.ticker_blacklist,
        alpacaValid: true,
      })) {
        ctx.log("System", "signal_rescued_builtin_blacklist", { symbol, source: "alpaca" });
      }

      filtered.push({ ...signal, symbol });
    }

    return filtered;
  }

  private applyStateHygiene(): boolean {
    let changed = false;

    if (this.normalizeLegacyLLMConfig()) {
      changed = true;
    }

    if (this.pruneTransientResearchState()) {
      changed = true;
    }

    if (this.pruneVolatileCaches()) {
      changed = true;
    }

    if (pruneDailyReportBuckets(this.state.dailyReportBuckets, Date.now(), DAILY_REPORT_RETENTION_MS)) {
      changed = true;
    }

    return changed;
  }

  private normalizeLegacyLLMConfig(): boolean {
    let changed = false;
    if ((this.state.config.llm_provider as string | undefined) === "openai-compatible") {
      this.state.config.llm_provider = "openai-raw";
      changed = true;
    }

    const currentModel = (this.state.config.llm_model || this.env.LLM_MODEL || "").trim();
    const analystModel = this.state.config.llm_analyst_model?.trim();
    const hasCompatBaseUrl = !!(this.state.config.openai_base_url?.trim() || this.env.OPENAI_BASE_URL);
    const legacyAnalystModels = new Set(["gpt-4o", "gpt-4o-mini"]);

    if (!currentModel || !analystModel || currentModel === analystModel) {
      return changed;
    }

    if (!hasCompatBaseUrl || !legacyAnalystModels.has(analystModel)) {
      return changed;
    }

    this.state.config.llm_analyst_model = currentModel;
    console.warn(
      `[MahoragaHarness] Synced llm_analyst_model to llm_model for OpenAI base URL override (${currentModel})`
    );
    return true;
  }

  private pruneTransientResearchState(now = Date.now()): boolean {
    let changed = false;

    for (const [symbol, result] of Object.entries(this.state.signalResearch)) {
      const isExpired = !result?.timestamp || now - result.timestamp > this.TRANSIENT_RESEARCH_MAX_AGE_MS;
      const isInvalid =
        !result ||
        !["BUY", "SKIP", "WAIT"].includes(result.verdict) ||
        typeof result.confidence !== "number" ||
        typeof result.reasoning !== "string" ||
        !Array.isArray(result.red_flags) ||
        !Array.isArray(result.catalysts);

      if (isExpired || isInvalid) {
        delete this.state.signalResearch[symbol];
        changed = true;
      }
    }

    for (const [symbol, result] of Object.entries(this.state.positionResearch)) {
      const timestamp = (result as { timestamp?: number } | undefined)?.timestamp;
      if (!timestamp || now - timestamp > this.TRANSIENT_RESEARCH_MAX_AGE_MS) {
        delete this.state.positionResearch[symbol];
        changed = true;
      }
    }

    return changed;
  }

  private getRetainedSymbols(): Set<string> {
    const retained = new Set<string>();
    const rememberSymbol = (symbol?: string | null) => {
      if (!symbol) return;
      for (const alias of this.getTrackedSymbolAliases(symbol)) {
        retained.add(alias);
      }
    };

    this.state.signalCache.forEach((signal) => rememberSymbol(signal.symbol));
    Object.keys(this.state.positionEntries).forEach((symbol) => rememberSymbol(symbol));
    Object.keys(this.state.signalResearch).forEach((symbol) => rememberSymbol(symbol));
    Object.keys(this.state.positionResearch).forEach((symbol) => rememberSymbol(symbol));
    Object.keys(this.state.socialSnapshotCache).forEach((symbol) => rememberSymbol(symbol));
    Object.keys(this.state.socialHistory).forEach((symbol) => rememberSymbol(symbol));

    return retained;
  }

  private pruneVolatileCaches(now = Date.now()): boolean {
    let changed = false;
    const retainedSymbols = this.getRetainedSymbols();
    const dynamicState = this.state as unknown as Record<string, unknown>;
    const technicalCache = dynamicState.technicalDataCache as Record<string, TechnicalDataCacheEntry> | undefined;
    const momentumCache = dynamicState.momentumDataCache as Record<string, MomentumDataCacheEntry> | undefined;
    const atrCache = dynamicState.atrCache as Record<string, number> | undefined;
    const sectorMap = dynamicState.sectorMap as Record<string, string> | undefined;
    const cooldowns = this.getSignalResearchCooldowns();
    const staleCutoff = now - this.VOLATILE_CACHE_MAX_AGE_MS;

    if (technicalCache) {
      for (const [symbol, entry] of Object.entries(technicalCache)) {
        const updatedAt = typeof entry?.updated_at === "number" ? entry.updated_at : 0;
        if (updatedAt < staleCutoff || !retainedSymbols.has(symbol)) {
          delete technicalCache[symbol];
          changed = true;
        }
      }
    }

    if (momentumCache) {
      for (const [symbol, entry] of Object.entries(momentumCache)) {
        const updatedAt = typeof entry?.updated_at === "number" ? entry.updated_at : 0;
        if (updatedAt < staleCutoff || !retainedSymbols.has(symbol)) {
          delete momentumCache[symbol];
          changed = true;
        }
      }
    }

    if (atrCache) {
      for (const symbol of Object.keys(atrCache)) {
        if (!retainedSymbols.has(symbol)) {
          delete atrCache[symbol];
          changed = true;
        }
      }
    }

    if (sectorMap) {
      for (const symbol of Object.keys(sectorMap)) {
        if (!retainedSymbols.has(symbol)) {
          delete sectorMap[symbol];
          changed = true;
        }
      }
    }

    for (const [symbol, cooldown] of Object.entries(cooldowns)) {
      const until = typeof cooldown?.until === "number" ? cooldown.until : 0;
      if (until <= now || !retainedSymbols.has(symbol)) {
        delete cooldowns[symbol];
        changed = true;
      }
    }

    const cooldownEntries = Object.entries(cooldowns);
    if (cooldownEntries.length > this.MAX_SIGNAL_RESEARCH_COOLDOWNS) {
      cooldownEntries
        .sort(([, a], [, b]) => (b.until || 0) - (a.until || 0))
        .slice(this.MAX_SIGNAL_RESEARCH_COOLDOWNS)
        .forEach(([symbol]) => {
          delete cooldowns[symbol];
          changed = true;
        });
    }

    for (const [symbol, confirmation] of Object.entries(this.state.twitterConfirmations)) {
      const timestamp = typeof confirmation?.timestamp === "number" ? confirmation.timestamp : 0;
      if (timestamp < now - this.TWITTER_CONFIRMATION_MAX_AGE_MS || !retainedSymbols.has(symbol)) {
        delete this.state.twitterConfirmations[symbol];
        changed = true;
      }
    }

    const activePositionSymbols = new Set(Object.keys(this.state.positionEntries));
    for (const symbol of Object.keys(this.state.stalenessAnalysis)) {
      if (!activePositionSymbols.has(symbol)) {
        delete this.state.stalenessAnalysis[symbol];
        changed = true;
      }
    }

    return changed;
  }

  private limitTimestampedRecord<T extends { timestamp?: number }>(
    records: Record<string, T>,
    maxEntries: number
  ): Record<string, T> {
    return Object.fromEntries(
      Object.entries(records)
        .sort(([, a], [, b]) => (b?.timestamp || 0) - (a?.timestamp || 0))
        .slice(0, maxEntries)
    );
  }

  private filterRecordBySymbols<T>(records: Record<string, T>, symbols: Set<string>): Record<string, T> {
    return Object.fromEntries(Object.entries(records).filter(([symbol]) => symbols.has(symbol)));
  }

  private getTrackedSymbolAliases(symbol: string): string[] {
    return isCryptoSymbol(symbol, this.state.config.crypto_symbols || []) ? getCryptoSymbolAliases(symbol) : [symbol];
  }

  private findTrackedPositionEntry(symbol: string): PositionEntry | undefined {
    const candidates = this.getTrackedSymbolAliases(symbol)
      .map((alias) => this.state.positionEntries[alias])
      .filter((entry): entry is PositionEntry => !!entry);

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) => {
      const aRecovered = a.entry_reason === "Recovered from broker position" ? 1 : 0;
      const bRecovered = b.entry_reason === "Recovered from broker position" ? 1 : 0;
      if (aRecovered !== bRecovered) {
        return aRecovered - bRecovered;
      }
      return (b.entry_time || 0) - (a.entry_time || 0);
    });

    return candidates[0];
  }

  private getSocialSnapshotEntry(
    snapshot: Record<string, SocialSnapshotCacheEntry>,
    symbol: string
  ): SocialSnapshotCacheEntry | undefined {
    for (const alias of this.getTrackedSymbolAliases(symbol)) {
      const entry = snapshot[alias];
      if (entry) return entry;
    }
    return undefined;
  }

  private clearTrackedSymbolState(symbol: string): void {
    for (const alias of this.getTrackedSymbolAliases(symbol)) {
      delete this.state.positionEntries[alias];
      delete this.state.socialHistory[alias];
      delete this.state.stalenessAnalysis[alias];
    }
  }

  private getSignalResearchCooldowns(): Record<string, { until: number; reason: string }> {
    const dynamicState = this.state as unknown as Record<string, unknown>;
    const existing = dynamicState.signalResearchCooldowns as Record<string, { until: number; reason: string }> | undefined;
    if (existing) return existing;

    const created: Record<string, { until: number; reason: string }> = {};
    dynamicState.signalResearchCooldowns = created;
    return created;
  }

  private setSignalResearchCooldown(symbol: string, reason: string, ttlMs = this.SIGNAL_RESEARCH_FAILURE_COOLDOWN_MS): void {
    const cooldowns = this.getSignalResearchCooldowns();
    cooldowns[symbol] = {
      until: Date.now() + ttlMs,
      reason,
    };
  }

  private parseFilledOrderQuantity(order: Order): number {
    const rawQty = order.filled_qty || order.qty || "0";
    const qty = Number.parseFloat(rawQty);
    return Number.isFinite(qty) ? Math.abs(qty) : 0;
  }

  private shouldRefreshTrackedEntryTime(
    entry: PositionEntry,
    inferredEntry: Pick<PositionEntry, "entry_time"> | null | undefined
  ): boolean {
    if (!inferredEntry?.entry_time || !Number.isFinite(inferredEntry.entry_time)) {
      return false;
    }

    if (!Number.isFinite(entry.entry_time) || entry.entry_time <= 0) {
      return true;
    }

    if (entry.entry_reason === "Recovered from broker position") {
      return true;
    }

    // For explicitly tracked entries created at buy time, trust the in-memory timestamp.
    // Broker order history can lag or refer to an older round-trip, especially for crypto
    // aliases like SOL/USD vs SOLUSD, and overwriting here can trigger false stale exits.
    return false;
  }

  private inferPositionEntryFromOrders(symbol: string, orders: Order[]): Pick<PositionEntry, "entry_time" | "entry_price"> | null {
    const aliases = new Set(this.getTrackedSymbolAliases(symbol).map((alias) => alias.toUpperCase()));
    const relevantOrders = orders
      .filter((order) => aliases.has(order.symbol.toUpperCase()) && !!order.filled_at)
      .sort((a, b) => new Date(a.filled_at || a.submitted_at || a.created_at).getTime() - new Date(b.filled_at || b.submitted_at || b.created_at).getTime());

    if (relevantOrders.length === 0) return null;

    let netQty = 0;
    let currentEntryOrder: Order | null = null;

    for (const order of relevantOrders) {
      const qty = this.parseFilledOrderQuantity(order);
      if (qty <= 0) continue;

      if (order.side === "buy") {
        if (netQty <= 0) {
          currentEntryOrder = order;
        }
        netQty += qty;
      } else {
        netQty -= qty;
        if (netQty <= 0) {
          currentEntryOrder = null;
        }
      }
    }

    // Only infer an entry from closed orders when the historical fill sequence still
    // implies an open lot. If the symbol was fully closed and then reopened recently,
    // the new buy may not be in `closed` orders yet; falling back to the last historical
    // buy would incorrectly age the fresh position and can trigger immediate stale exits.
    if (netQty <= 0 || !currentEntryOrder) {
      return null;
    }

    const entryTimeSource = currentEntryOrder.filled_at || currentEntryOrder.submitted_at || currentEntryOrder.created_at;
    const entryTime = new Date(entryTimeSource).getTime();
    const entryPrice = Number.parseFloat(currentEntryOrder.filled_avg_price || "0");

    return {
      entry_time: Number.isFinite(entryTime) ? entryTime : Date.now(),
      entry_price: Number.isFinite(entryPrice) ? entryPrice : 0,
    };
  }

  private createRecoveredPositionEntry(
    position: Position,
    socialSnapshot: Record<string, SocialSnapshotCacheEntry>,
    inferred?: Pick<PositionEntry, "entry_time" | "entry_price"> | null
  ): PositionEntry {
    const originalSignal = this.state.signalCache.find((signal) => signal.symbol === position.symbol);
    const aggregatedSocial = this.getSocialSnapshotEntry(socialSnapshot, position.symbol);
    const sentiment = aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? 0;

    return {
      symbol: position.symbol,
      entry_time: inferred?.entry_time ?? Date.now(),
      entry_price: inferred?.entry_price && inferred.entry_price > 0 ? inferred.entry_price : position.avg_entry_price || 0,
      entry_sentiment: sentiment,
      entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
      entry_sources: aggregatedSocial ? aggregatedSocial.sources : originalSignal?.subreddits || [originalSignal?.source || "broker-sync"],
      entry_reason: "Recovered from broker position",
      peak_price: position.current_price,
      peak_sentiment: sentiment,
    };
  }

  private isUnknownModelError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return message.includes("unknown model") || message.includes("\"1211\"") || message.includes("code\":\"1211");
  }

  private isRateLimitError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes("429") ||
      message.includes("rate_limit") ||
      message.includes("temporarily overloaded") ||
      message.includes("try again later")
    );
  }

  private async completeWithFallback(
    request: Parameters<LLMProvider["complete"]>[0],
    preferredModel: string,
    fallbackModel: string | undefined,
    logAgent: string
  ) {
    if (!this._llm) {
      throw new Error("LLM provider not initialized");
    }

    try {
      const response = await this._llm.complete({
        ...request,
        model: preferredModel,
      });
      return { response, model: preferredModel };
    } catch (error) {
      const shouldRetryWithFallback =
        !!fallbackModel && fallbackModel !== preferredModel && this.isUnknownModelError(error);

      if (!shouldRetryWithFallback) {
        throw error;
      }

      this.log(logAgent, "model_fallback", {
        preferred_model: preferredModel,
        fallback_model: fallbackModel,
        reason: "unknown_model",
      });

      const response = await this._llm.complete({
        ...request,
        model: fallbackModel,
      });
      return { response, model: fallbackModel };
    }
  }

  private async syncTrackedPositionEntries(positions: Position[], orders?: Order[]): Promise<void> {
    const socialSnapshot = getSocialSnapshotCache(this.state);
    const alpaca = createAlpacaProviders(this.env);
    const filledOrders =
      orders ||
      (await alpaca.trading
        .listOrders({ status: "closed", limit: 200, direction: "desc" })
        .then((items) => items.filter((order) => !!order.filled_at))
        .catch(() => []));

    for (const pos of positions) {
      const inferredEntry = this.inferPositionEntryFromOrders(pos.symbol, filledOrders);
      let entry = this.findTrackedPositionEntry(pos.symbol);

      if (!entry) {
        entry = this.createRecoveredPositionEntry(pos, socialSnapshot, inferredEntry);
        this.state.positionEntries[pos.symbol] = entry;
      }

      if (
        this.shouldRefreshTrackedEntryTime(entry, inferredEntry) &&
        Math.abs(entry.entry_time - (inferredEntry?.entry_time || 0)) > 60_000
      ) {
        entry.entry_time = inferredEntry?.entry_time || entry.entry_time;
      }

      if ((entry.entry_price <= 0 || !Number.isFinite(entry.entry_price)) && inferredEntry?.entry_price && inferredEntry.entry_price > 0) {
        entry.entry_price = inferredEntry.entry_price;
      }

      if ((entry.entry_price <= 0 || !Number.isFinite(entry.entry_price)) && pos.avg_entry_price > 0) {
        entry.entry_price = pos.avg_entry_price;
      }

      if (pos.current_price > entry.peak_price) {
        entry.peak_price = pos.current_price;
      }

      const currentSentiment = this.getSocialSnapshotEntry(socialSnapshot, pos.symbol)?.sentiment;
      if (typeof currentSentiment === "number") {
        entry.peak_sentiment = Math.max(entry.peak_sentiment, currentSentiment);
      }

      // Keep crypto/equity aliases in sync so downstream consumers do not pick up
      // an older recovered entry from one alias and a newer explicit entry from another.
      for (const alias of this.getTrackedSymbolAliases(pos.symbol)) {
        this.state.positionEntries[alias] = entry;
      }
    }
  }

  private selectMarketContextSymbols(signals: Signal[], positions: Position[]): string[] {
    const rankedSignals = signals
      .slice()
      .sort((a, b) => {
        const scoreA = Math.abs(a.sentiment) * (a.volume || 1) * (a.source_weight || 1);
        const scoreB = Math.abs(b.sentiment) * (b.volume || 1) * (b.source_weight || 1);
        return scoreB - scoreA;
      })
      .map((signal) => signal.symbol);

    const symbols: string[] = [];
    const seen = new Set<string>();

    const pushSymbol = (symbol: string) => {
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      symbols.push(symbol);
    };

    for (const pos of positions) {
      if (pos.asset_class === "us_option") continue;
      pushSymbol(pos.symbol);
    }
    for (const symbol of rankedSignals) {
      if (symbols.length >= this.MAX_MARKET_CONTEXT_SYMBOLS) break;
      pushSymbol(symbol);
    }
    pushSymbol("SPY");
    pushSymbol("QQQ");

    return symbols;
  }

  private inferSectorFromAssetName(symbol: string, assetName?: string | null): string {
    const normalized = `${symbol} ${assetName ?? ""}`.toLowerCase();

    const sectorPatterns: Array<{ sector: string; keywords: string[] }> = [
      { sector: "index_etf", keywords: [" etf", " trust", " fund", " index", "spdr", "invesco", "ishares", "vanguard"] },
      { sector: "technology", keywords: ["software", "semiconductor", "cloud", "internet", "systems", "technology", "digital"] },
      { sector: "healthcare", keywords: ["health", "medical", "biotech", "therapeutic", "pharma", "diagnostic"] },
      { sector: "financials", keywords: ["bank", "capital", "financial", "insurance", "payment", "asset management"] },
      { sector: "energy", keywords: ["energy", "oil", "gas", "petroleum", "drilling"] },
      { sector: "industrials", keywords: ["industrial", "aerospace", "defense", "machinery", "airlines", "railroad", "transport"] },
      { sector: "consumer_cyclical", keywords: ["retail", "automotive", "restaurant", "apparel", "hotel", "travel", "leisure"] },
      { sector: "consumer_defensive", keywords: ["food", "beverage", "household", "consumer staples", "tobacco"] },
      { sector: "communication_services", keywords: ["telecom", "media", "entertainment", "streaming", "communications"] },
      { sector: "utilities", keywords: ["utility", "electric", "water"] },
      { sector: "real_estate", keywords: ["reit", "realty", "properties", "real estate"] },
      { sector: "materials", keywords: ["materials", "chemical", "mining", "steel", "copper", "gold", "silver"] },
    ];

    for (const pattern of sectorPatterns) {
      if (pattern.keywords.some((keyword) => normalized.includes(keyword))) {
        return pattern.sector;
      }
    }

    return "unknown";
  }

  private async refreshMarketContext(ctx: StrategyContext, signals: Signal[], positions: Position[]): Promise<void> {
    const symbols = this.selectMarketContextSymbols(signals, positions);
    if (symbols.length === 0) return;

    const now = Date.now();
    const alpaca = createAlpacaProviders(this.env);
    const dynamicState = this.state as unknown as Record<string, unknown>;
    const technicalCache = dynamicState.technicalDataCache as Record<string, TechnicalDataCacheEntry> | undefined;
    const momentumCache = dynamicState.momentumDataCache as Record<string, MomentumDataCacheEntry> | undefined;
    const atrCache = dynamicState.atrCache as Record<string, number> | undefined;
    const sectorMap = dynamicState.sectorMap as Record<string, string> | undefined;

    const nextTechnicalCache = { ...(technicalCache ?? {}) };
    const nextMomentumCache = { ...(momentumCache ?? {}) };
    const nextAtrCache = { ...(atrCache ?? {}) };
    const nextSectorMap = { ...(sectorMap ?? {}) };

    await Promise.allSettled(
      symbols.map(async (symbol) => {
        try {
          const techEntry = nextTechnicalCache[symbol];
          const momentumEntry = nextMomentumCache[symbol];
          const hasRequiredCache = !!techEntry && !!momentumEntry;
          const lastUpdated = Math.min(
            techEntry?.updated_at ?? Number.MAX_SAFE_INTEGER,
            momentumEntry?.updated_at ?? Number.MAX_SAFE_INTEGER
          );
          const isFresh =
            hasRequiredCache &&
            lastUpdated !== Number.MAX_SAFE_INTEGER &&
            now - lastUpdated < this.MARKET_CONTEXT_TTL_MS;

          if (isFresh) return;

          if (isCryptoSymbol(symbol, this.state.config.crypto_symbols || [])) {
            const snapshot = await alpaca.marketData.getCryptoSnapshot(normalizeCryptoSymbol(symbol));
            const currentPrice = snapshot.latest_trade.price || snapshot.latest_quote.ask_price;
            const previousClose = snapshot.prev_daily_bar.c;
            const dailyClose = snapshot.daily_bar.c;

            nextTechnicalCache[symbol] = {
              ...(techEntry ?? {}),
              updated_at: now,
              current_price: currentPrice,
            };
            nextMomentumCache[symbol] = {
              updated_at: now,
              price_change_1h: momentumEntry?.price_change_1h,
              price_change_24h:
                previousClose > 0
                  ? ((dailyClose - previousClose) / previousClose) * 100
                  : momentumEntry?.price_change_24h,
              volume_change: momentumEntry?.volume_change,
            };
            return;
          }

          const [dailyBars, hourlyBars, snapshot] = await Promise.all([
            alpaca.marketData.getBars(symbol, "1Day", { limit: 250 }).catch(() => []),
            alpaca.marketData.getBars(symbol, "1Hour", { limit: 30 }).catch(() => []),
            alpaca.marketData.getSnapshot(symbol).catch(() => null),
          ]);

          if (dailyBars.length === 0 && !snapshot) return;

          if (!nextSectorMap[symbol] || nextSectorMap[symbol] === "unknown") {
            const asset = await alpaca.trading.getAsset(symbol).catch(() => null);
            nextSectorMap[symbol] = this.inferSectorFromAssetName(symbol, asset?.name);
          }

          const technicals = dailyBars.length > 0 ? computeTechnicals(symbol, dailyBars) : null;
          const currentPrice =
            snapshot?.latest_trade?.price ||
            snapshot?.latest_quote?.ask_price ||
            technicals?.price ||
            techEntry?.current_price ||
            0;
          const priceChange24h =
            snapshot?.prev_daily_bar?.c && snapshot.prev_daily_bar.c > 0
              ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100
              : dailyBars.length >= 2
                ? ((dailyBars[dailyBars.length - 1]!.c - dailyBars[dailyBars.length - 2]!.c) /
                    dailyBars[dailyBars.length - 2]!.c) *
                  100
                : momentumEntry?.price_change_24h;
          const priceChange1h =
            hourlyBars.length >= 2 && hourlyBars[hourlyBars.length - 2]!.c > 0
              ? ((hourlyBars[hourlyBars.length - 1]!.c - hourlyBars[hourlyBars.length - 2]!.c) /
                  hourlyBars[hourlyBars.length - 2]!.c) *
                100
              : momentumEntry?.price_change_1h;

          if (technicals) {
            nextTechnicalCache[symbol] = {
              updated_at: now,
              current_price: currentPrice,
              rsi: technicals.rsi_14 ?? undefined,
              bb_lower: technicals.bollinger?.lower,
              bb_middle: technicals.bollinger?.middle,
              sma_20: technicals.sma_20 ?? undefined,
              sma_50: technicals.sma_50 ?? undefined,
              atr: technicals.atr_14 ?? undefined,
              relative_volume: technicals.relative_volume ?? undefined,
            };
            if (technicals.atr_14 !== null) {
              nextAtrCache[symbol] = technicals.atr_14;
            }
          } else {
            nextTechnicalCache[symbol] = {
              ...(techEntry ?? {}),
              updated_at: now,
              current_price: currentPrice,
            };
          }

          nextMomentumCache[symbol] = {
            updated_at: now,
            price_change_1h: priceChange1h,
            price_change_24h: priceChange24h,
            volume_change: technicals?.relative_volume ?? momentumEntry?.volume_change,
          };
        } catch (error) {
          ctx.log("System", "market_context_refresh_failed", {
            symbol,
            error: String(error),
          });
        }
      })
    );

    dynamicState.technicalDataCache = nextTechnicalCache;
    dynamicState.momentumDataCache = nextMomentumCache;
    dynamicState.atrCache = nextAtrCache;
    dynamicState.sectorMap = nextSectorMap;

    const spyTech = nextTechnicalCache.SPY;
    const qqqTech = nextTechnicalCache.QQQ;
    if (spyTech || qqqTech) {
      dynamicState.marketRegimeCache = {
        vix: (dynamicState.marketRegimeCache as Record<string, unknown> | undefined)?.vix as number | undefined,
        spyPrice: spyTech?.current_price,
        spySma20: spyTech?.sma_20,
        spySma50: spyTech?.sma_50,
        qqqPrice: qqqTech?.current_price,
        qqqSma20: qqqTech?.sma_20,
        qqqSma50: qqqTech?.sma_50,
      };
    }

    ctx.log("System", "market_context_refreshed", {
      symbols: symbols.length,
      technicals: Object.keys(nextTechnicalCache).length,
      momentum: Object.keys(nextMomentumCache).length,
      sectors: Object.values(nextSectorMap).filter((sector) => sector !== "unknown").length,
      has_regime: !!spyTech || !!qqqTech,
    });
  }

  private createPositionEntry(
    symbol: string,
    reason: string,
    fallbackSentiment: number,
    socialSnapshot: Record<string, SocialSnapshotCacheEntry>,
    sourceLabel: string
  ): PositionEntry {
    const originalSignal = this.state.signalCache.find((signal) => signal.symbol === symbol);
    const aggregatedSocial = this.getSocialSnapshotEntry(socialSnapshot, symbol);
    const research = this.state.signalResearch[symbol];

    return {
      symbol,
      entry_time: Date.now(),
      entry_price: 0,
      entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? fallbackSentiment,
      entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
      entry_sources: aggregatedSocial ? aggregatedSocial.sources : originalSignal?.subreddits || [originalSignal?.source || sourceLabel],
      entry_reason: reason,
      peak_price: 0,
      peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? fallbackSentiment,
      recommended_entry_zone: research?.recommended_entry_zone,
      recommended_stop_loss_pct: research?.stop_loss_pct,
      recommended_take_profit_pct: research?.take_profit_pct,
    };
  }

  // ============================================================================
  // LLM RESEARCH — uses strategy prompt builders
  // ============================================================================

  private async researchTopSignals(ctx: StrategyContext, limit = 5): Promise<ResearchResult[]> {
    const positions = await ctx.broker.getPositions();
    const heldSymbols = new Set(positions.map((p) => p.symbol));

    const allSignals = this.state.signalCache;
    const notHeld = allSignals.filter((s) => !heldSymbols.has(s.symbol));
    const aboveThreshold = notHeld.filter((s) => s.raw_sentiment >= this.state.config.min_sentiment_score);
    const candidates = aboveThreshold.sort((a, b) => b.sentiment - a.sentiment).slice(0, limit);

    if (candidates.length === 0) {
      // Log sentiment distribution to help diagnose why no candidates passed
      const sampleSignals = allSignals.slice(0, 10).map((s) => ({
        symbol: s.symbol,
        raw_sentiment: s.raw_sentiment?.toFixed(3),
        sentiment: s.sentiment?.toFixed(3),
        source: s.source,
      }));
      this.log("SignalResearch", "no_candidates", {
        total_signals: allSignals.length,
        not_held: notHeld.length,
        above_threshold: aboveThreshold.length,
        min_sentiment: this.state.config.min_sentiment_score,
        sample_signals: sampleSignals,
      });
      return [];
    }

    this.log("SignalResearch", "researching_signals", {
      count: candidates.length,
      candidate_sentiments: candidates.map((c) => ({ symbol: c.symbol, raw_sentiment: c.raw_sentiment?.toFixed(3) })),
    });

    const aggregated = new Map<string, { symbol: string; sentiment: number; sources: string[] }>();
    for (const sig of candidates) {
      if (!aggregated.has(sig.symbol)) {
        aggregated.set(sig.symbol, { symbol: sig.symbol, sentiment: sig.sentiment, sources: [sig.source] });
      } else {
        aggregated.get(sig.symbol)!.sources.push(sig.source);
      }
    }

    const results: ResearchResult[] = [];
    for (const [symbol, data] of aggregated) {
      const analysis = await this.callSignalResearch(ctx, symbol, data.sentiment, data.sources);
      if (analysis) results.push(analysis);
      await this.sleep(500);
    }

    return results;
  }

  private async callSignalResearch(
    ctx: StrategyContext,
    symbol: string,
    sentiment: number,
    sources: string[]
  ): Promise<ResearchResult | null> {
    if (!this._llm || !activeStrategy.prompts.researchSignal) return null;

    const cached = this.state.signalResearch[symbol];
    if (cached && Date.now() - cached.timestamp < this.SIGNAL_RESEARCH_CACHE_TTL_MS) return cached;

    const cooldown = this.getSignalResearchCooldowns()[symbol];
    if (cooldown && cooldown.until > Date.now()) {
      this.log("SignalResearch", "cooldown_skip", {
        symbol,
        retry_in_ms: cooldown.until - Date.now(),
        reason: cooldown.reason,
      });
      return null;
    }

    try {
      const alpaca = createAlpacaProviders(this.env);
      const crypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
      let price = 0;
      if (crypto) {
        const snapshot = await alpaca.marketData.getCryptoSnapshot(normalizeCryptoSymbol(symbol)).catch(() => null);
        price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || 0;
      } else {
        const snapshot = await alpaca.marketData.getSnapshot(symbol).catch(() => null);
        price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || 0;
      }

      const prompt = activeStrategy.prompts.researchSignal(symbol, sentiment, sources, price, ctx);
      const preferredModel = prompt.model || this.state.config.llm_analyst_model || this.state.config.llm_model;
      const fallbackModel = this.state.config.llm_model;
      const { response, model } = await this.completeWithFallback({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 250,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }, preferredModel, fallbackModel, "SignalResearch");

      if (response.usage) {
        this.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      const content = response.content || "{}";
      const analysis = parseLlmJsonObject<{
        verdict: "BUY" | "SKIP" | "WAIT";
        confidence: number;
        entry_quality: "excellent" | "good" | "fair" | "poor";
        reasoning: string;
        red_flags: string[];
        catalysts: string[];
        recommended_entry_zone?: string;
        stop_loss_pct?: number;
        take_profit_pct?: number;
      }>(content);

      const result: ResearchResult = {
        symbol,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        entry_quality: analysis.entry_quality,
        reasoning: analysis.reasoning,
        red_flags: analysis.red_flags || [],
        catalysts: analysis.catalysts || [],
        sentiment,
        timestamp: Date.now(),
        recommended_entry_zone: analysis.recommended_entry_zone,
        stop_loss_pct: analysis.stop_loss_pct,
        take_profit_pct: analysis.take_profit_pct,
      };

      this.state.signalResearch[symbol] = result;
      this.log("SignalResearch", "signal_researched", {
        symbol,
        verdict: result.verdict,
        confidence: result.confidence,
        quality: result.entry_quality,
      });

      return result;
    } catch (error) {
      if (this.isRateLimitError(error) || this.isUnknownModelError(error)) {
        this.setSignalResearchCooldown(symbol, this.isUnknownModelError(error) ? "unknown_model" : "rate_limit");
      }
      this.log("SignalResearch", "error", { symbol, message: String(error) });
      return null;
    }
  }

  private async callPositionResearch(ctx: StrategyContext, position: Position): Promise<void> {
    if (!this._llm || !activeStrategy.prompts.researchPosition) return;

    const plPct = (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100;
    const prompt = activeStrategy.prompts.researchPosition(position.symbol, position, plPct, ctx);

    try {
      const preferredModel = prompt.model || this.state.config.llm_analyst_model || this.state.config.llm_model;
      const fallbackModel = this.state.config.llm_model;
      const { response, model } = await this.completeWithFallback({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 200,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }, preferredModel, fallbackModel, "PositionResearch");

      if (response.usage) {
        this.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      const content = response.content || "{}";
      const analysis = parseLlmJsonObject<{
        recommendation?: "HOLD" | "SELL" | "ADD";
        risk_level?: "low" | "medium" | "high";
        reasoning?: string;
        key_factors?: string[];
        exit_strategy?: string;
      }>(content);
      this.state.positionResearch[position.symbol] = { ...analysis, timestamp: Date.now() };
      this.log("PositionResearch", "position_analyzed", {
        symbol: position.symbol,
        recommendation: analysis.recommendation,
        risk: analysis.risk_level,
        reasoning: analysis.reasoning,
        key_factors: Array.isArray(analysis.key_factors) ? analysis.key_factors : [],
        exit_strategy: analysis.exit_strategy,
      });
    } catch (error) {
      this.log("PositionResearch", "error", { symbol: position.symbol, message: String(error) });
    }
  }

  private async callAnalystLLM(
    ctx: StrategyContext,
    signals: Signal[],
    positions: Position[],
    account: Account
  ): Promise<{
    recommendations: Array<{
      action: "BUY" | "SELL" | "HOLD";
      symbol: string;
      confidence: number;
      reasoning: string;
      suggested_size_pct?: number;
    }>;
    market_summary: string;
    high_conviction: string[];
  }> {
    if (!this._llm || !activeStrategy.prompts.analyzeSignals || signals.length === 0) {
      return { recommendations: [], market_summary: "No signals to analyze", high_conviction: [] };
    }

    const prompt = activeStrategy.prompts.analyzeSignals(signals, positions, account, ctx);

    try {
      const preferredModel = prompt.model || this.state.config.llm_analyst_model || this.state.config.llm_model;
      const fallbackModel = this.state.config.llm_model;
      const { response, model } = await this.completeWithFallback({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 800,
        temperature: 0.4,
        response_format: { type: "json_object" },
      }, preferredModel, fallbackModel, "Analyst");

      if (response.usage) {
        this.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
      }

      const content = response.content || "{}";
      const analysis = parseLlmJsonObject<{
        recommendations: Array<{
          action: "BUY" | "SELL" | "HOLD";
          symbol: string;
          confidence: number;
          reasoning: string;
          suggested_size_pct?: number;
        }>;
        market_summary: string;
        high_conviction_plays?: string[];
      }>(content);

      this.log("Analyst", "analysis_complete", {
        recommendations: analysis.recommendations?.length || 0,
      });

      return {
        recommendations: analysis.recommendations || [],
        market_summary: analysis.market_summary || "",
        high_conviction: analysis.high_conviction_plays || [],
      };
    } catch (error) {
      this.log("Analyst", "error", { message: String(error) });
      return { recommendations: [], market_summary: `Analysis failed: ${error}`, high_conviction: [] };
    }
  }

  // ============================================================================
  // ANALYST & TRADING — uses strategy selectEntries/selectExits + PolicyBroker
  // ============================================================================

  private async runAnalyst(ctx: StrategyContext): Promise<void> {
    const [account, positions, clock] = await Promise.all([
      ctx.broker.getAccount(),
      ctx.broker.getPositions(),
      ctx.broker.getClock(),
    ]);

    if (!account || !clock.is_open) {
      this.log("System", "analyst_skipped", { reason: "Account unavailable or market closed" });
      return;
    }

    await this.syncTrackedPositionEntries(positions);
    const heldSymbols = new Set(positions.map((p) => p.symbol));
    const positionsBySymbol = new Map(positions.map((position) => [position.symbol, position]));
    const socialSnapshot = getSocialSnapshotCache(this.state);

    // Strategy exit decisions
    const exits = activeStrategy.selectExits(ctx, positions, account);
    for (const exit of exits) {
      const result = await ctx.broker.sell(exit.symbol, exit.reason);
      if (result) heldSymbols.delete(exit.symbol);
    }

    let currentOpenPositions = heldSymbols.size;

    if (currentOpenPositions >= this.state.config.max_positions) {
      this.log("Analyst", "skipped_max_positions", {
        positions: currentOpenPositions,
        max: this.state.config.max_positions,
      });
      return;
    }

    if (this.state.signalCache.length === 0) {
      this.log("Analyst", "skipped_no_signals", { signal_cache_size: 0 });
      return;
    }

    // Strategy entry decisions from cached research
    const research = Object.values(this.state.signalResearch);
    if (research.length === 0) {
      this.log("Analyst", "skipped_no_research", {
        signal_cache_size: this.state.signalCache.length,
        last_research_run: this.state.lastResearchRun,
        research_interval_ms: 120_000,
      });
    }
    const entries = activeStrategy.selectEntries(ctx, research, positions, account);

    for (const entry of entries) {
      if (heldSymbols.has(entry.symbol)) continue;
      if (currentOpenPositions >= this.state.config.max_positions) break;

      let finalConfidence = entry.confidence;

      // Twitter confirmation
      if (isTwitterEnabled(ctx)) {
        const originalSignal = this.state.signalCache.find((s) => s.symbol === entry.symbol);
        if (originalSignal) {
          const twitterConfirm = await gatherTwitterConfirmation(ctx, entry.symbol, originalSignal.sentiment);
          if (twitterConfirm) {
            this.state.twitterConfirmations[entry.symbol] = twitterConfirm;
            if (twitterConfirm.confirms_existing) {
              finalConfidence = Math.min(1.0, finalConfidence * 1.15);
              this.log("System", "twitter_boost", { symbol: entry.symbol, new_confidence: finalConfidence });
            } else if (twitterConfirm.sentiment !== 0) {
              finalConfidence *= 0.85;
            }
          }
        }
      }

      if (finalConfidence < this.state.config.min_analyst_confidence) continue;

      // Options routing
      if (entry.useOptions) {
        const contract = await findBestOptionsContract(ctx, entry.symbol, "bullish", account.equity);
        if (contract) {
          const optionsReason = `${entry.reason} (options on ${entry.symbol})`;
          const result = await ctx.broker.buyOption(contract.symbol, Math.min(1, contract.max_contracts), optionsReason);
          if (result) {
            heldSymbols.add(contract.symbol);
            currentOpenPositions = heldSymbols.size;
            this.state.positionEntries[contract.symbol] = this.createPositionEntry(
              contract.symbol,
              optionsReason,
              finalConfidence,
              socialSnapshot,
              "research_options"
            );
          }
        } else {
          this.log("Options", "contract_selection_failed", { symbol: entry.symbol });
        }
        continue;
      }

      // Execute buy via policy broker
      const result = await ctx.broker.buy(entry.symbol, entry.notional, entry.reason);
      if (result) {
        heldSymbols.add(entry.symbol);
        currentOpenPositions = heldSymbols.size;
        this.state.positionEntries[entry.symbol] = this.createPositionEntry(
          entry.symbol,
          entry.reason,
          finalConfidence,
          socialSnapshot,
          "research"
        );
      }
    }

    // LLM analyst for additional recommendations
    const analysis = await this.callAnalystLLM(ctx, this.state.signalCache, positions, account);
    const entrySymbols = new Set(entries.map((e) => e.symbol));

    this.log("Analyst", "llm_recommendations", {
      total: analysis.recommendations.length,
      buys: analysis.recommendations.filter((r) => r.action === "BUY").length,
      sells: analysis.recommendations.filter((r) => r.action === "SELL").length,
      holds: analysis.recommendations.filter((r) => r.action === "HOLD").length,
      min_confidence: this.state.config.min_analyst_confidence,
    });

    for (const rec of analysis.recommendations) {
      if (rec.confidence < this.state.config.min_analyst_confidence) {
        this.log("Analyst", "llm_rec_filtered_confidence", {
          action: rec.action,
          symbol: rec.symbol,
          confidence: rec.confidence,
        });
        continue;
      }

      if (rec.action === "SELL" && heldSymbols.has(rec.symbol)) {
        const posEntry = this.findTrackedPositionEntry(rec.symbol);
        const holdMinutes = posEntry ? (Date.now() - posEntry.entry_time) / (1000 * 60) : 0;
        const minHold = this.state.config.llm_min_hold_minutes ?? 30;
        const position = positionsBySymbol.get(rec.symbol);
        const pnlPct =
          position && position.market_value - position.unrealized_pl > 0
            ? (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100
            : null;
        const bypassMinHold = shouldBypassLlmMinHold({
          holdMinutes,
          minHoldMinutes: minHold,
          pnlPct,
          confidence: rec.confidence,
          forceSellPnlPct: this.state.config.llm_force_sell_pnl_pct,
          forceSellMinConfidence: this.state.config.llm_force_sell_min_confidence,
        });

        if (holdMinutes < minHold && !bypassMinHold) {
          this.log("Analyst", "llm_sell_blocked", {
            symbol: rec.symbol,
            holdMinutes: Math.round(holdMinutes),
            minRequired: minHold,
            reason: "Position held less than minimum hold time",
          });
          continue;
        }

        if (holdMinutes < minHold && bypassMinHold) {
          this.log("Analyst", "llm_sell_override_min_hold", {
            symbol: rec.symbol,
            holdMinutes: Math.round(holdMinutes),
            minRequired: minHold,
            pnlPct: pnlPct?.toFixed(1) ?? "n/a",
            confidence: rec.confidence,
          });
        }

        const result = await ctx.broker.sell(rec.symbol, `LLM recommendation: ${rec.reasoning}`);
        if (result) {
          heldSymbols.delete(rec.symbol);
          this.log("Analyst", "llm_sell_executed", {
            symbol: rec.symbol,
            confidence: rec.confidence,
            reasoning: rec.reasoning,
          });
        }
        continue;
      }

      if (rec.action === "BUY") {
        if (currentOpenPositions >= this.state.config.max_positions) {
          this.log("Analyst", "llm_buy_blocked_max_positions", {
            symbol: rec.symbol,
            positions: currentOpenPositions,
            max: this.state.config.max_positions,
          });
          continue;
        }
        if (heldSymbols.has(rec.symbol)) {
          this.log("Analyst", "llm_buy_blocked_held", { symbol: rec.symbol });
          continue;
        }
        if (entrySymbols.has(rec.symbol)) {
          this.log("Analyst", "llm_buy_blocked_already_selected", { symbol: rec.symbol });
          continue;
        }

        const notional = computeAnalystRecommendationNotional({
          cash: account.cash,
          basePositionSizePct: this.state.config.position_size_pct_of_cash,
          confidence: rec.confidence,
          maxPositionValue: this.state.config.max_position_value,
          suggestedSizePct: rec.suggested_size_pct,
          convictionScalingEnabled: this.state.config.llm_size_conviction_scaling,
          lowConfidenceMultiplier: this.state.config.llm_size_low_confidence_multiplier,
          mediumConfidenceMultiplier: this.state.config.llm_size_medium_confidence_multiplier,
        });
        if (notional < 100) {
          this.log("Analyst", "llm_buy_blocked_small_notional", { symbol: rec.symbol, notional, min_notional: 100 });
          continue;
        }

        this.log("Analyst", "llm_buy_sized", {
          symbol: rec.symbol,
          confidence: rec.confidence,
          suggested_size_pct: rec.suggested_size_pct,
          notional: Number(notional.toFixed(2)),
        });

        const result = await ctx.broker.buy(rec.symbol, notional, rec.reasoning);
        if (result) {
          heldSymbols.add(rec.symbol);
          currentOpenPositions = heldSymbols.size;
          this.state.positionEntries[rec.symbol] = this.createPositionEntry(
            rec.symbol,
            rec.reasoning,
            rec.confidence,
            socialSnapshot,
            "analyst"
          );
        }
      }
    }
  }

  // ============================================================================
  // PRE-MARKET ANALYSIS — uses strategy prompts
  // ============================================================================

  private async runPreMarketAnalysis(ctx: StrategyContext): Promise<void> {
    const [account, positions] = await Promise.all([ctx.broker.getAccount(), ctx.broker.getPositions()]);

    if (!account || this.state.signalCache.length === 0) return;

    this.log("System", "premarket_analysis_starting", {
      signals: this.state.signalCache.length,
      researched: Object.keys(this.state.signalResearch).length,
    });

    const signalResearch = await this.researchTopSignals(ctx, 10);
    const analysis = await this.callAnalystLLM(ctx, this.state.signalCache, positions, account);

    this.state.premarketPlan = {
      timestamp: Date.now(),
      recommendations: analysis.recommendations.map((r) => ({
        action: r.action,
        symbol: r.symbol,
        confidence: r.confidence,
        reasoning: r.reasoning,
        suggested_size_pct: r.suggested_size_pct,
      })),
      market_summary: analysis.market_summary,
      high_conviction: analysis.high_conviction,
      researched_buys: signalResearch.filter((r) => r.verdict === "BUY"),
    };

    const buyRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "BUY").length;
    const sellRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "SELL").length;

    this.log("System", "premarket_analysis_complete", {
      buy_recommendations: buyRecs,
      sell_recommendations: sellRecs,
      high_conviction: this.state.premarketPlan.high_conviction,
    });
  }

  private async executePremarketPlan(ctx: StrategyContext): Promise<void> {
    const PLAN_STALE_MS = 600_000;

    if (!this.state.premarketPlan) {
      this.log("System", "no_premarket_plan", { reason: "Plan missing" });
      return;
    }
    if (Date.now() - this.state.premarketPlan.timestamp > PLAN_STALE_MS) {
      this.log("System", "no_premarket_plan", { reason: "Plan stale" });
      this.state.premarketPlan = null;
      return;
    }

    const [account, positions] = await Promise.all([ctx.broker.getAccount(), ctx.broker.getPositions()]);
    if (!account) return;

    const heldSymbols = new Set(positions.map((p) => p.symbol));
    const socialSnapshot = getSocialSnapshotCache(this.state);

    this.log("System", "executing_premarket_plan", {
      recommendations: this.state.premarketPlan.recommendations.length,
    });

    // Sells first
    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "SELL" && rec.confidence >= this.state.config.min_analyst_confidence) {
        await ctx.broker.sell(rec.symbol, `Pre-market plan: ${rec.reasoning}`);
      }
    }

    // Then buys
    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "BUY" && rec.confidence >= this.state.config.min_analyst_confidence) {
        if (heldSymbols.has(rec.symbol)) continue;
        if (positions.length >= this.state.config.max_positions) break;

        const notional = computeAnalystRecommendationNotional({
          cash: account.cash,
          basePositionSizePct: this.state.config.position_size_pct_of_cash,
          confidence: rec.confidence,
          maxPositionValue: this.state.config.max_position_value,
          suggestedSizePct: rec.suggested_size_pct,
          convictionScalingEnabled: this.state.config.llm_size_conviction_scaling,
          lowConfidenceMultiplier: this.state.config.llm_size_low_confidence_multiplier,
          mediumConfidenceMultiplier: this.state.config.llm_size_medium_confidence_multiplier,
        });
        if (notional < 100) continue;

        const result = await ctx.broker.buy(rec.symbol, notional, `Pre-market plan: ${rec.reasoning}`);
        if (result) {
          heldSymbols.add(rec.symbol);
          this.state.positionEntries[rec.symbol] = this.createPositionEntry(
            rec.symbol,
            rec.reasoning,
            rec.confidence,
            socialSnapshot,
            "premarket"
          );
        }
      }
    }

    this.state.premarketPlan = null;
  }

  // ============================================================================
  // HTTP HANDLER
  // ============================================================================

  private isAuthorized(request: Request): boolean {
    if (!this.env.MAHORAGA_API_TOKEN) {
      console.warn("[MahoragaHarness] MAHORAGA_API_TOKEN not set - denying request");
    }
    return bearerTokenMatches(request, this.env.MAHORAGA_API_TOKEN);
  }

  private isKillSwitchAuthorized(request: Request): boolean {
    return bearerTokenMatches(request, this.env.KILL_SWITCH_SECRET);
  }

  private unauthorizedResponse(): Response {
    return jsonAuthResponse("Unauthorized. Requires: Authorization: Bearer <MAHORAGA_API_TOKEN>", 401);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    const protectedActions = [
      "enable",
      "disable",
      "config",
      "trigger",
      "status",
      "logs",
      "costs",
      "signals",
      "history",
      "position-history",
      "setup/status",
    ];
    if (protectedActions.includes(action)) {
      if (!this.isAuthorized(request)) return this.unauthorizedResponse();
    }

    try {
      switch (action) {
        case "status":
          return this.handleStatus();
        case "setup/status":
          return this.jsonResponse({ ok: true, data: { configured: true } });
        case "config":
          if (request.method === "POST") return this.handleUpdateConfig(request);
          return this.jsonResponse({ ok: true, data: this.state.config });
        case "enable":
          return this.handleEnable();
        case "disable":
          return this.handleDisable();
        case "logs":
          return this.handleGetLogs(url);
        case "costs":
          return this.jsonResponse({ costs: this.state.costTracker });
        case "signals":
          return this.jsonResponse({ signals: this.state.signalCache });
        case "history":
          return this.handleGetHistory(url);
        case "position-history":
          return this.handleGetPositionHistory(url);
        case "trigger":
          await this.alarm();
          return this.jsonResponse({ ok: true, message: "Alarm triggered" });
        case "kill":
          if (!this.isKillSwitchAuthorized(request)) {
            return jsonAuthResponse("Forbidden. Requires: Authorization: Bearer <KILL_SWITCH_SECRET>", 403);
          }
          return this.handleKillSwitch();
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleStatus(): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);

    let account: Account | null = null;
    let positions: Position[] = [];
    let clock: MarketClock | null = null;

    try {
      [account, positions, clock] = await Promise.all([
        alpaca.trading.getAccount(),
        alpaca.trading.getPositions(),
        alpaca.trading.getClock(),
      ]);
      await this.syncTrackedPositionEntries(positions || []);
      this.applyStateHygiene();
    } catch (_e) {
      // Ignore - will return null
    }

    const activePositionSymbols = new Set((positions || []).map((position) => position.symbol));
    const recentSignalResearch = this.limitTimestampedRecord(
      this.state.signalResearch,
      this.MAX_STATUS_SIGNAL_RESEARCH_ENTRIES
    );
    const recentTwitterConfirmations = this.limitTimestampedRecord(
      this.state.twitterConfirmations,
      this.MAX_STATUS_TWITTER_CONFIRMATIONS
    );

    return this.jsonResponse({
      ok: true,
      data: {
        enabled: this.state.enabled,
        strategy: activeStrategy.name,
        account,
        positions,
        clock,
        config: this.getDashboardConfig(),
        signals: this.state.signalCache,
        logs: this.state.logs.slice(-100),
        costs: this.state.costTracker,
        lastAnalystRun: this.state.lastAnalystRun,
        lastResearchRun: this.state.lastResearchRun,
        lastPositionResearchRun: this.state.lastPositionResearchRun,
        signalResearch: recentSignalResearch,
        positionResearch: this.state.positionResearch,
        positionEntries: this.filterRecordBySymbols(this.state.positionEntries, activePositionSymbols),
        twitterConfirmations: recentTwitterConfirmations,
        premarketPlan: this.state.premarketPlan,
        stalenessAnalysis: this.filterRecordBySymbols(this.state.stalenessAnalysis, activePositionSymbols),
      },
    });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<AgentConfig>;
    const normalizedBody = {
      ...body,
      llm_provider:
        (body.llm_provider as string | undefined) === "openai-compatible" ? "openai-raw" : body.llm_provider,
      openai_base_url: typeof body.openai_base_url === "string" ? body.openai_base_url.trim() : body.openai_base_url,
      discord_daily_report_time:
        typeof body.discord_daily_report_time === "string"
          ? body.discord_daily_report_time.trim()
          : body.discord_daily_report_time,
      discord_daily_report_timezone:
        typeof body.discord_daily_report_timezone === "string"
          ? body.discord_daily_report_timezone.trim()
          : body.discord_daily_report_timezone,
    };
    const merged = { ...this.state.config, ...normalizedBody };
    const updatedLlmModel = typeof body.llm_model === "string" ? body.llm_model.trim() : null;
    const analystModelExplicitlySet = Object.prototype.hasOwnProperty.call(body, "llm_analyst_model");
    const shouldSyncAnalystModel =
      !!updatedLlmModel &&
      !analystModelExplicitlySet &&
      (this.state.config.llm_analyst_model === this.state.config.llm_model ||
        (!!(merged.openai_base_url?.trim() || this.env.OPENAI_BASE_URL) &&
          ["gpt-4o", "gpt-4o-mini"].includes(this.state.config.llm_analyst_model)));

    if (shouldSyncAnalystModel) {
      merged.llm_analyst_model = updatedLlmModel;
    }

    const validation = safeValidateAgentConfig(merged);
    if (!validation.success) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid configuration", issues: validation.error.issues }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.state.config = validation.data;
    this.initializeLLM();
    await this.persist();
    return this.jsonResponse({ ok: true, config: this.getDashboardConfig() });
  }

  private async handleEnable(): Promise<Response> {
    this.state.enabled = true;
    await this.persist();
    await this.scheduleNextAlarm();
    this.log("System", "agent_enabled", {});
    return this.jsonResponse({ ok: true, enabled: true });
  }

  private async handleDisable(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.log("System", "agent_disabled", {});
    return this.jsonResponse({ ok: true, enabled: false });
  }

  private handleGetLogs(url: URL): Response {
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const logs = this.state.logs.slice(-limit);
    return this.jsonResponse({ logs });
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);
    const period = url.searchParams.get("period") || "1M";
    const requestedTimeframe = url.searchParams.get("timeframe") || "1D";
    const timeframe = normalizePortfolioHistoryTimeframe(period, requestedTimeframe);
    const intradayReporting = url.searchParams.get("intraday_reporting") as
      | "market_hours"
      | "extended_hours"
      | "continuous"
      | null;

    try {
      const history = await alpaca.trading.getPortfolioHistory({
        period,
        timeframe,
        intraday_reporting: intradayReporting || "extended_hours",
      });

      const snapshots = history.timestamp.map((ts, i) => ({
        timestamp: ts * 1000,
        equity: history.equity[i],
        pl: history.profit_loss[i],
        pl_pct: history.profit_loss_pct[i],
      }));

      return this.jsonResponse({
        ok: true,
        data: { snapshots, base_value: history.base_value, timeframe: history.timeframe },
      });
    } catch (error) {
      this.log("System", "history_error", { error: String(error) });
      return new Response(JSON.stringify({ ok: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async runExtendedHoursExitSweep(ctx: StrategyContext, positions: Position[]): Promise<void> {
    const equityPositions = positions.filter((position) => position.asset_class === "us_equity");
    if (equityPositions.length === 0) {
      return;
    }

    const account = await ctx.broker.getAccount().catch(() => null);
    if (!account) {
      this.log("System", "after_hours_exit_sweep_skipped", { reason: "Account unavailable" });
      return;
    }

    const exits = activeStrategy.selectExits(ctx, positions, account);
    if (exits.length === 0) {
      return;
    }

    this.log("System", "after_hours_exit_sweep", { exits: exits.length });
    for (const exit of exits) {
      await ctx.broker.sell(exit.symbol, `After-hours sweep: ${exit.reason}`);
    }
  }

  private async fetchPositionHistoryBars(
    alpaca: ReturnType<typeof createAlpacaProviders>,
    symbol: string,
    isCrypto: boolean,
    period: string,
    preferredTimeframe: string,
    startMs: number,
    endMs: number
  ) {
    let bestBars: Awaited<ReturnType<typeof alpaca.marketData.getBars>> = [];
    let bestSpanMs = 0;
    const desiredSpanMs = Math.max(0, endMs - startMs);

    for (const timeframe of getPositionHistoryTimeframeCandidates(period, preferredTimeframe)) {
      const baseParams = {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        limit: getPositionHistoryLimit(period, timeframe),
      };
      const requestVariants = isCrypto
        ? [baseParams]
        : [
            { ...baseParams, feed: "iex" as const },
            baseParams,
          ];

      let bars: Awaited<ReturnType<typeof alpaca.marketData.getBars>> = [];
      for (const params of requestVariants) {
        const requestBars = isCrypto ? alpaca.marketData.getCryptoBars.bind(alpaca.marketData) : alpaca.marketData.getBars.bind(alpaca.marketData);
        bars = await requestBars(symbol, timeframe, params).catch(() => []);
        if (bars.length > 0) break;
      }

      const firstBar = bars[0];
      const lastBar = bars.at(-1);
      const firstBarMs = firstBar?.t ? new Date(firstBar.t).getTime() : NaN;
      const lastBarMs = lastBar?.t ? new Date(lastBar.t).getTime() : NaN;
      const coveredSpanMs =
        Number.isFinite(firstBarMs) && Number.isFinite(lastBarMs) ? Math.max(0, lastBarMs - firstBarMs) : 0;
      const timeframeMs = getPositionHistoryTimeframeMs(timeframe);
      const expectedSpanMs = Math.max(0, getPositionHistoryLimit(period, timeframe) - 1) * timeframeMs;
      const hasFullCoverage =
        bars.length > 1 &&
        Number.isFinite(firstBarMs) &&
        Number.isFinite(lastBarMs) &&
        firstBarMs <= startMs + timeframeMs &&
        (lastBarMs >= endMs - timeframeMs || expectedSpanMs >= desiredSpanMs);

      if (coveredSpanMs > bestSpanMs || (coveredSpanMs === bestSpanMs && bars.length > bestBars.length)) {
        bestBars = bars;
        bestSpanMs = coveredSpanMs;
      }

      if (hasFullCoverage) {
        return bars;
      }
    }

    return bestBars;
  }

  private buildClosedTimelineCandidates(
    orders: Order[],
    openSymbols: Set<string>,
    periodStartMs: number
  ): Array<{
    symbol: string;
    asset_class: string;
    side: "long" | "short";
    entry_time: number;
    exit_time: number;
    entry_price: number;
    exit_price: number;
  }> {
    const groupedOrders = new Map<string, Order[]>();

    for (const order of orders) {
      if (!order.symbol || !order.filled_at || openSymbols.has(order.symbol)) continue;
      const existing = groupedOrders.get(order.symbol) ?? [];
      existing.push(order);
      groupedOrders.set(order.symbol, existing);
    }

    const candidates: Array<{
      symbol: string;
      asset_class: string;
      side: "long" | "short";
      entry_time: number;
      exit_time: number;
      entry_price: number;
      exit_price: number;
    }> = [];

    for (const [symbol, symbolOrders] of groupedOrders.entries()) {
      const sortedOrders = symbolOrders
        .filter((order) => !!order.filled_at && this.parseFilledOrderQuantity(order) > 0)
        .sort((a, b) => new Date(a.filled_at || 0).getTime() - new Date(b.filled_at || 0).getTime());

      let openQty = 0;
      let entryTime = 0;
      let entryCost = 0;
      let entryAssetClass = sortedOrders[0]?.asset_class || "us_equity";
      let entrySide: "long" | "short" = "long";

      for (const order of sortedOrders) {
        const qty = this.parseFilledOrderQuantity(order);
        const filledAt = new Date(order.filled_at || 0).getTime();
        const filledPrice = Number.parseFloat(order.filled_avg_price || "0");
        if (!qty || !Number.isFinite(filledAt) || !Number.isFinite(filledPrice) || filledPrice <= 0) continue;

        if (order.side === "buy") {
          if (openQty <= 0) {
            entryTime = filledAt;
            entryCost = qty * filledPrice;
            openQty = qty;
            entryAssetClass = order.asset_class || entryAssetClass;
            entrySide = "long";
          } else {
            entryCost += qty * filledPrice;
            openQty += qty;
          }
          continue;
        }

        if (openQty <= 0) continue;

        openQty -= qty;
        if (openQty <= 0 && entryTime > 0) {
          const entryPrice = entryCost > 0 ? entryCost / Math.max(qty + openQty, 0.000001) : filledPrice;
          if (filledAt >= periodStartMs || entryTime >= periodStartMs) {
            candidates.push({
              symbol,
              asset_class: entryAssetClass,
              side: entrySide,
              entry_time: entryTime,
              exit_time: filledAt,
              entry_price: entryPrice,
              exit_price: filledPrice,
            });
          }
          entryTime = 0;
          entryCost = 0;
          openQty = 0;
        }
      }
    }

    return candidates.sort((a, b) => b.exit_time - a.exit_time);
  }

  private async handleGetPositionHistory(url: URL): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);
    const period = url.searchParams.get("period") || "7D";
    const timeframe = url.searchParams.get("timeframe") || "1Hour";
    const nowMs = Date.now();

    try {
      const [positions, orders] = await Promise.all([
        alpaca.trading.getPositions(),
        alpaca.trading.listOrders({ status: "closed", limit: 200, direction: "desc" }).catch(() => []),
      ]);

      await this.syncTrackedPositionEntries(positions, orders);

      const periodStartMs = getPeriodStartMs(period, nowMs);
      const openSymbols = new Set(positions.map((position) => position.symbol));
      const closedCandidates = this.buildClosedTimelineCandidates(orders, openSymbols, periodStartMs);

      const openHistories = await Promise.all(
        positions.map(async (position) => {
          const entry = this.findTrackedPositionEntry(position.symbol);
          if (!entry) return null;

          const entryTime = entry.entry_time || periodStartMs;
          const startMs = entryTime;
          const endMs = nowMs;
          const isCryptoPosition = position.asset_class === "crypto" || isCryptoSymbol(position.symbol, this.state.config.crypto_symbols || []);
          const historySymbol = isCryptoPosition ? normalizeCryptoSymbol(position.symbol) : position.symbol;
          const bars = await this.fetchPositionHistoryBars(alpaca, historySymbol, isCryptoPosition, period, timeframe, startMs, endMs);

          const entryPrice = entry.entry_price > 0 ? entry.entry_price : position.avg_entry_price;
          if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

          const points = bars
            .map((bar) => {
              const timestamp = new Date(bar.t).getTime();
              if (!Number.isFinite(timestamp)) return null;

              const changePct =
                position.side === "short"
                  ? ((entryPrice - bar.c) / entryPrice) * 100
                  : ((bar.c - entryPrice) / entryPrice) * 100;

              return {
                timestamp,
                price: bar.c,
                change_pct: Number.isFinite(changePct) ? changePct : 0,
              };
            })
            .filter((point): point is { timestamp: number; price: number; change_pct: number } => point !== null);

          const firstPoint = points[0];
          if (!firstPoint || firstPoint.timestamp > entryTime) {
            points.unshift({
              timestamp: entryTime,
              price: entryPrice,
              change_pct: 0,
            });
          } else if (points.length > 0) {
            points[0] = {
              price: points[0]!.price,
              timestamp: entryTime,
              change_pct: 0,
            };
          }

          const latestPrice = position.current_price > 0 ? position.current_price : points[points.length - 1]?.price;
          if (latestPrice && points.length > 0) {
            const latestChange =
              position.side === "short"
                ? ((entryPrice - latestPrice) / entryPrice) * 100
                : ((latestPrice - entryPrice) / entryPrice) * 100;

            const lastPoint = points[points.length - 1];
            if (!lastPoint || Math.abs(lastPoint.timestamp - nowMs) > 60_000) {
              points.push({
                timestamp: nowMs,
                price: latestPrice,
                change_pct: Number.isFinite(latestChange) ? latestChange : 0,
              });
            } else {
              lastPoint.price = latestPrice;
              lastPoint.change_pct = Number.isFinite(latestChange) ? latestChange : lastPoint.change_pct;
            }
          }

          const dedupedPoints = points
            .sort((a, b) => a.timestamp - b.timestamp)
            .filter((point, index, items) => index === 0 || items[index - 1]!.timestamp !== point.timestamp);

          return {
            symbol: position.symbol,
            entry_time: entry.entry_time,
            entry_price: entryPrice,
            current_price: latestPrice || entryPrice,
            status: "OPEN",
            points: dedupedPoints,
          };
        })
      );

      const closedHistories = await Promise.all(
        closedCandidates.map(async (candidate) => {
          const startMs = candidate.entry_time;
          const endMs = candidate.exit_time;
          const isCryptoPosition =
            candidate.asset_class === "crypto" ||
            isCryptoSymbol(candidate.symbol, this.state.config.crypto_symbols || []);
          const historySymbol = isCryptoPosition ? normalizeCryptoSymbol(candidate.symbol) : candidate.symbol;
          const bars = await this.fetchPositionHistoryBars(alpaca, historySymbol, isCryptoPosition, period, timeframe, startMs, endMs);
          const entryPrice = candidate.entry_price;

          if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

          const points = bars
            .map((bar) => {
              const timestamp = new Date(bar.t).getTime();
              if (!Number.isFinite(timestamp)) return null;

              const changePct =
                candidate.side === "short"
                  ? ((entryPrice - bar.c) / entryPrice) * 100
                  : ((bar.c - entryPrice) / entryPrice) * 100;

              return {
                timestamp,
                price: bar.c,
                change_pct: Number.isFinite(changePct) ? changePct : 0,
              };
            })
            .filter((point): point is { timestamp: number; price: number; change_pct: number } => point !== null);

          const firstPoint = points[0];
          if (!firstPoint || firstPoint.timestamp > candidate.entry_time) {
            points.unshift({
              timestamp: candidate.entry_time,
              price: entryPrice,
              change_pct: 0,
            });
          } else if (points.length > 0) {
            points[0] = {
              price: points[0]!.price,
              timestamp: candidate.entry_time,
              change_pct: 0,
            };
          }

          const exitPrice = candidate.exit_price > 0 ? candidate.exit_price : points[points.length - 1]?.price;
          if (exitPrice && points.length > 0) {
            const exitChange =
              candidate.side === "short"
                ? ((entryPrice - exitPrice) / entryPrice) * 100
                : ((exitPrice - entryPrice) / entryPrice) * 100;

            const lastPoint = points[points.length - 1];
            if (!lastPoint || Math.abs(lastPoint.timestamp - candidate.exit_time) > 60_000) {
              points.push({
                timestamp: candidate.exit_time,
                price: exitPrice,
                change_pct: Number.isFinite(exitChange) ? exitChange : 0,
              });
            } else {
              lastPoint.timestamp = candidate.exit_time;
              lastPoint.price = exitPrice;
              lastPoint.change_pct = Number.isFinite(exitChange) ? exitChange : lastPoint.change_pct;
            }
          }

          const dedupedPoints = points
            .sort((a, b) => a.timestamp - b.timestamp)
            .filter((point, index, items) => index === 0 || items[index - 1]!.timestamp !== point.timestamp);

          return {
            symbol: candidate.symbol,
            entry_time: candidate.entry_time,
            entry_price: entryPrice,
            current_price: exitPrice || entryPrice,
            exit_time: candidate.exit_time,
            exit_price: exitPrice || entryPrice,
            status: "SOLD",
            points: dedupedPoints,
          };
        })
      );

      const data = Object.fromEntries(
        [...openHistories, ...closedHistories]
          .filter((history): history is NonNullable<typeof history> => !!history && history.points.length > 1)
          .map((history) => [history.symbol, history])
      );

      return this.jsonResponse({ ok: true, data: { histories: data } });
    } catch (error) {
      this.log("System", "position_history_error", { error: String(error) });
      return new Response(JSON.stringify({ ok: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleKillSwitch(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    this.state.signalCache = [];
    this.state.signalResearch = {};
    this.state.premarketPlan = null;
    await this.persist();
    this.log("System", "kill_switch_activated", { timestamp: new Date().toISOString() });
    return this.jsonResponse({
      ok: true,
      message: "KILL SWITCH ACTIVATED. Agent disabled, alarms cancelled, signal cache cleared.",
      note: "Existing positions are NOT automatically closed. Review and close manually if needed.",
    });
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  private log(agent: string, action: string, details: Record<string, unknown>): void {
    const nowMs = Date.now();
    const entry: LogEntry = { timestamp: new Date(nowMs).toISOString(), agent, action, ...details };
    this.state.logs.push(entry);
    if (this.state.logs.length > this.MAX_LOG_ENTRIES) {
      this.state.logs = this.state.logs.slice(-this.MAX_LOG_ENTRIES);
    }
    this.recordDailyReportActivity(nowMs, agent, action, details);
    console.log(`[${entry.timestamp}] [${agent}] ${action}`, JSON.stringify(details));
  }

  private recordDailyReportActivity(
    timestampMs: number,
    agent: string,
    action: string,
    details: Record<string, unknown>
  ): void {
    const bucketStart = getDailyReportBucketStart(timestampMs);
    const bucketKey = String(bucketStart);
    const bucket = this.state.dailyReportBuckets[bucketKey] || createDailyReportBucket(bucketStart);

    let relevant = false;
    let symbol: string | null = typeof details.symbol === "string" && details.symbol.trim().length > 0 ? details.symbol.trim() : null;

    if (agent === "System" && action === "gathering_data") {
      bucket.data_gather_cycles++;
      relevant = true;
    } else if (agent === "Analyst" && action === "analysis_complete") {
      bucket.analyst_runs++;
      relevant = true;
    } else if (agent === "System" && action === "premarket_analysis_complete") {
      bucket.premarket_plans++;
      relevant = true;
    } else if (agent === "System" && action === "twitter_breaking_news") {
      bucket.breaking_news_alerts++;
      relevant = true;
    } else if (/(^|_)error$/.test(action)) {
      bucket.errors++;
      relevant = true;
    } else if (agent === "SignalResearch" && action === "signal_researched") {
      bucket.researched_signals++;
      const verdict = typeof details.verdict === "string" ? details.verdict : "";
      if (verdict === "BUY") bucket.buy_verdicts++;
      if (verdict === "SKIP") bucket.skip_verdicts++;
      if (verdict === "WAIT") bucket.wait_verdicts++;
      relevant = true;
    } else if (agent === "PolicyBroker" && action === "buy_executed") {
      bucket.executed_buys++;
      const notional = typeof details.notional === "number" && Number.isFinite(details.notional) ? details.notional : 0;
      bucket.executed_buy_notional += notional;
      bucket.recent_trades.push({
        side: "BUY",
        symbol: symbol || "UNKNOWN",
        timestamp: timestampMs,
        reason: typeof details.reason === "string" ? details.reason : undefined,
        notional: notional > 0 ? notional : undefined,
      });
      relevant = true;
    } else if (agent === "PolicyBroker" && action === "sell_executed") {
      bucket.executed_sells++;
      bucket.recent_trades.push({
        side: "SELL",
        symbol: symbol || "UNKNOWN",
        timestamp: timestampMs,
        reason: typeof details.reason === "string" ? details.reason : undefined,
      });
      relevant = true;
    }

    if (!relevant) {
      return;
    }

    bucket.total_events++;
    if (symbol) {
      bucket.symbol_counts[symbol] = (bucket.symbol_counts[symbol] || 0) + 1;
    }
    if (bucket.recent_trades.length > 10) {
      bucket.recent_trades = bucket.recent_trades
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10);
    }

    this.state.dailyReportBuckets[bucketKey] = bucket;
    pruneDailyReportBuckets(this.state.dailyReportBuckets, timestampMs, DAILY_REPORT_RETENTION_MS);
  }

  public trackLLMCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
    };
    const rates = pricing[model] ?? pricing["gpt-4o"]!;
    const cost = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;

    this.state.costTracker.total_usd += cost;
    this.state.costTracker.calls++;
    this.state.costTracker.tokens_in += tokensIn;
    this.state.costTracker.tokens_out += tokensOut;
    return cost;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async postDiscordEmbed(
    type: "trade" | "daily_report",
    symbol: string | null,
    embed: {
      title: string;
      color: number;
      fields: Array<{ name: string; value: string; inline: boolean }>;
      description?: string;
      timestamp: string;
      footer: { text: string };
    }
  ): Promise<boolean> {
    if (!this.env.DISCORD_WEBHOOK_URL) return false;

    try {
      const response = await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        throw new Error(`Discord webhook returned ${response.status}`);
      }

      this.log("Discord", "notification_sent", { type, symbol: symbol ?? undefined });
      return true;
    } catch (err) {
      this.log("Discord", "notification_failed", { type, symbol: symbol ?? undefined, error: String(err) });
      return false;
    }
  }

  private async sendDiscordTradeNotification(
    side: "BUY" | "SELL",
    trade:
      | { symbol: string; notional: number; reason: string; isCrypto: boolean; status: string; orderType: string }
      | { symbol: string; reason: string }
  ): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) return;

    const color = side === "BUY" ? 0x22c55e : 0xef4444;
    const icon = side === "BUY" ? "🟢" : "🔴";
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: "Action", value: side, inline: true },
      { name: "Symbol", value: `$${trade.symbol}`, inline: true },
      {
        name: "Reason",
        value: trade.reason.length > 300 ? `${trade.reason.slice(0, 297)}...` : trade.reason,
        inline: false,
      },
    ];

    if (side === "BUY" && "notional" in trade) {
      fields.splice(
        2,
        0,
        { name: "Notional", value: `$${trade.notional.toFixed(2)}`, inline: true },
        { name: "Order", value: `${trade.orderType} • ${trade.status}`, inline: true }
      );
      fields.push({ name: "Asset Class", value: trade.isCrypto ? "Crypto" : "Equity", inline: true });
    }

    await this.postDiscordEmbed("trade", trade.symbol, {
      title: `${icon} ${side} EXECUTED: $${trade.symbol}`,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: "MAHORAGA • Executed trade notification" },
    });
  }

  private async maybeSendDailyDiscordReport(account: Account | null, positions: Position[], nowMs: number): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL || !this.state.config.discord_daily_report_enabled) return;

    try {
      if (
        !shouldSendDailyReport(
          nowMs,
          this.state.lastDailyReportSentAt,
          this.state.config.discord_daily_report_time,
          this.state.config.discord_daily_report_timezone
        )
      ) {
        return;
      }
    } catch (error) {
      this.log("Discord", "daily_report_schedule_error", { error: String(error) });
      return;
    }

    try {
      const summary = summarizeDailyActivity(this.state.dailyReportBuckets, nowMs);
      const embed = formatDailyReportEmbed(summary, account, positions);
      const sent = await this.postDiscordEmbed("daily_report", null, embed);
      if (sent) {
        this.state.lastDailyReportSentAt = nowMs;
      }
    } catch (error) {
      this.log("Discord", "daily_report_failed", { error: String(error) });
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export function getHarnessStub(env: Env): DurableObjectStub {
  if (!env.MAHORAGA_HARNESS) {
    throw new Error("MAHORAGA_HARNESS binding not configured - check wrangler.toml");
  }
  const id = env.MAHORAGA_HARNESS.idFromName("main");
  return env.MAHORAGA_HARNESS.get(id);
}

export async function getHarnessStatus(env: Env): Promise<unknown> {
  const stub = getHarnessStub(env);
  const response = await stub.fetch(new Request("http://harness/status"));
  return response.json();
}

export async function enableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/enable"));
}

export async function disableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/disable"));
}
