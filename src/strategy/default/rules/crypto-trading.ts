/**
 * Crypto trading rules — momentum-based crypto entry/exit via Alpaca.
 *
 * These are standalone helpers used by the core harness for crypto-specific logic.
 * The main selectEntries/selectExits handle stocks; crypto has its own flow
 * because it trades 24/7 outside of market hours.
 */

import type { Position, ResearchResult, Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { StrategyContext } from "../../types";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../helpers/crypto";
import { getSignedSignalSentiment } from "../helpers/sentiment";
import {
  buildEntryReviewMetadata,
  evaluateEntryResearch,
  evaluateMarketRegimeEntry,
  getEntryFeaturePerformanceBlock,
  getEntrySelectionScore,
  getEntrySizeMultiplier,
  getRecentSellCooldown,
} from "./entries";

const CRYPTO_BUY_PENDING_TTL_MS = 10 * 60 * 1000;

function getCryptoMomentumPct(momentum: unknown): number | null {
  const numeric = Number(momentum);
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : 0;
}

function stringList(value: unknown, maxItems = 10, maxLength = 180): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) continue;
    result.push(text.slice(0, maxLength));
    if (result.length >= maxItems) break;
  }
  return result;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sanitizeCryptoResearchResult(
  analysis: Record<string, unknown> | null | undefined,
  symbol: string,
  timestamp = Date.now()
): ResearchResult {
  const verdict =
    analysis?.verdict === "BUY" || analysis?.verdict === "SKIP" || analysis?.verdict === "WAIT"
      ? analysis.verdict
      : "WAIT";
  const entryQuality =
    analysis?.entry_quality === "excellent" ||
    analysis?.entry_quality === "good" ||
    analysis?.entry_quality === "fair" ||
    analysis?.entry_quality === "poor"
      ? analysis.entry_quality
      : "poor";

  return {
    symbol,
    verdict,
    confidence: asConfidence(analysis?.confidence),
    entry_quality: entryQuality,
    reasoning: asString(analysis?.reasoning)?.slice(0, 1_000) ?? "LLM crypto research output missing usable reasoning",
    red_flags: stringList(analysis?.red_flags),
    catalysts: stringList(analysis?.catalysts),
    timestamp,
  };
}

export function buildCryptoResearchPrompt(params: {
  symbol: string;
  price: number;
  dailyChangePct: number;
  momentumPct: number;
  sentiment: number;
  minMomentumPct: number;
  maxMomentumPct: number;
}): string {
  const maxMomentumLine =
    params.maxMomentumPct > 0
      ? `- Configured overextension guard: avoid entries above ${params.maxMomentumPct.toFixed(2)}% momentum.`
      : "- Configured overextension guard is disabled.";

  return `Should we BUY this cryptocurrency based on momentum and market conditions?

SYMBOL: ${params.symbol}
PRICE: $${params.price.toFixed(2)}
24H CHANGE: ${params.dailyChangePct.toFixed(2)}%
MOMENTUM: ${params.momentumPct.toFixed(2)}%
SENTIMENT: ${(params.sentiment * 100).toFixed(0)}% bullish

CONFIGURED ENTRY CONTEXT:
- Momentum threshold: at least ${params.minMomentumPct.toFixed(2)}%.
${maxMomentumLine}
- This strategy is a 24/7 crypto momentum strategy, so price/volume momentum can be the entry thesis when it is fresh and not overextended.

Evaluate if this is a good entry. Consider:
- Is momentum above the configured threshold and not obviously exhausted?
- Is the 24h move still within a reasonable risk/reward window?
- Is sentiment aligned with the move rather than diverging bearish?
- Generic crypto volatility, absence of stock-style news, or a single price-momentum source is not by itself a red flag. Put those in reasoning if relevant, but reserve red_flags for material disqualifiers such as overextension, reversal, thin/invalid liquidity, broken data, or event risk.
- Do not recommend BUY unless entry_quality is good or excellent.
- A BUY needs at least one catalyst; for this strategy, a valid catalyst can be "fresh crypto momentum above threshold" when the data supports it.

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "brief reason",
  "red_flags": ["material disqualifiers only"],
  "catalysts": ["positive factors"]
}`;
}

function getFreshCryptoSignalReversal(
  signals: Signal[],
  symbol: string,
  maxAgeMinutes: number,
  threshold: number,
  minSources: number
): {
  reversed: boolean;
  averageSentiment: number | null;
  bullishSignals: number;
  bearishSignals: number;
  sourceCount: number;
} {
  const now = Date.now();
  const symbolKey = normalizeCryptoSymbol(symbol);
  const sources = new Set<string>();
  const sourceDetails = new Set<string>();
  let sentimentSum = 0;
  let signalCount = 0;
  let bullishSignals = 0;
  let bearishSignals = 0;

  for (const signal of signals) {
    if (normalizeCryptoSymbol(signal.symbol) !== symbolKey) continue;
    const ageMinutes = (now - signal.timestamp) / (60 * 1000);
    if (!Number.isFinite(ageMinutes) || ageMinutes > maxAgeMinutes) continue;

    const sentiment = getSignedSignalSentiment(signal);
    if (sentiment === null) continue;

    sources.add(signal.source || "unknown");
    sourceDetails.add(`${signal.source || "unknown"}:${signal.source_detail || signal.source || "unknown"}`);
    sentimentSum += sentiment;
    signalCount += 1;
    if (sentiment > 0) bullishSignals += 1;
    if (sentiment < 0) bearishSignals += 1;
  }

  const averageSentiment = signalCount > 0 ? sentimentSum / signalCount : null;
  const sourceCount = sources.size;
  return {
    reversed:
      averageSentiment !== null &&
      averageSentiment <= threshold &&
      bearishSignals > bullishSignals &&
      sourceCount >= minSources,
    averageSentiment,
    bullishSignals,
    bearishSignals,
    sourceCount,
  };
}

function getCryptoEntry(ctx: StrategyContext, symbol: string) {
  const symbolKey = normalizeCryptoSymbol(symbol);
  return ctx.positionEntries[symbol] ?? ctx.positionEntries[symbolKey];
}

function ensureCryptoEntry(ctx: StrategyContext, pos: Position) {
  const symbolKey = normalizeCryptoSymbol(pos.symbol);
  const existing = getCryptoEntry(ctx, pos.symbol);
  if (existing) return existing;

  const entryPrice = pos.avg_entry_price || pos.current_price || pos.lastday_price || 0;
  const entry = {
    symbol: symbolKey,
    entry_time: Date.now(),
    entry_price: entryPrice,
    entry_sentiment: 0,
    entry_social_volume: 0,
    entry_sources: ["crypto_position"],
    entry_reason: "Recovered crypto position metadata",
    peak_price: Math.max(entryPrice, pos.current_price || entryPrice),
    trough_price: Math.min(entryPrice, pos.current_price || entryPrice),
    peak_sentiment: 0,
  };
  ctx.positionEntries[symbolKey] = entry;
  return entry;
}

/**
 * Research a crypto symbol for BUY/SKIP/WAIT verdict.
 */
export async function researchCrypto(
  ctx: StrategyContext,
  symbol: string,
  momentum: number,
  sentiment: number
): Promise<ResearchResult | null> {
  if (!ctx.llm) {
    ctx.log("Crypto", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
    return null;
  }

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol).catch(() => null);
    const price = snapshot?.latest_trade?.price || 0;
    const dailyChange = snapshot
      ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100
      : 0;
    const momentumPct = getCryptoMomentumPct(momentum) ?? dailyChange;
    const prompt = buildCryptoResearchPrompt({
      symbol,
      price,
      dailyChangePct: dailyChange,
      momentumPct,
      sentiment,
      minMomentumPct: ctx.config.crypto_momentum_threshold ?? 2,
      maxMomentumPct: ctx.config.crypto_max_momentum_pct ?? 12,
    });

    const response = await ctx.llm.complete({
      model: ctx.config.llm_model,
      messages: [
        {
          role: "system",
          content:
            "You are a crypto momentum analyst. Be skeptical of FOMO, but evaluate the setup as a momentum strategy rather than a stock catalyst strategy. Output valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 250,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const usage = response.usage;
    if (usage) {
      ctx.trackLLMCost(ctx.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
    }

    const content = response.content || "{}";
    const result = sanitizeCryptoResearchResult(parseJsonObject(content.replace(/```json\n?|```/g, "").trim()), symbol);

    ctx.log("Crypto", "researched", {
      symbol,
      verdict: result.verdict,
      confidence: result.confidence,
      quality: result.entry_quality,
      red_flags: result.red_flags.slice(0, 3),
      catalysts: result.catalysts.slice(0, 3),
      reasoning: result.reasoning.slice(0, 240),
    });

    return result;
  } catch (error) {
    ctx.log("Crypto", "research_error", { symbol, error: String(error) });
    return null;
  }
}

/**
 * Run crypto-specific trading loop: check exits, then entries.
 * Called from the core harness when crypto_enabled is true.
 */
export async function runCryptoTrading(ctx: StrategyContext, positions: Position[]): Promise<void> {
  if (!ctx.config.crypto_enabled) return;

  const cryptoPositions = positions.filter((p) => isCryptoSymbol(p.symbol, ctx.config.crypto_symbols || []));
  const heldCrypto = new Set(cryptoPositions.map((p) => normalizeCryptoSymbol(p.symbol)));
  const now = Date.now();

  for (const symbol of heldCrypto) {
    ctx.state.set(`cryptoPendingBuy_${symbol}`, 0);
  }

  // Check exits
  for (const pos of cryptoPositions) {
    const costBasis = pos.market_value - pos.unrealized_pl;
    const plPct = costBasis > 0 ? (pos.unrealized_pl / costBasis) * 100 : 0;
    const entry = ensureCryptoEntry(ctx, pos);
    const entryPrice = entry.entry_price > 0 ? entry.entry_price : pos.avg_entry_price || pos.current_price || 0;
    const currentPrice = pos.current_price;

    if (currentPrice > 0) {
      entry.peak_price = Math.max(entry.peak_price || 0, currentPrice);
      entry.trough_price = Math.min(entry.trough_price ?? entry.entry_price ?? currentPrice, currentPrice);
    }

    if (plPct >= ctx.config.crypto_take_profit_pct) {
      ctx.log("Crypto", "take_profit", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await ctx.broker.sell(pos.symbol, `Crypto take profit at +${plPct.toFixed(1)}%`);
      continue;
    }

    if (plPct <= -ctx.config.crypto_stop_loss_pct) {
      ctx.log("Crypto", "stop_loss", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await ctx.broker.sell(pos.symbol, `Crypto stop loss at ${plPct.toFixed(1)}%`);
      continue;
    }

    if (entryPrice > 0 && currentPrice > 0) {
      const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
      const holdMinutes = holdHours * 60;
      if (
        (ctx.config.early_loss_exit_enabled ?? true) &&
        holdMinutes <= (ctx.config.early_loss_exit_max_hold_minutes ?? 90) &&
        plPct <= -(ctx.config.early_loss_exit_pct ?? 2.5)
      ) {
        ctx.log("Crypto", "early_loss_exit", {
          symbol: pos.symbol,
          pnl: plPct.toFixed(2),
          hold_minutes: Number(holdMinutes.toFixed(0)),
        });
        await ctx.broker.sell(
          pos.symbol,
          `Crypto early loss exit at ${plPct.toFixed(1)}% after ${holdMinutes.toFixed(0)}m`
        );
        continue;
      }

      const staleLossExitPct = ctx.config.stale_loss_exit_pct ?? 2;
      if (
        (ctx.config.stale_position_enabled ?? true) &&
        staleLossExitPct > 0 &&
        holdHours >= (ctx.config.stale_min_hold_hours ?? 24) &&
        plPct <= -staleLossExitPct
      ) {
        ctx.log("Crypto", "timed_loss_exit", {
          symbol: pos.symbol,
          pnl: plPct.toFixed(2),
          hold_hours: Number(holdHours.toFixed(1)),
        });
        await ctx.broker.sell(
          pos.symbol,
          `Crypto timed loss exit at ${plPct.toFixed(1)}% after ${holdHours.toFixed(1)}h`
        );
        continue;
      }

      if (
        (ctx.config.sentiment_reversal_exit_enabled ?? true) &&
        plPct <= -(ctx.config.sentiment_reversal_loss_pct ?? 1.5)
      ) {
        const minHoldMinutes = ctx.config.sentiment_reversal_min_hold_minutes ?? 60;
        if (holdMinutes >= minHoldMinutes) {
          const reversal = getFreshCryptoSignalReversal(
            ctx.signals,
            pos.symbol,
            ctx.config.max_entry_research_age_minutes ?? 30,
            ctx.config.sentiment_reversal_threshold ?? -0.25,
            ctx.config.sentiment_reversal_min_sources ?? 1
          );
          if (reversal.reversed) {
            ctx.log("Crypto", "sentiment_reversal_loss_exit", {
              symbol: pos.symbol,
              pnl: plPct.toFixed(2),
              average_sentiment: reversal.averageSentiment,
              bearish_signals: reversal.bearishSignals,
              source_count: reversal.sourceCount,
            });
            await ctx.broker.sell(
              pos.symbol,
              `Crypto sentiment reversal loss exit: ${plPct.toFixed(1)}%, avg signal ${(
                reversal.averageSentiment ?? 0
              ).toFixed(2)}, ${reversal.bearishSignals}/${reversal.sourceCount} bearish`
            );
            continue;
          }
        }
      }

      const peakPrice = Math.max(entry.peak_price || currentPrice, currentPrice);
      const peakGainPct = ((peakPrice - entryPrice) / entryPrice) * 100;
      const drawdownFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;
      const breakevenBufferPct = ctx.config.breakeven_stop_buffer_pct ?? 0.25;
      const breakevenActivationPct = ctx.config.breakeven_stop_activation_pct ?? 4;
      const profitLockActivationPct = ctx.config.profit_lock_activation_pct ?? 3;
      const profitLockBufferPct = ctx.config.profit_lock_floor_pct ?? 0.5;
      const profitLockPrice = entryPrice * (1 + profitLockBufferPct / 100);

      if (
        (ctx.config.sentiment_reversal_exit_enabled ?? true) &&
        plPct >= Math.max(0.1, profitLockBufferPct) &&
        holdHours * 60 >= (ctx.config.sentiment_reversal_min_hold_minutes ?? 60)
      ) {
        const reversal = getFreshCryptoSignalReversal(
          ctx.signals,
          pos.symbol,
          ctx.config.max_entry_research_age_minutes ?? 30,
          ctx.config.sentiment_reversal_threshold ?? -0.25,
          ctx.config.sentiment_reversal_min_sources ?? 1
        );
        if (reversal.reversed) {
          ctx.log("Crypto", "sentiment_reversal_profit_exit", {
            symbol: pos.symbol,
            pnl: plPct.toFixed(2),
            average_sentiment: reversal.averageSentiment,
            bearish_signals: reversal.bearishSignals,
            source_count: reversal.sourceCount,
          });
          await ctx.broker.sell(
            pos.symbol,
            `Crypto sentiment reversal profit exit: +${plPct.toFixed(1)}%, avg signal ${(
              reversal.averageSentiment ?? 0
            ).toFixed(2)}, ${reversal.bearishSignals}/${reversal.sourceCount} bearish`
          );
          continue;
        }
      }

      if (
        (ctx.config.profit_lock_stop_enabled ?? true) &&
        peakGainPct >= profitLockActivationPct &&
        currentPrice <= profitLockPrice
      ) {
        ctx.log("Crypto", "profit_lock_stop", {
          symbol: pos.symbol,
          peak_gain_pct: Number(peakGainPct.toFixed(2)),
          current_price: currentPrice,
          profit_lock_price: Number(profitLockPrice.toFixed(4)),
        });
        await ctx.broker.sell(
          pos.symbol,
          `Crypto profit lock stop: peak +${peakGainPct.toFixed(1)}%, current near +${profitLockBufferPct.toFixed(2)}% floor`
        );
        continue;
      }

      if (
        (ctx.config.trailing_stop_enabled ?? true) &&
        peakGainPct >= (ctx.config.trailing_stop_activation_pct ?? 6) &&
        drawdownFromPeakPct >= (ctx.config.trailing_stop_drawdown_pct ?? 3)
      ) {
        ctx.log("Crypto", "trailing_stop", {
          symbol: pos.symbol,
          peak_gain_pct: Number(peakGainPct.toFixed(2)),
          drawdown_pct: Number(drawdownFromPeakPct.toFixed(2)),
        });
        await ctx.broker.sell(
          pos.symbol,
          `Crypto trailing stop: peak +${peakGainPct.toFixed(1)}%, gave back ${drawdownFromPeakPct.toFixed(1)}%`
        );
        continue;
      }

      const breakevenPrice = entryPrice * (1 + breakevenBufferPct / 100);
      if (
        (ctx.config.breakeven_stop_enabled ?? true) &&
        peakGainPct >= breakevenActivationPct &&
        currentPrice <= breakevenPrice
      ) {
        ctx.log("Crypto", "breakeven_stop", {
          symbol: pos.symbol,
          peak_gain_pct: Number(peakGainPct.toFixed(2)),
          current_price: currentPrice,
          breakeven_price: Number(breakevenPrice.toFixed(4)),
        });
        await ctx.broker.sell(
          pos.symbol,
          `Crypto breakeven stop: peak +${peakGainPct.toFixed(1)}%, current near entry`
        );
      }
    }
  }

  // Check entries
  const maxCryptoPositions = Math.min(
    ctx.config.crypto_symbols?.length || 3,
    ctx.config.crypto_max_positions ?? 3
  );
  if (cryptoPositions.length >= maxCryptoPositions) return;

  const cryptoSignals = ctx.signals
    .filter((s) => s.isCrypto)
    .filter((s) => {
      const symbol = normalizeCryptoSymbol(s.symbol);
      if (heldCrypto.has(symbol)) return false;
      const pendingUntil = ctx.state.get<number>(`cryptoPendingBuy_${symbol}`) ?? 0;
      if (pendingUntil > now) {
        ctx.log("Crypto", "buy_skipped_pending", { symbol, pending_until: pendingUntil });
        return false;
      }
      return true;
    })
    .filter((s) => (getSignedSignalSentiment(s) ?? 0) > 0)
    .filter((s) => {
      const momentumPct = getCryptoMomentumPct(s.momentum);
      const threshold = ctx.config.crypto_momentum_threshold ?? 2;
      if (momentumPct !== null && momentumPct >= threshold) return true;
      ctx.log("Crypto", "buy_skipped_low_momentum", {
        symbol: normalizeCryptoSymbol(s.symbol),
        momentum_pct: momentumPct,
        threshold,
      });
      return false;
    })
    .filter((s) => {
      const momentumPct = getCryptoMomentumPct(s.momentum);
      const maxMomentumPct = ctx.config.crypto_max_momentum_pct ?? 12;
      if (maxMomentumPct <= 0 || momentumPct === null || momentumPct <= maxMomentumPct) return true;
      ctx.log("Crypto", "buy_skipped_overextended_momentum", {
        symbol: normalizeCryptoSymbol(s.symbol),
        momentum_pct: momentumPct,
        max_momentum_pct: maxMomentumPct,
      });
      return false;
    })
    .sort((a, b) => (getCryptoMomentumPct(b.momentum) ?? 0) - (getCryptoMomentumPct(a.momentum) ?? 0));

  const CRYPTO_RESEARCH_TTL_MS = 300_000;

  for (const signal of cryptoSignals.slice(0, 2)) {
    if (cryptoPositions.length >= maxCryptoPositions) break;

    const normalizedSymbol = normalizeCryptoSymbol(signal.symbol);
    const cachedResearch = ctx.state.get<ResearchResult>(`cryptoResearch_${normalizedSymbol}`);
    let research: ResearchResult | null = cachedResearch ?? null;

    if (!cachedResearch || Date.now() - cachedResearch.timestamp > CRYPTO_RESEARCH_TTL_MS) {
      research = await researchCrypto(ctx, normalizedSymbol, signal.momentum || 0, signal.sentiment);
      if (research) ctx.state.set(`cryptoResearch_${normalizedSymbol}`, research);
    }

    if (!research || research.verdict !== "BUY") {
      ctx.log("Crypto", "research_skip", {
        symbol: normalizedSymbol,
        verdict: research?.verdict || "NO_RESEARCH",
        confidence: research?.confidence || 0,
      });
      continue;
    }

    const cooldown = getRecentSellCooldown(ctx, normalizedSymbol, now);
    if (cooldown.blocked) {
      ctx.log("Crypto", "buy_skipped_recent_sell_cooldown", {
        symbol: normalizedSymbol,
        symbol_key: cooldown.symbolKey,
        remaining_minutes: cooldown.remainingMinutes,
        sell_reason: cooldown.reason,
      });
      continue;
    }

    if (research.confidence < ctx.config.min_analyst_confidence) {
      ctx.log("Crypto", "low_confidence", { symbol: normalizedSymbol, confidence: research.confidence });
      continue;
    }

    const qualityGate = evaluateEntryResearch(ctx, research);
    if (!qualityGate.allowed) {
      ctx.log("Crypto", "buy_skipped_quality_gate", {
        symbol: normalizedSymbol,
        reason: qualityGate.reason,
        confidence: research.confidence,
        quality: qualityGate.quality ?? research.entry_quality,
        red_flags: qualityGate.redFlags ?? research.red_flags?.length ?? 0,
        red_flag_list: research.red_flags?.slice(0, 3) ?? [],
        catalysts: qualityGate.catalysts ?? research.catalysts?.length ?? 0,
        catalyst_list: research.catalysts?.slice(0, 3) ?? [],
        source_count: qualityGate.sourceCount,
        average_sentiment: qualityGate.averageSentiment,
        bullish_signals: qualityGate.bullishSignals,
        bearish_signals: qualityGate.bearishSignals,
        age_minutes: qualityGate.ageMinutes,
      });
      continue;
    }

    const regimeGate = evaluateMarketRegimeEntry(ctx, research.confidence, research.entry_quality);
    if (!regimeGate.allowed) {
      ctx.log("Crypto", "buy_skipped_market_regime", {
        symbol: normalizedSymbol,
        reason: regimeGate.reason,
        average_sentiment: regimeGate.averageSentiment,
        threshold: regimeGate.threshold,
        confidence: regimeGate.confidence,
        required_confidence: regimeGate.requiredConfidence,
        quality: regimeGate.quality,
      });
      continue;
    }

    const entrySelectionScore = getEntrySelectionScore(ctx, research);
    const minEntrySelectionScore = ctx.config.min_entry_selection_score ?? 0.85;
    if (minEntrySelectionScore > 0 && entrySelectionScore < minEntrySelectionScore) {
      ctx.log("Crypto", "buy_skipped_low_selection_score", {
        symbol: normalizedSymbol,
        entry_selection_score: entrySelectionScore,
        min_entry_selection_score: minEntrySelectionScore,
        confidence: research.confidence,
        quality: research.entry_quality,
      });
      continue;
    }

    const account = await ctx.broker.getAccount();
    const sizePct = Math.min(20, ctx.config.position_size_pct_of_cash);
    const sizeMultiplier = getEntrySizeMultiplier(ctx, research.confidence);
    const positionSize = Math.min(
      account.cash * (sizePct / 100) * research.confidence * sizeMultiplier,
      ctx.config.crypto_max_position_value
    );

    if (positionSize < 10) {
      ctx.log("Crypto", "buy_skipped", { symbol: normalizedSymbol, reason: "Position too small" });
      continue;
    }

    const metadata = buildEntryReviewMetadata(ctx, research, {
      entry_path: "crypto_momentum",
      entry_selection_score: entrySelectionScore,
      size_multiplier: sizeMultiplier,
      momentum: signal.momentum ?? null,
      crypto_momentum_pct: getCryptoMomentumPct(signal.momentum),
    });
    const featurePerformanceBlock = getEntryFeaturePerformanceBlock(ctx, metadata);
    if (featurePerformanceBlock) {
      ctx.log("Crypto", "buy_skipped_poor_feature_performance", {
        symbol: normalizedSymbol,
        feature: featurePerformanceBlock.feature,
        trades: featurePerformanceBlock.trades,
        wins: featurePerformanceBlock.wins,
        losses: featurePerformanceBlock.losses,
        win_rate: featurePerformanceBlock.winRate,
        total_pnl_usd: featurePerformanceBlock.totalPnlUsd,
      });
      continue;
    }

    const result = await ctx.broker.buy(
      normalizedSymbol,
      positionSize,
      "Crypto momentum: " + research.reasoning,
      metadata
    );
    if (result) {
      ctx.state.set(`cryptoPendingBuy_${normalizedSymbol}`, Date.now() + CRYPTO_BUY_PENDING_TTL_MS);
      heldCrypto.add(normalizedSymbol);
      cryptoPositions.push({ symbol: normalizedSymbol } as Position);
      break;
    }
  }
}
