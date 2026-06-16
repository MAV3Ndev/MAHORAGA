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
import { createPolicyBroker } from "../core/policy-broker";
import { calculateTradeOutcome } from "../core/trade-outcome";
import type {
  AgentState,
  LogEntry,
  PositionEntry,
  ResearchResult,
  Signal,
  SocialHistoryEntry,
  SocialSnapshotCacheEntry,
} from "../core/types";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import { PolicyEngine } from "../policy/engine";
import { createAlpacaProviders } from "../providers/alpaca";
import { createLLMProvider } from "../providers/llm/factory";
import type { Account, LLMProvider, MarketClock, Position } from "../providers/types";
import type { AgentConfig } from "../schemas/agent-config";
import { safeValidateAgentConfig } from "../schemas/agent-config";
import { createD1Client } from "../storage/d1/client";
import { createJournalEntry, logOutcome } from "../storage/d1/queries/memory";
import { getRiskState, recordDailyLoss, setCooldown } from "../storage/d1/queries/risk-state";
import { createTrade, updateTradeStatus } from "../storage/d1/queries/trades";
import { createR2Client } from "../storage/r2/client";
import { R2Paths } from "../storage/r2/paths";
import { activeStrategy } from "../strategy";
import { DEFAULT_STATE } from "../strategy/default/config";
import {
  checkTwitterBreakingNews,
  gatherTwitterConfirmation,
  isTwitterEnabled,
  testTwitterCookieConnection,
} from "../strategy/default/gatherers/twitter";
import { testRedditCookieConnection } from "../strategy/default/gatherers/reddit";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import { getSignedSignalSentiment } from "../strategy/default/helpers/sentiment";
import { tickerCache } from "../strategy/default/helpers/ticker";
import { runCryptoTrading } from "../strategy/default/rules/crypto-trading";
import {
  buildEntryReviewMetadata,
  evaluateEntryResearch,
  evaluateEntryTimingBypass,
  evaluateMarketRegimeEntry,
  evaluatePortfolioBucket,
  evaluateUnresearchedRecommendationBuy,
  findEntryResearch,
  getEntryFeatureKeysFromMetadata,
  getEntryFeaturePerformanceBlock,
  getEntryPerformanceBlock,
  getEntrySelectionScore,
  getEntrySignalConsensus,
  getEntrySizeMultiplier,
  getRecentSellCooldown,
  getSignalConsensusState,
  inferPortfolioBucket,
  isAdaptiveBlockableEntryFeature,
} from "../strategy/default/rules/entries";
import { findBestOptionsContract, parseOccOptionSymbol } from "../strategy/default/rules/options";
import type { StrategyContext } from "../strategy/types";

type TradeReviewRow = Record<string, unknown>;

interface TradeReviewBucket {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_pnl_pct: number | null;
  avg_hold_mins: number | null;
}

interface TradeReviewTuningSuggestion {
  priority: "high" | "medium" | "low";
  direction: "tighten" | "loosen" | "investigate";
  target: string;
  config_keys: string[];
  proposed_config_patch?: Partial<AgentConfig>;
  evidence: Record<string, unknown>;
  suggestion: string;
}

interface PositionTimelinePoint {
  timestamp: number;
  price: number;
  change_pct: number;
}

type AnalystRecommendation = {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  confidence: number;
  reasoning: string;
  suggested_size_pct?: number;
};

type PositionResearchResult = {
  recommendation: "HOLD" | "SELL" | "ADD";
  risk_level: "low" | "medium" | "high";
  reasoning: string;
  key_factors: string[];
  timestamp: number;
};

export function mergeAgentConfigWithDefaults(config?: Partial<AgentConfig>): AgentConfig {
  return { ...DEFAULT_STATE.config, ...(config ?? {}) };
}

export function buildRecoveredPositionEntryFromJournal(
  row: Pick<import("../storage/d1/client").TradeJournalRow, "symbol" | "entry_price" | "entry_at" | "created_at" | "signals_json" | "notes">,
  position: Pick<Position, "symbol" | "avg_entry_price" | "current_price" | "lastday_price">,
  nowMs = Date.now()
): PositionEntry | null {
  const signals = parseJsonObject(row.signals_json);
  const entryPrice = asNumber(row.entry_price) ?? position.avg_entry_price;
  const currentPrice = position.current_price || position.lastday_price || entryPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return null;
  }

  const entryTimeSource = row.entry_at || row.created_at;
  const entryTimeMs = entryTimeSource ? new Date(entryTimeSource).getTime() : NaN;
  const lifecycle = parseJsonObject(signals?.lifecycle);
  const peakPrice = asNumber(lifecycle?.peak_price) ?? Math.max(entryPrice, currentPrice);
  const troughPrice = asNumber(lifecycle?.trough_price) ?? Math.min(entryPrice, currentPrice);
  const rawSources = signals?.sources;
  const entrySources = Array.isArray(rawSources)
    ? rawSources.map((source) => asString(source)).filter((source): source is string => !!source)
    : [];
  const entryQuoteMid = firstNestedNumber(signals, ["entry_quote_mid", "quote_mid"]);
  const entrySlippagePct = firstNestedNumber(signals, ["entry_slippage_pct"]);

  return {
    symbol: position.symbol,
    entry_time: Number.isFinite(entryTimeMs) ? entryTimeMs : nowMs,
    entry_price: entryPrice,
    entry_sentiment: asNumber(signals?.signal_consensus_average) ?? asNumber(signals?.confidence) ?? 0,
    entry_social_volume: asNumber(signals?.entry_social_volume) ?? 0,
    entry_sources: entrySources.length > 0 ? entrySources : ["trade_journal_recovery"],
    entry_reason: asString(signals?.reason) ?? row.notes ?? "Recovered open position tracking from trade journal",
    ...(entryQuoteMid !== null ? { entry_quote_mid: entryQuoteMid } : {}),
    ...(entrySlippagePct !== null ? { entry_slippage_pct: entrySlippagePct } : {}),
    peak_price: Math.max(peakPrice, currentPrice),
    trough_price: Math.min(troughPrice, currentPrice),
    peak_sentiment: asNumber(signals?.peak_sentiment) ?? asNumber(signals?.signal_consensus_average) ?? 0,
  };
}

export function evaluateOptionEntryQuote(
  quote: { bid_price?: number; ask_price?: number } | null | undefined,
  maxSpreadPct = 10
): { allowed: boolean; bid: number | null; ask: number | null; midPrice: number | null; spreadPct: number | null; reason?: string } {
  const bid = Number(quote?.bid_price);
  const ask = Number(quote?.ask_price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return {
      allowed: false,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      midPrice: null,
      spreadPct: null,
      reason: "invalid_bid_ask",
    };
  }

  const spreadPct = ((ask - bid) / ask) * 100;
  if (spreadPct > maxSpreadPct) {
    return {
      allowed: false,
      bid,
      ask,
      midPrice: (bid + ask) / 2,
      spreadPct,
      reason: "wide_spread",
    };
  }

  return {
    allowed: true,
    bid,
    ask,
    midPrice: (bid + ask) / 2,
    spreadPct,
  };
}

export function evaluateOptionsEarlyLossExit(
  plPct: number,
  entryTimeMs: number,
  config: Pick<
    AgentConfig,
    "options_early_loss_exit_enabled" | "options_early_loss_exit_pct" | "options_early_loss_exit_max_hold_minutes"
  >,
  nowMs = Date.now()
): { shouldExit: boolean; holdMinutes: number; reason?: string } {
  const holdMinutes = Math.max(0, (nowMs - entryTimeMs) / 60_000);
  const maxHoldMinutes = config.options_early_loss_exit_max_hold_minutes ?? 60;
  const lossPct = config.options_early_loss_exit_pct ?? 25;

  if (!(config.options_early_loss_exit_enabled ?? true)) return { shouldExit: false, holdMinutes };
  if (!Number.isFinite(plPct) || !Number.isFinite(entryTimeMs) || !Number.isFinite(nowMs)) {
    return { shouldExit: false, holdMinutes };
  }
  if (lossPct <= 0 || maxHoldMinutes <= 0) return { shouldExit: false, holdMinutes };
  if (holdMinutes > maxHoldMinutes) return { shouldExit: false, holdMinutes };
  if (plPct > -lossPct) return { shouldExit: false, holdMinutes };

  return {
    shouldExit: true,
    holdMinutes,
    reason: `Options early loss exit at ${plPct.toFixed(1)}% after ${holdMinutes.toFixed(0)}m`,
  };
}

export function evaluateEntryIntradayRangePosition(
  snapshot:
    | {
        latest_trade?: { price?: number };
        daily_bar?: { h?: number; l?: number; c?: number };
      }
    | null
    | undefined,
  maxRangePosition = 0.75
): { blocked: boolean; rangePosition: number | null; currentPrice: number | null; reason?: string } {
  const high = Number(snapshot?.daily_bar?.h);
  const low = Number(snapshot?.daily_bar?.l);
  const current = Number(snapshot?.latest_trade?.price ?? snapshot?.daily_bar?.c);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(current) ||
    high <= 0 ||
    low <= 0 ||
    current <= 0 ||
    high <= low
  ) {
    return { blocked: false, rangePosition: null, currentPrice: Number.isFinite(current) ? current : null };
  }

  const rangePosition = Math.max(0, Math.min(1, (current - low) / (high - low)));
  if (rangePosition > maxRangePosition) {
    return {
      blocked: true,
      rangePosition,
      currentPrice: current,
      reason: "near_intraday_range_high",
    };
  }

  return { blocked: false, rangePosition, currentPrice: current };
}

export function buildSignalResearchCandidates(
  signals: Signal[],
  heldSymbols: Set<string>,
  minSentiment: number,
  limit: number,
  normalizeSymbol = (symbol: string) => normalizeCryptoSymbol(symbol.trim().toUpperCase())
): Array<{ symbol: string; sentiment: number; sources: string[] }> {
  const aggregated = new Map<
    string,
    { symbol: string; sentimentNumerator: number; volume: number; sources: Set<string> }
  >();

  for (const sig of signals) {
    const symbolKey = normalizeSymbol(sig.symbol);
    if (heldSymbols.has(sig.symbol) || heldSymbols.has(symbolKey)) continue;

    const signedSentiment = getSignedSignalSentiment(sig);
    if (signedSentiment === null || signedSentiment < minSentiment) continue;

    const volume = Number.isFinite(sig.volume) && sig.volume > 0 ? sig.volume : 1;
    let entry = aggregated.get(symbolKey);
    if (!entry) {
      entry = { symbol: sig.symbol, sentimentNumerator: 0, volume: 0, sources: new Set() };
      aggregated.set(symbolKey, entry);
    }
    entry.volume += volume;
    entry.sentimentNumerator += signedSentiment * volume;
    entry.sources.add(sig.source || "unknown");
  }

  return Array.from(aggregated.values())
    .map((entry) => ({
      symbol: entry.symbol,
      sentiment: entry.volume > 0 ? entry.sentimentNumerator / entry.volume : 0,
      sources: Array.from(entry.sources).filter(Boolean),
    }))
    .sort((a, b) => b.sentiment - a.sentiment || b.sources.length - a.sources.length)
    .slice(0, limit);
}

export function buildFreshSignalCache(
  signals: Signal[],
  nowMs: number,
  maxAgeMs: number,
  maxSignals: number,
  normalizeSymbol = (symbol: string) => normalizeCryptoSymbol(symbol.trim().toUpperCase())
): Signal[] {
  const deduped = new Map<string, Signal>();
  for (const signal of signals) {
    if (!signal.symbol) continue;
    const ageMs = nowMs - signal.timestamp;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= maxAgeMs) continue;

    const key = [
      normalizeSymbol(signal.symbol),
      signal.source || "unknown",
      signal.source_detail || signal.source || "unknown",
    ].join("|");
    const existing = deduped.get(key);
    if (
      !existing ||
      signal.timestamp > existing.timestamp ||
      (signal.timestamp === existing.timestamp &&
        Math.abs(getSignedSignalSentiment(signal) ?? 0) > Math.abs(getSignedSignalSentiment(existing) ?? 0))
    ) {
      deduped.set(key, signal);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => Math.abs(getSignedSignalSentiment(b) ?? 0) - Math.abs(getSignedSignalSentiment(a) ?? 0))
    .slice(0, maxSignals);
}

export function findSignalForSymbolByAlias(
  signals: Signal[],
  symbol: string,
  normalizeSymbol = (value: string) => normalizeCryptoSymbol(value.trim().toUpperCase())
): Signal | undefined {
  const symbolKey = normalizeSymbol(symbol);
  return signals.find((signal) => normalizeSymbol(signal.symbol) === symbolKey);
}

export function findSocialSnapshotForSymbolByAlias(
  snapshot: Record<string, SocialSnapshotCacheEntry>,
  symbol: string,
  normalizeSymbol = (value: string) => normalizeCryptoSymbol(value.trim().toUpperCase())
): SocialSnapshotCacheEntry | undefined {
  const symbolKey = normalizeSymbol(symbol);
  return (
    snapshot[symbol] ??
    snapshot[symbol.trim().toUpperCase()] ??
    snapshot[symbolKey] ??
    Object.entries(snapshot).find(([snapshotSymbol]) => normalizeSymbol(snapshotSymbol) === symbolKey)?.[1]
  );
}

export function getMarketClockMinutesToClose(clock: Pick<MarketClock, "timestamp" | "next_close">): number | null {
  const nextCloseMs = new Date(clock.next_close).getTime();
  if (!Number.isFinite(nextCloseMs)) return null;

  const clockTimestampMs = new Date(clock.timestamp).getTime();
  const referenceMs = Number.isFinite(clockTimestampMs) ? clockTimestampMs : Date.now();
  return (nextCloseMs - referenceMs) / 60000;
}

export function getMarketClockMinutesSinceOpen(clock: Pick<MarketClock, "timestamp">): number | null {
  const clockTimestampMs = new Date(clock.timestamp).getTime();
  const referenceMs = Number.isFinite(clockTimestampMs) ? clockTimestampMs : Date.now();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(referenceMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute - (9 * 60 + 30);
}

function sanitizeConfidence(value: unknown): number {
  const numeric = asNumber(value);
  return numeric !== null && numeric >= 0 && numeric <= 1 ? numeric : 0;
}

function sanitizeStringList(value: unknown, maxItems = 10, maxLength = 180): string[] {
  if (!Array.isArray(value)) return [];
  const sanitized: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) continue;
    sanitized.push(text.slice(0, maxLength));
    if (sanitized.length >= maxItems) break;
  }
  return sanitized;
}

export function sanitizeSignalResearchResult(
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
    confidence: sanitizeConfidence(analysis?.confidence),
    entry_quality: entryQuality,
    reasoning: asString(analysis?.reasoning)?.slice(0, 1_000) ?? "LLM research output missing usable reasoning",
    red_flags: sanitizeStringList(analysis?.red_flags),
    catalysts: sanitizeStringList(analysis?.catalysts),
    timestamp,
  };
}

export function sanitizeAnalystRecommendations(value: unknown): AnalystRecommendation[] {
  if (!Array.isArray(value)) return [];
  const recommendations: AnalystRecommendation[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const symbol = asString(rec.symbol)?.toUpperCase();
    if (!symbol) continue;

    const action = rec.action === "BUY" || rec.action === "SELL" || rec.action === "HOLD" ? rec.action : "HOLD";
    const sanitized: AnalystRecommendation = {
      action,
      symbol,
      confidence: sanitizeConfidence(rec.confidence),
      reasoning: asString(rec.reasoning)?.slice(0, 1_000) ?? "LLM analyst output missing usable reasoning",
    };
    const suggestedSizePct = asNumber(rec.suggested_size_pct);
    if (suggestedSizePct !== null) sanitized.suggested_size_pct = Math.min(100, Math.max(0, suggestedSizePct));
    recommendations.push(sanitized);
  }

  return recommendations;
}

export function sanitizePositionResearchResult(
  analysis: Record<string, unknown> | null | undefined,
  timestamp = Date.now()
): PositionResearchResult {
  const recommendation =
    analysis?.recommendation === "SELL" || analysis?.recommendation === "ADD" || analysis?.recommendation === "HOLD"
      ? analysis.recommendation
      : "HOLD";
  const riskLevel =
    analysis?.risk_level === "high" || analysis?.risk_level === "medium" || analysis?.risk_level === "low"
      ? analysis.risk_level
      : "medium";

  return {
    recommendation,
    risk_level: riskLevel,
    reasoning: asString(analysis?.reasoning)?.slice(0, 1_000) ?? "LLM position research output missing usable reasoning",
    key_factors: sanitizeStringList(analysis?.key_factors),
    timestamp,
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

function outcomeOf(row: TradeReviewRow): "win" | "loss" | "scratch" | "open" {
  const outcome = asString(row.outcome)?.toLowerCase();
  if (outcome === "win" || outcome === "loss" || outcome === "scratch") return outcome;
  const pnl = asNumber(row.pnl_usd) ?? asNumber(row.pnl_pct);
  if (pnl === null) return "open";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "scratch";
}

function collectNestedValues(value: unknown, keyNames: Set<string>, depth = 0): unknown[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectNestedValues(item, keyNames, depth + 1));
  if (typeof value !== "object") return [];

  const found: unknown[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keyNames.has(key.toLowerCase())) found.push(nested);
    found.push(...collectNestedValues(nested, keyNames, depth + 1));
  }
  return found;
}

function firstNestedString(source: unknown, keys: string[]): string | null {
  for (const value of collectNestedValues(source, new Set(keys.map((key) => key.toLowerCase())))) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return null;
}

function firstNestedNumber(source: unknown, keys: string[]): number | null {
  for (const value of collectNestedValues(source, new Set(keys.map((key) => key.toLowerCase())))) {
    const numericValue = asNumber(value);
    if (numericValue !== null) return numericValue;
  }
  return null;
}

function firstNestedBoolean(source: unknown, keys: string[]): boolean | null {
  for (const value of collectNestedValues(source, new Set(keys.map((key) => key.toLowerCase())))) {
    if (typeof value === "boolean") return value;
    const stringValue = asString(value)?.toLowerCase();
    if (stringValue === "true") return true;
    if (stringValue === "false") return false;
  }
  return null;
}

function firstNestedCount(source: unknown, keys: string[]): number | null {
  for (const value of collectNestedValues(source, new Set(keys.map((key) => key.toLowerCase())))) {
    if (Array.isArray(value)) return value.length;
    const numericValue = asNumber(value);
    if (numericValue !== null) return numericValue;
    const stringValue = asString(value);
    if (stringValue) {
      return stringValue
        .split(/[,|]/)
        .map((part) => part.trim())
        .filter(Boolean).length;
    }
  }
  return null;
}

function confidenceBucket(confidence: number | null): string {
  if (confidence === null) return "unknown";
  if (confidence >= 0.9) return "0.90+";
  if (confidence >= 0.8) return "0.80-0.89";
  if (confidence >= 0.7) return "0.70-0.79";
  if (confidence >= 0.6) return "0.60-0.69";
  return "<0.60";
}

function entrySelectionScoreBucket(score: number | null): string {
  if (score === null) return "unknown";
  if (score >= 1.15) return "1.15+";
  if (score >= 1.05) return "1.05-1.14";
  if (score >= 0.95) return "0.95-1.04";
  if (score >= 0.85) return "0.85-0.94";
  return "<0.85";
}

function entrySpreadBucket(spreadPct: number | null): string {
  if (spreadPct === null) return "unknown";
  if (spreadPct <= 0.25) return "<=0.25%";
  if (spreadPct <= 0.8) return "0.25%..0.80%";
  if (spreadPct <= 2) return "0.80%..2%";
  return "2%+";
}

function entryFillDelayBucket(minutes: number | null): string {
  if (minutes === null) return "unknown";
  if (minutes < 1) return "<1m";
  if (minutes < 5) return "1m..5m";
  if (minutes < 30) return "5m..30m";
  return "30m+";
}

function entryQuoteSlippageBucket(slippagePct: number | null): string {
  if (slippagePct === null) return "unknown";
  if (slippagePct <= 0) return "<=0%";
  if (slippagePct <= 0.25) return "0%..0.25%";
  if (slippagePct <= 0.75) return "0.25%..0.75%";
  return "0.75%+";
}

function entryPriceChangeBucket(changePct: number | null): string {
  if (changePct === null) return "unknown";
  if (changePct <= 0) return "<=0%";
  if (changePct <= 2) return "0%..2%";
  if (changePct <= 5) return "2%..5%";
  return "5%+";
}

function pnlBucket(pnlPct: number | null): string {
  if (pnlPct === null) return "open";
  if (pnlPct <= -10) return "<=-10%";
  if (pnlPct <= -5) return "-10%..-5%";
  if (pnlPct < 0) return "-5%..0%";
  if (pnlPct === 0) return "0%";
  if (pnlPct < 5) return "0%..5%";
  if (pnlPct < 10) return "5%..10%";
  return "10%+";
}

function mfeBucket(mfePct: number | null): string {
  if (mfePct === null) return "unknown";
  if (mfePct < 1) return "<1%";
  if (mfePct < 3) return "1%..3%";
  if (mfePct < 6) return "3%..6%";
  return "6%+";
}

function maeBucket(maePct: number | null): string {
  if (maePct === null) return "unknown";
  if (maePct <= -10) return "<=-10%";
  if (maePct <= -5) return "-10%..-5%";
  if (maePct <= -2) return "-5%..-2%";
  if (maePct < 0) return "-2%..0%";
  return "0%+";
}

function givebackBucket(givebackPct: number | null): string {
  if (givebackPct === null) return "unknown";
  if (givebackPct < 1) return "<1%";
  if (givebackPct < 3) return "1%..3%";
  if (givebackPct < 6) return "3%..6%";
  return "6%+";
}

function optionDteBucket(dte: number | null): string {
  if (dte === null) return "unknown";
  if (dte < 7) return "<7d";
  if (dte < 14) return "7d..14d";
  if (dte <= 45) return "14d..45d";
  return "45d+";
}

function optionDeltaBucket(delta: number | null): string {
  if (delta === null) return "unknown";
  const absDelta = Math.abs(delta);
  if (absDelta < 0.3) return "<0.30";
  if (absDelta < 0.5) return "0.30..0.50";
  if (absDelta <= 0.7) return "0.50..0.70";
  return "0.70+";
}

function cryptoMomentumBucket(momentum: number | null): string {
  if (momentum === null) return "unknown";
  const pct = Math.abs(momentum) <= 1 ? momentum * 100 : momentum;
  if (pct < 2) return "<2%";
  if (pct < 4) return "2%..4%";
  if (pct < 8) return "4%..8%";
  return "8%+";
}

function exitEfficiencyBucket(exitEfficiencyPct: number | null): string {
  if (exitEfficiencyPct === null) return "unknown";
  if (exitEfficiencyPct < 25) return "<25%";
  if (exitEfficiencyPct < 50) return "25%..50%";
  if (exitEfficiencyPct < 75) return "50%..75%";
  return "75%+";
}

function holdBucket(minutes: number | null): string {
  if (minutes === null) return "unknown";
  if (minutes < 60) return "<1h";
  if (minutes < 240) return "1h-4h";
  if (minutes < 24 * 60) return "4h-1d";
  if (minutes < 5 * 24 * 60) return "1d-5d";
  return "5d+";
}

function entryDateFromFeatureSource(source: Record<string, unknown>): Date | null {
  const timestamp =
    firstNestedString(source, ["entry_at", "entryAt", "filled_at", "submitted_at", "created_at", "timestamp"]) ??
    firstNestedNumber(source, ["entry_at", "entryAt", "filled_at", "submitted_at", "created_at", "timestamp"]);
  if (timestamp === null) return null;
  const date =
    typeof timestamp === "number"
      ? new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp)
      : new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

function etTimeParts(date: Date): { hour: number; minute: number; weekday: string } | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  return Number.isFinite(hour) && Number.isFinite(minute) && weekday ? { hour, minute, weekday } : null;
}

function entrySessionBucket(date: Date | null): string {
  if (!date) return "unknown";
  const parts = etTimeParts(date);
  if (!parts) return "unknown";
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes < 9 * 60 + 30) return "premarket";
  if (minutes < 10 * 60) return "open_30m";
  if (minutes < 12 * 60) return "morning";
  if (minutes < 14 * 60) return "midday";
  if (minutes < 15 * 60 + 30) return "afternoon";
  if (minutes < 16 * 60) return "close_30m";
  return "after_hours";
}

function entryWeekdayBucket(date: Date | null): string {
  if (!date) return "unknown";
  return etTimeParts(date)?.weekday ?? "unknown";
}

function tradeReviewEventTime(row: TradeReviewRow): number {
  const value =
    asString(row.exit_at) ??
    asString(row.closed_at) ??
    asString(row.updated_at) ??
    asString(row.trade_updated_at) ??
    asString(row.created_at) ??
    asString(row.trade_created_at) ??
    asString(row.entry_at) ??
    asString(row.filled_at);
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function researchAgeBucket(minutes: number | null): string {
  if (minutes === null) return "unknown";
  if (minutes <= 10) return "<=10m";
  if (minutes <= 30) return "10-30m";
  if (minutes <= 60) return "30-60m";
  return ">60m";
}

function sizeMultiplierBucket(multiplier: number | null): string {
  if (multiplier === null) return "unknown";
  if (multiplier >= 0.9) return "0.90+";
  if (multiplier >= 0.7) return "0.70-0.89";
  if (multiplier >= 0.45) return "0.45-0.69";
  return "<0.45";
}

function tradeAssetClass(source: Record<string, unknown>, symbol: string): string {
  const explicit = firstNestedString(source, ["asset_class", "assetClass"])?.toLowerCase();
  if (explicit?.includes("option")) return "options";
  if (explicit?.includes("crypto")) return "crypto";
  if (explicit?.includes("equity") || explicit === "us_equity") return "equity";

  if (parseOccOptionSymbol(symbol)) return "options";
  if (isCryptoSymbol(symbol, [])) return "crypto";
  return "equity";
}

function exitReasonBucket(row: TradeReviewRow): string | null {
  if (outcomeOf(row) === "open") return null;
  const reason = (asString(row.lessons_learned) ?? asString(row.notes) ?? "").toLowerCase();
  if (!reason) return "unknown";
  if (reason.includes("profit lock")) return "profit_lock";
  if (reason.includes("trailing stop")) return "trailing_stop";
  if (reason.includes("breakeven")) return "breakeven_stop";
  if (reason.includes("take profit")) return "take_profit";
  if (reason.includes("stop loss")) return "stop_loss";
  if (reason.includes("timed loss")) return "timed_loss";
  if (reason.includes("sentiment reversal profit")) return "sentiment_reversal_profit";
  if (reason.includes("sentiment reversal loss")) return "sentiment_reversal_loss";
  if (reason.includes("sentiment reversal")) return "sentiment_reversal";
  if (reason.includes("stale")) return "stale";
  if (reason.includes("llm recommendation")) return "llm_recommendation";
  if (reason.includes("pre-market plan")) return "premarket_plan";
  if (reason.includes("options")) return "options";
  return "other";
}

function updateTradeReviewBucket(map: Map<string, TradeReviewBucket>, key: string, row: TradeReviewRow): void {
  const normalizedKey = key || "unknown";
  const bucket =
    map.get(normalizedKey) ??
    ({
      key: normalizedKey,
      trades: 0,
      wins: 0,
      losses: 0,
      scratches: 0,
      win_rate: 0,
      total_pnl_usd: 0,
      avg_pnl_pct: null,
      avg_hold_mins: null,
    } satisfies TradeReviewBucket);

  const outcome = outcomeOf(row);
  const pnlUsd = asNumber(row.pnl_usd) ?? 0;
  const pnlPct = asNumber(row.pnl_pct);
  const holdMins = asNumber(row.hold_duration_mins);

  bucket.trades += 1;
  if (outcome === "win") bucket.wins += 1;
  if (outcome === "loss") bucket.losses += 1;
  if (outcome === "scratch") bucket.scratches += 1;
  bucket.total_pnl_usd += pnlUsd;

  const previousPnlCount = (bucket as TradeReviewBucket & { _pnlCount?: number })._pnlCount ?? 0;
  if (pnlPct !== null) {
    const previousTotal = (bucket.avg_pnl_pct ?? 0) * previousPnlCount;
    (bucket as TradeReviewBucket & { _pnlCount?: number })._pnlCount = previousPnlCount + 1;
    bucket.avg_pnl_pct = (previousTotal + pnlPct) / (previousPnlCount + 1);
  }

  const previousHoldCount = (bucket as TradeReviewBucket & { _holdCount?: number })._holdCount ?? 0;
  if (holdMins !== null) {
    const previousTotal = (bucket.avg_hold_mins ?? 0) * previousHoldCount;
    (bucket as TradeReviewBucket & { _holdCount?: number })._holdCount = previousHoldCount + 1;
    bucket.avg_hold_mins = (previousTotal + holdMins) / (previousHoldCount + 1);
  }

  bucket.win_rate = bucket.wins + bucket.losses > 0 ? bucket.wins / (bucket.wins + bucket.losses) : 0;
  map.set(normalizedKey, bucket);
}

function finalizeBuckets(map: Map<string, TradeReviewBucket>, limit = 20): TradeReviewBucket[] {
  return [...map.values()]
    .map((bucket) => ({
      key: bucket.key,
      trades: bucket.trades,
      wins: bucket.wins,
      losses: bucket.losses,
      scratches: bucket.scratches,
      win_rate: Number(bucket.win_rate.toFixed(4)),
      total_pnl_usd: Number(bucket.total_pnl_usd.toFixed(2)),
      avg_pnl_pct: bucket.avg_pnl_pct === null ? null : Number(bucket.avg_pnl_pct.toFixed(4)),
      avg_hold_mins: bucket.avg_hold_mins === null ? null : Number(bucket.avg_hold_mins.toFixed(1)),
    }))
    .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function summarizeRuntimeLogs(logs: LogEntry[]): Record<string, unknown> {
  const entryBlockers = new Map<string, { action: string; count: number; symbols: Set<string> }>();
  const entryBlockerReasons = new Map<
    string,
    { action: string; reason: string; count: number; symbols: Set<string> }
  >();
  const missedEntryReasons = new Map<
    string,
    {
      action: string;
      reason: string;
      evaluated: number;
      wouldHaveWon: number;
      wouldHaveLost: number;
      symbols: Set<string>;
    }
  >();
  const exitBlockers = new Map<string, { action: string; count: number; symbols: Set<string> }>();
  const entryBlockerSamples: Array<Record<string, unknown>> = [];
  const actionCounts = new Map<string, number>();
  const analystSkippedReasons = new Map<string, number>();
  let buyExecuted = 0;
  let buySubmitted = 0;
  let buyDeferred = 0;
  let signalResearchCount = 0;
  let signalResearchNoCandidates = 0;
  let signalResearchBuyCount = 0;
  let signalResearchWaitCount = 0;
  let signalResearchSkipCount = 0;
  let entrySelectionCycles = 0;
  let strategyEntryCandidates = 0;
  let researchedBuyAvailable = 0;
  let analystCompleteCount = 0;
  let analystSkippedCount = 0;
  let analystBuyRecommendations = 0;
  let analystBuyRecommendationsAboveThreshold = 0;
  let missedEntryEvaluated = 0;
  let missedEntryWouldHaveWon = 0;
  let missedEntryWouldHaveLost = 0;
  const blockerPatterns = [
    "buy_blocked",
    "buy_rejected",
    "buy_skipped",
    "entry_skipped",
    "llm_buy_skipped",
    "premarket_buy_skipped",
    "options_buy_rejected",
    "options_buy_skipped",
  ];
  const exitBlockerPatterns = [
    "sell_blocked",
    "sell_failed",
    "sell_outcome_deferred",
    "sell_pending_order_check_unavailable",
    "deferred_sell_partially_filled",
    "deferred_sell_canceled_stale_exit",
  ];

  for (const log of logs) {
    const action = typeof log.action === "string" ? log.action : "";
    const symbol = asString(log.symbol) ?? asString(log.requested_symbol) ?? asString(log.contract);
    if (!action) continue;

    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    if (action === "buy_executed" || action === "options_buy_executed") buyExecuted += 1;
    if (action === "buy_submitted" || action === "options_buy_submitted") buySubmitted += 1;
    if (action === "buy_outcome_deferred" || action === "options_outcome_deferred") buyDeferred += 1;
    if (action === "signal_researched") {
      signalResearchCount += 1;
      const verdict = asString(log.verdict)?.toUpperCase();
      if (verdict === "BUY") signalResearchBuyCount += 1;
      if (verdict === "WAIT") signalResearchWaitCount += 1;
      if (verdict === "SKIP") signalResearchSkipCount += 1;
    }
    if (action === "no_candidates") signalResearchNoCandidates += 1;
    if (action === "entry_selection_summary") {
      entrySelectionCycles += 1;
      strategyEntryCandidates += asNumber(log.strategy_entry_candidates) ?? 0;
      researchedBuyAvailable += asNumber(log.researched_buy_available) ?? 0;
    }
    if (action === "analysis_complete") {
      analystCompleteCount += 1;
      analystBuyRecommendations += asNumber(log.buy_recommendations) ?? 0;
      analystBuyRecommendationsAboveThreshold += asNumber(log.buy_recommendations_above_threshold) ?? 0;
    }
    if (action === "analyst_skipped") {
      analystSkippedCount += 1;
      const reason = asString(log.reason) ?? "unknown";
      analystSkippedReasons.set(reason, (analystSkippedReasons.get(reason) ?? 0) + 1);
    }

    if (action === "missed_entry_evaluated") {
      missedEntryEvaluated += 1;
      const changePct = asNumber(log.change_pct);
      const reason = asString(log.reason) ?? "unknown";
      const originalAction = asString(log.blocked_action) ?? "unknown";
      const reasonKey = `${originalAction}:${reason}`;
      const missedBucket = missedEntryReasons.get(reasonKey) ?? {
        action: originalAction,
        reason,
        evaluated: 0,
        wouldHaveWon: 0,
        wouldHaveLost: 0,
        symbols: new Set<string>(),
      };
      missedBucket.evaluated += 1;
      if (symbol) missedBucket.symbols.add(symbol.toUpperCase());
      if (changePct !== null && changePct >= 2) {
        missedEntryWouldHaveWon += 1;
        missedBucket.wouldHaveWon += 1;
        actionCounts.set("missed_entry_would_have_won", (actionCounts.get("missed_entry_would_have_won") ?? 0) + 1);
      } else if (changePct !== null && changePct <= -2) {
        missedEntryWouldHaveLost += 1;
        missedBucket.wouldHaveLost += 1;
      }
      missedEntryReasons.set(reasonKey, missedBucket);
    }

    if (blockerPatterns.some((pattern) => action.includes(pattern))) {
      const current = entryBlockers.get(action) ?? { action, count: 0, symbols: new Set<string>() };
      current.count += 1;
      if (symbol) current.symbols.add(symbol.toUpperCase());
      entryBlockers.set(action, current);

      const reason = asString(log.reason) ?? asString(log.sell_reason) ?? asString(log.violation) ?? "unknown";
      const reasonKey = action + ":" + reason;
      const reasonBucket = entryBlockerReasons.get(reasonKey) ?? {
        action,
        reason,
        count: 0,
        symbols: new Set<string>(),
      };
      reasonBucket.count += 1;
      if (symbol) reasonBucket.symbols.add(symbol.toUpperCase());
      entryBlockerReasons.set(reasonKey, reasonBucket);

      if (entryBlockerSamples.length < 50) {
        entryBlockerSamples.push({
          timestamp: log.timestamp,
          agent: log.agent,
          action,
          symbol: symbol?.toUpperCase() ?? null,
          reason,
          confidence: asNumber(log.confidence),
          quality: asString(log.quality),
          source_count: asNumber(log.source_count),
          min_signal_consensus: asNumber(log.min_signal_consensus),
          average_sentiment: asNumber(log.average_sentiment),
          bullish_signals: asNumber(log.bullish_signals),
          bearish_signals: asNumber(log.bearish_signals),
          remaining_minutes: asNumber(log.remaining_minutes),
          spread_pct: asNumber(log.spread_pct),
          max_spread_pct: asNumber(log.max_spread_pct),
          bucket: asString(log.bucket),
          feature: asString(log.feature),
          win_rate: asNumber(log.win_rate),
          total_pnl_usd: asNumber(log.total_pnl_usd),
        });
      }
    }

    if (exitBlockerPatterns.some((pattern) => action.includes(pattern))) {
      const current = exitBlockers.get(action) ?? { action, count: 0, symbols: new Set<string>() };
      current.count += 1;
      if (symbol) current.symbols.add(symbol.toUpperCase());
      exitBlockers.set(action, current);
    }
  }

  const serialize = (map: Map<string, { action: string; count: number; symbols: Set<string> }>) =>
    [...map.values()]
      .map((bucket) => ({
        action: bucket.action,
        count: bucket.count,
        symbols: [...bucket.symbols].sort().slice(0, 20),
      }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
      .slice(0, 30);

  const serializeReasons = (
    map: Map<string, { action: string; reason: string; count: number; symbols: Set<string> }>
  ) =>
    [...map.values()]
      .map((bucket) => ({
        action: bucket.action,
        reason: bucket.reason,
        count: bucket.count,
        symbols: [...bucket.symbols].sort().slice(0, 20),
      }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action) || a.reason.localeCompare(b.reason))
      .slice(0, 30);
  const serializeMissedReasons = (
    map: Map<
      string,
      {
        action: string;
        reason: string;
        evaluated: number;
        wouldHaveWon: number;
        wouldHaveLost: number;
        symbols: Set<string>;
      }
    >
  ) =>
    [...map.values()]
      .map((bucket) => ({
        action: bucket.action,
        reason: bucket.reason,
        evaluated: bucket.evaluated,
        would_have_won: bucket.wouldHaveWon,
        would_have_lost: bucket.wouldHaveLost,
        symbols: [...bucket.symbols].sort().slice(0, 20),
      }))
      .sort(
        (a, b) =>
          b.would_have_won - a.would_have_won ||
          b.evaluated - a.evaluated ||
          a.reason.localeCompare(b.reason) ||
          a.action.localeCompare(b.action)
      )
      .slice(0, 20);

  const topEntryBlockers = serialize(entryBlockers);
  const topEntryReasons = serializeReasons(entryBlockerReasons);
  const dominantBlocker = topEntryReasons[0] ?? topEntryBlockers[0] ?? null;
  const diagnosisHints: string[] = [];
  if (buyExecuted + buySubmitted + buyDeferred === 0) {
    if (analystSkippedCount > 0 && analystCompleteCount === 0) {
      diagnosisHints.push("analyst_not_running_or_market_closed");
    }
    if (signalResearchCount === 0) {
      diagnosisHints.push(
        signalResearchNoCandidates > 0 ? "no_signal_research_candidates" : "no_recent_signal_research"
      );
    }
    if (signalResearchBuyCount > 0 && strategyEntryCandidates === 0) {
      diagnosisHints.push("researched_buy_not_converting_to_strategy_entries");
    }
    if (strategyEntryCandidates > 0) {
      diagnosisHints.push("strategy_entries_created_but_not_executed");
    }
    if (analystBuyRecommendations > 0 && analystBuyRecommendationsAboveThreshold === 0) {
      diagnosisHints.push("analyst_buy_recommendations_below_confidence_threshold");
    }
    if (dominantBlocker) {
      const action = asString((dominantBlocker as Record<string, unknown>).action) ?? "";
      const reason = asString((dominantBlocker as Record<string, unknown>).reason) ?? "";
      if (action.includes("no_signals")) diagnosisHints.push("check_data_gatherers_and_signal_sources");
      else if (action.includes("no_capacity")) diagnosisHints.push("max_positions_or_pending_orders_are_full");
      else if (reason === "low_confidence")
        diagnosisHints.push("min_analyst_confidence_may_be_too_strict_for_current_signals");
      else if (reason === "low_entry_quality") diagnosisHints.push("min_entry_quality_may_be_too_strict");
      else if (reason === "insufficient_catalysts") diagnosisHints.push("min_entry_catalysts_may_be_too_strict");
      else if (reason === "weak_signal_consensus") diagnosisHints.push("signals_are_mixed_or_bearish");
      else if (reason === "low_signal_consensus") diagnosisHints.push("entry_signal_consensus_is_below_minimum");
      else if (reason === "stale_research") diagnosisHints.push("research_cache_is_stale_before_entry");
      else if (action.includes("timing_gate")) diagnosisHints.push("entry_timing_gate_is_blocking_entries");
      else if (action.includes("recent_sell_cooldown")) diagnosisHints.push("recent_sell_cooldown_is_blocking_reentry");
      else if (action.includes("notional_too_small")) diagnosisHints.push("cash_or_position_sizing_is_too_small");
    }
  }

  return {
    window: {
      logs: logs.length,
      actions: [...actionCounts.entries()]
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
        .slice(0, 40),
    },
    entry_pipeline: {
      buys_executed: buyExecuted,
      buys_submitted: buySubmitted,
      buys_deferred: buyDeferred,
      signal_researched: signalResearchCount,
      signal_research_buy: signalResearchBuyCount,
      signal_research_wait: signalResearchWaitCount,
      signal_research_skip: signalResearchSkipCount,
      signal_research_no_candidates: signalResearchNoCandidates,
      entry_selection_cycles: entrySelectionCycles,
      researched_buy_available: researchedBuyAvailable,
      strategy_entry_candidates: strategyEntryCandidates,
      analyst_complete: analystCompleteCount,
      analyst_skipped: analystSkippedCount,
      analyst_buy_recommendations: analystBuyRecommendations,
      analyst_buy_recommendations_above_threshold: analystBuyRecommendationsAboveThreshold,
      missed_entry_evaluated: missedEntryEvaluated,
      missed_entry_would_have_won: missedEntryWouldHaveWon,
      missed_entry_would_have_lost: missedEntryWouldHaveLost,
      missed_entry_reasons: serializeMissedReasons(missedEntryReasons),
      analyst_skipped_reasons: [...analystSkippedReasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      dominant_entry_blocker: dominantBlocker,
      diagnosis_hints: [...new Set(diagnosisHints)],
    },
    entry_blockers: topEntryBlockers,
    entry_blocker_reasons: topEntryReasons,
    entry_blocker_samples: entryBlockerSamples,
    exit_blockers: serialize(exitBlockers),
  };
}

function summarizeAdaptivePerformanceBlocks(state: AgentState): Record<string, unknown> {
  const symbolBlocks = Object.values(state.entryPerformanceBlocks ?? {});
  const featureBlocks = Object.values(state.entryFeaturePerformanceBlocks ?? {});
  const serialize = (blocks: unknown[]) =>
    blocks
      .filter((block): block is Record<string, unknown> => block !== null && typeof block === "object")
      .map((block) => ({
        key: asString(block.symbol) ?? asString(block.feature) ?? "unknown",
        trades: asNumber(block.trades) ?? 0,
        wins: asNumber(block.wins) ?? 0,
        losses: asNumber(block.losses) ?? 0,
        win_rate: asNumber(block.winRate) ?? 0,
        total_pnl_usd: asNumber(block.totalPnlUsd) ?? 0,
        updated_at: asString(block.updatedAt),
      }))
      .sort((a, b) => a.win_rate - b.win_rate || b.trades - a.trades || a.key.localeCompare(b.key))
      .slice(0, 20);

  return {
    enabled: state.config.adaptive_performance_block_enabled ?? true,
    refreshed_at: state.entryPerformanceBlocksRefreshedAt
      ? new Date(state.entryPerformanceBlocksRefreshedAt).toISOString()
      : null,
    symbol_block_count: symbolBlocks.length,
    feature_block_count: featureBlocks.length,
    symbols: serialize(symbolBlocks),
    features: serialize(featureBlocks),
  };
}

export function pruneSignalResearchMap(
  signalResearch: Record<string, ResearchResult>,
  nowMs = Date.now(),
  maxAgeMs = 12 * 60 * 60 * 1000,
  maxEntries = 40
): Record<string, ResearchResult> {
  const deduped = new Map<string, ResearchResult>();

  for (const [key, research] of Object.entries(signalResearch)) {
    if (nowMs - research.timestamp > maxAgeMs) continue;
    const normalizedKey = normalizeCryptoSymbol(research.symbol || key);
    const current = deduped.get(normalizedKey);
    if (!current || research.timestamp > current.timestamp) {
      deduped.set(normalizedKey, { ...research, symbol: normalizedKey });
    }
  }

  return Object.fromEntries(
    [...deduped.entries()].sort(([, a], [, b]) => b.timestamp - a.timestamp).slice(0, maxEntries)
  );
}

export function buildTradeReviewSummary(
  rows: TradeReviewRow[],
  snapshots: Record<string, unknown>
): Record<string, unknown> {
  const bySide = new Map<string, TradeReviewBucket>();
  const bySymbol = new Map<string, TradeReviewBucket>();
  const byAssetClass = new Map<string, TradeReviewBucket>();
  const byPortfolioBucket = new Map<string, TradeReviewBucket>();
  const byRegime = new Map<string, TradeReviewBucket>();
  const byConfidence = new Map<string, TradeReviewBucket>();
  const byEntryQuality = new Map<string, TradeReviewBucket>();
  const byRedFlags = new Map<string, TradeReviewBucket>();
  const byCatalysts = new Map<string, TradeReviewBucket>();
  const bySources = new Map<string, TradeReviewBucket>();
  const bySignalConsensus = new Map<string, TradeReviewBucket>();
  const byEntryPath = new Map<string, TradeReviewBucket>();
  const byEntrySelectionScore = new Map<string, TradeReviewBucket>();
  const byEntrySpreadPct = new Map<string, TradeReviewBucket>();
  const byEntryFillDelay = new Map<string, TradeReviewBucket>();
  const byEntryQuoteSlippagePct = new Map<string, TradeReviewBucket>();
  const byEntryPriceChangePct = new Map<string, TradeReviewBucket>();
  const byResearchConfirmation = new Map<string, TradeReviewBucket>();
  const byResearchAge = new Map<string, TradeReviewBucket>();
  const byMarketRegime = new Map<string, TradeReviewBucket>();
  const bySizeMultiplier = new Map<string, TradeReviewBucket>();
  const byEntrySession = new Map<string, TradeReviewBucket>();
  const byEntryWeekday = new Map<string, TradeReviewBucket>();
  const byOptionDte = new Map<string, TradeReviewBucket>();
  const byOptionDelta = new Map<string, TradeReviewBucket>();
  const byOptionType = new Map<string, TradeReviewBucket>();
  const byCryptoMomentum = new Map<string, TradeReviewBucket>();
  const byHoldTime = new Map<string, TradeReviewBucket>();
  const byPnlPct = new Map<string, TradeReviewBucket>();
  const byMfePct = new Map<string, TradeReviewBucket>();
  const byMaePct = new Map<string, TradeReviewBucket>();
  const byGivebackPct = new Map<string, TradeReviewBucket>();
  const byExitEfficiencyPct = new Map<string, TradeReviewBucket>();
  const byExitReason = new Map<string, TradeReviewBucket>();
  const pnlPctValues: number[] = [];
  const exitEfficiencyValues: number[] = [];
  const closedOutcomeSequence: Array<{ outcome: string; pnl_usd: number; timestamp: number }> = [];
  const closedConfidenceValues: number[] = [];
  let closedTrades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let totalPnlUsd = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let winPnlUsd = 0;
  let lossPnlUsd = 0;

  for (const row of rows) {
    const outcome = outcomeOf(row);
    if (outcome === "open") openTrades += 1;
    else closedTrades += 1;
    if (outcome === "win") wins += 1;
    if (outcome === "loss") losses += 1;
    if (outcome === "scratch") scratches += 1;

    const pnlUsd = asNumber(row.pnl_usd) ?? 0;
    if (outcome !== "open") {
      closedOutcomeSequence.push({ outcome, pnl_usd: pnlUsd, timestamp: tradeReviewEventTime(row) });
    }
    totalPnlUsd += pnlUsd;
    if (outcome === "win") {
      grossProfitUsd += Math.max(0, pnlUsd);
      winPnlUsd += pnlUsd;
    }
    if (outcome === "loss") {
      grossLossUsd += Math.abs(Math.min(0, pnlUsd));
      lossPnlUsd += pnlUsd;
    }
    const pnlPct = asNumber(row.pnl_pct);
    if (pnlPct !== null) pnlPctValues.push(pnlPct);

    const snapshotKey = String(row.trade_id || row.journal_id || "");
    const snapshot = snapshotKey ? snapshots[snapshotKey] : undefined;
    const signals = parseJsonObject(row.signals_json);
    const technicals = parseJsonObject(row.technicals_json);
    const featureSource = { row, signals, technicals, snapshot };

    const side = asString(row.side)?.toLowerCase() ?? "unknown";
    const symbol = asString(row.symbol)?.toUpperCase() ?? "unknown";
    const assetClass = tradeAssetClass(featureSource, symbol);
    const portfolioBucket = symbol === "unknown" ? "unknown" : inferPortfolioBucket(symbol, []);
    const parsedOption = assetClass === "options" ? parseOccOptionSymbol(symbol) : null;
    const confidence = firstNestedNumber(featureSource, ["confidence", "analyst_confidence", "research_confidence"]);
    if (outcome !== "open" && confidence !== null) closedConfidenceValues.push(confidence);
    const entryQuality = firstNestedString(featureSource, ["entry_quality", "quality"])?.toLowerCase() ?? "unknown";
    const redFlags = firstNestedCount(featureSource, ["red_flags", "material_red_flags", "red_flag_count"]);
    const catalysts = firstNestedCount(featureSource, ["catalysts", "catalyst_count"]);
    const sources = firstNestedCount(featureSource, ["sources", "signal_sources", "source_count"]);
    const signalConsensus = firstNestedString(featureSource, ["signal_consensus_state"])?.toLowerCase() ?? "unknown";
    const entryPath = firstNestedString(featureSource, ["entry_path"])?.toLowerCase() ?? "unknown";
    const entrySelectionScore = firstNestedNumber(featureSource, ["entry_selection_score"]);
    const entrySpreadPct = firstNestedNumber(featureSource, [
      "entry_spread_pct",
      "spread_pct",
      "quote_spread_pct",
      "bid_ask_spread_pct",
    ]);
    const explicitEntryFillDelay = firstNestedNumber(featureSource, [
      "entry_fill_delay_minutes",
      "fill_delay_minutes",
      "order_fill_delay_minutes",
    ]);
    const tradeCreatedAt = firstNestedString(featureSource, ["trade_created_at", "submitted_at", "created_at"]);
    const entryAt = firstNestedString(featureSource, ["entry_at", "filled_at"]);
    const computedEntryFillDelay =
      explicitEntryFillDelay ??
      (tradeCreatedAt && entryAt ? (new Date(entryAt).getTime() - new Date(tradeCreatedAt).getTime()) / 60_000 : null);
    const entryFillDelay =
      computedEntryFillDelay !== null && Number.isFinite(computedEntryFillDelay) && computedEntryFillDelay >= 0
        ? computedEntryFillDelay
        : null;
    const filledAvgPrice = firstNestedNumber(featureSource, ["filled_avg_price", "entry_price"]);
    const quoteAsk = firstNestedNumber(featureSource, ["entry_quote_ask", "quote_ask", "ask_price"]);
    const quoteMid = firstNestedNumber(featureSource, ["entry_quote_mid", "quote_mid", "mid_price"]);
    const quoteReferencePrice = quoteAsk ?? quoteMid;
    const explicitEntryQuoteSlippagePct = firstNestedNumber(featureSource, [
      "entry_slippage_pct",
      "entry_quote_slippage_pct",
      "quote_slippage_pct",
    ]);
    const entryQuoteSlippagePct =
      explicitEntryQuoteSlippagePct ??
      (filledAvgPrice !== null && quoteReferencePrice !== null && quoteReferencePrice > 0
        ? ((filledAvgPrice - quoteReferencePrice) / quoteReferencePrice) * 100
        : null);
    const entryPriceChangePct = firstNestedNumber(featureSource, [
      "entry_price_change_pct",
      "entry_change_pct",
      "change_pct",
      "daily_change_pct",
    ]);
    const researchConfirmed = firstNestedBoolean(featureSource, ["research_confirmed"]);
    const researchAge = firstNestedNumber(featureSource, ["research_age_minutes"]);
    const marketRegimeAllowed = firstNestedBoolean(featureSource, ["market_regime_allowed"]);
    const marketRegimeAverage = firstNestedNumber(featureSource, ["market_regime_average_sentiment"]);
    const marketRegimeThreshold = firstNestedNumber(featureSource, ["market_regime_threshold"]) ?? 0.5;
    const sizeMultiplier = firstNestedNumber(featureSource, ["size_multiplier"]);
    const entryDate = entryDateFromFeatureSource(featureSource);
    const entrySession = firstNestedString(featureSource, ["entry_session"])?.toLowerCase();
    const entryWeekday = firstNestedString(featureSource, ["entry_weekday"]);
    const optionDte =
      assetClass === "options"
        ? (firstNestedNumber(featureSource, ["dte", "option_dte"]) ??
          (parsedOption && entryDate
            ? Math.ceil((new Date(`${parsedOption.expiration}T00:00:00Z`).getTime() - entryDate.getTime()) / 86_400_000)
            : null))
        : null;
    const optionDelta =
      assetClass === "options" ? firstNestedNumber(featureSource, ["delta", "option_delta", "abs_delta"]) : null;
    const optionType =
      assetClass === "options"
        ? (firstNestedString(featureSource, ["option_type", "optionType", "contract_type"])?.toLowerCase() ??
          parsedOption?.optionType ??
          "unknown")
        : "unknown";
    const cryptoMomentum =
      assetClass === "crypto" ? firstNestedNumber(featureSource, ["momentum", "crypto_momentum"]) : null;
    const mfePct = firstNestedNumber(featureSource, ["mfe_pct", "max_favorable_excursion_pct"]);
    const maePct = firstNestedNumber(featureSource, ["mae_pct", "max_adverse_excursion_pct"]);
    const givebackPct = mfePct === null || pnlPct === null ? null : Math.max(0, mfePct - Math.max(0, pnlPct));
    const exitEfficiencyPct =
      mfePct === null || mfePct <= 0 || pnlPct === null ? null : Math.max(0, Math.min(100, (pnlPct / mfePct) * 100));
    if (exitEfficiencyPct !== null) exitEfficiencyValues.push(exitEfficiencyPct);
    const regimeTags = asString(row.regime_tags) ?? "unknown";
    const exitReason = exitReasonBucket(row);

    updateTradeReviewBucket(bySide, side, row);
    updateTradeReviewBucket(bySymbol, symbol, row);
    updateTradeReviewBucket(byAssetClass, assetClass, row);
    updateTradeReviewBucket(byPortfolioBucket, portfolioBucket, row);
    updateTradeReviewBucket(byConfidence, confidenceBucket(confidence), row);
    updateTradeReviewBucket(byEntryQuality, entryQuality, row);
    updateTradeReviewBucket(byRedFlags, redFlags === null ? "unknown" : String(redFlags), row);
    updateTradeReviewBucket(byCatalysts, catalysts === null ? "unknown" : String(catalysts), row);
    updateTradeReviewBucket(bySources, sources === null ? "unknown" : String(sources), row);
    updateTradeReviewBucket(bySignalConsensus, signalConsensus, row);
    updateTradeReviewBucket(byEntryPath, entryPath, row);
    updateTradeReviewBucket(byEntrySelectionScore, entrySelectionScoreBucket(entrySelectionScore), row);
    updateTradeReviewBucket(byEntrySpreadPct, entrySpreadBucket(entrySpreadPct), row);
    updateTradeReviewBucket(byEntryFillDelay, entryFillDelayBucket(entryFillDelay), row);
    updateTradeReviewBucket(byEntryQuoteSlippagePct, entryQuoteSlippageBucket(entryQuoteSlippagePct), row);
    updateTradeReviewBucket(byEntryPriceChangePct, entryPriceChangeBucket(entryPriceChangePct), row);
    updateTradeReviewBucket(
      byResearchConfirmation,
      researchConfirmed === false ? "unconfirmed" : researchConfirmed === true ? "confirmed" : "unknown",
      row
    );
    updateTradeReviewBucket(byResearchAge, researchAgeBucket(researchAge), row);
    updateTradeReviewBucket(
      byMarketRegime,
      marketRegimeAllowed === false
        ? "blocked"
        : marketRegimeAverage !== null && marketRegimeAverage < marketRegimeThreshold
          ? "weak_exceptional"
          : marketRegimeAverage === null
            ? "unknown"
            : "normal",
      row
    );
    updateTradeReviewBucket(bySizeMultiplier, sizeMultiplierBucket(sizeMultiplier), row);
    updateTradeReviewBucket(byEntrySession, entrySession ?? entrySessionBucket(entryDate), row);
    updateTradeReviewBucket(byEntryWeekday, entryWeekday ?? entryWeekdayBucket(entryDate), row);
    if (assetClass === "options") {
      updateTradeReviewBucket(byOptionDte, optionDteBucket(optionDte), row);
      updateTradeReviewBucket(byOptionDelta, optionDeltaBucket(optionDelta), row);
      updateTradeReviewBucket(
        byOptionType,
        optionType === "put" || optionType === "p"
          ? "put"
          : optionType === "call" || optionType === "c"
            ? "call"
            : "unknown",
        row
      );
    }
    if (assetClass === "crypto") {
      updateTradeReviewBucket(byCryptoMomentum, cryptoMomentumBucket(cryptoMomentum), row);
    }
    updateTradeReviewBucket(byHoldTime, holdBucket(asNumber(row.hold_duration_mins)), row);
    updateTradeReviewBucket(byPnlPct, pnlBucket(pnlPct), row);
    updateTradeReviewBucket(byMfePct, mfeBucket(mfePct), row);
    updateTradeReviewBucket(byMaePct, maeBucket(maePct), row);
    updateTradeReviewBucket(byGivebackPct, givebackBucket(givebackPct), row);
    updateTradeReviewBucket(byExitEfficiencyPct, exitEfficiencyBucket(exitEfficiencyPct), row);
    if (exitReason) updateTradeReviewBucket(byExitReason, exitReason, row);

    for (const tag of regimeTags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)) {
      updateTradeReviewBucket(byRegime, tag, row);
    }
  }

  const sortedPnlPct = [...pnlPctValues].sort((a, b) => a - b);
  let medianPnlPct: number | null = null;
  if (sortedPnlPct.length > 0) {
    const midpoint = Math.floor(sortedPnlPct.length / 2);
    medianPnlPct =
      sortedPnlPct.length % 2 === 1
        ? sortedPnlPct[midpoint]!
        : (sortedPnlPct[midpoint - 1]! + sortedPnlPct[midpoint]!) / 2;
  }

  const bucketGroups = {
    by_side: finalizeBuckets(bySide),
    by_symbol: finalizeBuckets(bySymbol),
    by_asset_class: finalizeBuckets(byAssetClass),
    by_portfolio_bucket: finalizeBuckets(byPortfolioBucket),
    by_regime: finalizeBuckets(byRegime),
    by_confidence: finalizeBuckets(byConfidence),
    by_entry_quality: finalizeBuckets(byEntryQuality),
    by_red_flags: finalizeBuckets(byRedFlags),
    by_catalysts: finalizeBuckets(byCatalysts),
    by_signal_sources: finalizeBuckets(bySources),
    by_signal_consensus: finalizeBuckets(bySignalConsensus),
    by_entry_path: finalizeBuckets(byEntryPath),
    by_entry_selection_score: finalizeBuckets(byEntrySelectionScore),
    by_entry_spread_pct: finalizeBuckets(byEntrySpreadPct),
    by_entry_fill_delay: finalizeBuckets(byEntryFillDelay),
    by_entry_quote_slippage_pct: finalizeBuckets(byEntryQuoteSlippagePct),
    by_entry_price_change_pct: finalizeBuckets(byEntryPriceChangePct),
    by_research_confirmation: finalizeBuckets(byResearchConfirmation),
    by_research_age: finalizeBuckets(byResearchAge),
    by_market_regime: finalizeBuckets(byMarketRegime),
    by_size_multiplier: finalizeBuckets(bySizeMultiplier),
    by_entry_session: finalizeBuckets(byEntrySession),
    by_entry_weekday: finalizeBuckets(byEntryWeekday),
    by_option_dte: finalizeBuckets(byOptionDte),
    by_option_delta: finalizeBuckets(byOptionDelta),
    by_option_type: finalizeBuckets(byOptionType),
    by_crypto_momentum: finalizeBuckets(byCryptoMomentum),
    by_hold_time: finalizeBuckets(byHoldTime),
    by_pnl_pct: finalizeBuckets(byPnlPct),
    by_mfe_pct: finalizeBuckets(byMfePct),
    by_mae_pct: finalizeBuckets(byMaePct),
    by_giveback_pct: finalizeBuckets(byGivebackPct),
    by_exit_efficiency_pct: finalizeBuckets(byExitEfficiencyPct),
    by_exit_reason: finalizeBuckets(byExitReason),
  };

  const avgWinUsd = wins > 0 ? winPnlUsd / wins : null;
  const avgLossUsd = losses > 0 ? lossPnlUsd / losses : null;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const avgConfidence = closedConfidenceValues.length
    ? closedConfidenceValues.reduce((sum, value) => sum + value, 0) / closedConfidenceValues.length
    : null;
  const confidenceCalibrationGap = avgConfidence === null ? null : avgConfidence - winRate;
  const profitFactor =
    grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? Number.POSITIVE_INFINITY : null;
  const expectancyUsd = closedTrades > 0 ? totalPnlUsd / closedTrades : null;
  const payoffRatio =
    avgWinUsd !== null && avgLossUsd !== null && avgLossUsd !== 0 ? avgWinUsd / Math.abs(avgLossUsd) : null;
  const chronologicalClosedTrades = [...closedOutcomeSequence].sort((a, b) => a.timestamp - b.timestamp);
  let maxConsecutiveLosses = 0;
  let runningLosses = 0;
  for (const trade of chronologicalClosedTrades) {
    if (trade.outcome === "loss") {
      runningLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, runningLosses);
    } else if (trade.outcome === "win") {
      runningLosses = 0;
    }
  }
  const currentConsecutiveLosses = runningLosses;
  const recentClosedTrades = chronologicalClosedTrades.slice(-10);
  const recentWins = recentClosedTrades.filter((trade) => trade.outcome === "win").length;
  const recentLosses = recentClosedTrades.filter((trade) => trade.outcome === "loss").length;
  const recentTotalPnlUsd = recentClosedTrades.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const recentWinRate = recentWins + recentLosses > 0 ? recentWins / (recentWins + recentLosses) : null;

  const weakBuckets = Object.entries(bucketGroups)
    .flatMap(([group, buckets]) =>
      buckets
        .filter((bucket) => bucket.trades >= 3 && bucket.losses > bucket.wins)
        .map((bucket) => ({
          group,
          key: bucket.key,
          trades: bucket.trades,
          win_rate: bucket.win_rate,
          total_pnl_usd: bucket.total_pnl_usd,
        }))
    )
    .sort((a, b) => a.win_rate - b.win_rate || b.trades - a.trades)
    .slice(0, 50);

  return {
    totals: {
      rows: rows.length,
      closed_trades: closedTrades,
      open_trades: openTrades,
      wins,
      losses,
      scratches,
      win_rate: Number(winRate.toFixed(4)),
      total_pnl_usd: Number(totalPnlUsd.toFixed(2)),
      gross_profit_usd: Number(grossProfitUsd.toFixed(2)),
      gross_loss_usd: Number(grossLossUsd.toFixed(2)),
      profit_factor:
        profitFactor === null ? null : Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(4)) : "infinite",
      expectancy_usd: expectancyUsd === null ? null : Number(expectancyUsd.toFixed(4)),
      avg_win_usd: avgWinUsd === null ? null : Number(avgWinUsd.toFixed(4)),
      avg_loss_usd: avgLossUsd === null ? null : Number(avgLossUsd.toFixed(4)),
      payoff_ratio: payoffRatio === null ? null : Number(payoffRatio.toFixed(4)),
      avg_confidence: avgConfidence === null ? null : Number(avgConfidence.toFixed(4)),
      confidence_calibration_gap:
        confidenceCalibrationGap === null ? null : Number(confidenceCalibrationGap.toFixed(4)),
      max_consecutive_losses: maxConsecutiveLosses,
      current_consecutive_losses: currentConsecutiveLosses,
      recent_closed_trades: recentClosedTrades.length,
      recent_win_rate: recentWinRate === null ? null : Number(recentWinRate.toFixed(4)),
      recent_total_pnl_usd: Number(recentTotalPnlUsd.toFixed(2)),
      avg_exit_efficiency_pct: exitEfficiencyValues.length
        ? Number((exitEfficiencyValues.reduce((sum, value) => sum + value, 0) / exitEfficiencyValues.length).toFixed(4))
        : null,
      avg_pnl_pct: pnlPctValues.length
        ? Number((pnlPctValues.reduce((sum, value) => sum + value, 0) / pnlPctValues.length).toFixed(4))
        : null,
      median_pnl_pct: medianPnlPct === null ? null : Number(medianPnlPct.toFixed(4)),
    },
    buckets: bucketGroups,
    diagnostics: {
      weak_buckets: weakBuckets,
      note: "Buckets are derived from journal rows plus optional R2 snapshots. Use weak_buckets to tune entry quality, confidence, catalyst, source, timing, and regime thresholds after export.",
    },
  };
}

function getNestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getNestedArray(source: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = source[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}

export function buildDeferredBuyJournalSignals(
  snapshot: unknown,
  params: { reason: string; alpaca_order_id: string; order_status: string }
): Record<string, unknown> {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : {};
  const metadata = getNestedRecord(source, "metadata") ?? {};
  const policy = getNestedRecord(source, "policy");
  const snapshotReason = asString(source.reason);

  return {
    reason: snapshotReason || params.reason,
    ...metadata,
    ...(policy ? { policy } : {}),
    alpaca_order_id: params.alpaca_order_id,
    order_status: params.order_status,
    reconciled_from_deferred_buy: true,
  };
}

export function shouldCancelStaleDeferredBuyOrder(
  order: { status?: string; submitted_at?: string | null; created_at?: string | null; updated_at?: string | null },
  maxAgeMinutes: number,
  nowMs = Date.now()
): { cancel: boolean; ageMinutes: number | null } {
  const status = (order.status || "").toLowerCase();
  if (status === "filled" || status === "partially_filled" || status === "canceled" || status === "expired" || status === "rejected") {
    return { cancel: false, ageMinutes: null };
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return { cancel: false, ageMinutes: null };

  const submittedAt = order.submitted_at || order.created_at || order.updated_at;
  const submittedMs = submittedAt ? new Date(submittedAt).getTime() : NaN;
  if (!Number.isFinite(submittedMs)) return { cancel: false, ageMinutes: null };

  const ageMinutes = (nowMs - submittedMs) / 60_000;
  return { cancel: ageMinutes > maxAgeMinutes, ageMinutes: Number(Math.max(0, ageMinutes).toFixed(2)) };
}

export function shouldCancelStaleDeferredSellOrder(
  order: { status?: string; submitted_at?: string | null; created_at?: string | null; updated_at?: string | null },
  maxAgeMinutes: number,
  nowMs = Date.now()
): { cancel: boolean; ageMinutes: number | null } {
  const status = (order.status || "").toLowerCase();
  if (
    status === "filled" ||
    status === "partially_filled" ||
    status === "canceled" ||
    status === "expired" ||
    status === "rejected"
  ) {
    return { cancel: false, ageMinutes: null };
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return { cancel: false, ageMinutes: null };

  const submittedAt = order.submitted_at || order.created_at || order.updated_at;
  const submittedMs = submittedAt ? new Date(submittedAt).getTime() : NaN;
  if (!Number.isFinite(submittedMs)) return { cancel: false, ageMinutes: null };

  const ageMinutes = (nowMs - submittedMs) / 60_000;
  return { cancel: ageMinutes > maxAgeMinutes, ageMinutes: Number(Math.max(0, ageMinutes).toFixed(2)) };
}

export function isDeferredSellComplete(order: { status?: string }): boolean {
  return (order.status || "").toLowerCase() === "filled";
}

export function buildOptionsOrderFillSnapshot(
  order: { status?: string; filled_qty?: unknown; filled_avg_price?: unknown },
  fallbackPrice: number
): { status: string | undefined; filled_qty: number | null; filled_avg_price: number | null; filled_notional: number } {
  const filledQty = asNumber(order.filled_qty);
  const filledAvgPrice = asNumber(order.filled_avg_price);
  const usablePrice = filledAvgPrice ?? (Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null);

  return {
    status: order.status,
    filled_qty: filledQty !== null && filledQty > 0 ? filledQty : null,
    filled_avg_price: filledAvgPrice !== null && filledAvgPrice > 0 ? filledAvgPrice : null,
    filled_notional:
      filledQty !== null && filledQty > 0 && usablePrice !== null ? Number((filledQty * usablePrice * 100).toFixed(2)) : 0,
  };
}

export function buildTradeReviewTuningSuggestions(
  summary: Record<string, unknown>,
  runtimeSummary: Record<string, unknown>,
  config: AgentConfig
): TradeReviewTuningSuggestion[] {
  const totals = getNestedRecord(summary, "totals") ?? {};
  const diagnostics = getNestedRecord(summary, "diagnostics") ?? {};
  const runtimePipeline = getNestedRecord(runtimeSummary, "entry_pipeline") ?? {};
  const buckets = getNestedRecord(summary, "buckets") ?? {};
  const weakBuckets = getNestedArray(diagnostics, "weak_buckets");
  const exitReasonBuckets = getNestedArray(buckets, "by_exit_reason");
  const blockerReasons = getNestedArray(runtimeSummary, "entry_blocker_reasons");
  const exitBlockers = getNestedArray(runtimeSummary, "exit_blockers");
  const suggestions: TradeReviewTuningSuggestion[] = [];
  const seenTargets = new Set<string>();

  const addSuggestion = (suggestion: TradeReviewTuningSuggestion) => {
    const key = `${suggestion.direction}:${suggestion.target}:${suggestion.config_keys.join(",")}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    if (!suggestion.proposed_config_patch) {
      suggestions.push(suggestion);
      return;
    }

    const proposedConfig = { ...config, ...suggestion.proposed_config_patch };
    const validation = safeValidateAgentConfig(proposedConfig);
    if (validation.success) {
      suggestions.push(suggestion);
      return;
    }

    suggestions.push({
      ...suggestion,
      proposed_config_patch: undefined,
      evidence: {
        ...suggestion.evidence,
        invalid_config_patch: suggestion.proposed_config_patch,
        invalid_config_patch_issues: validation.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  };
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const closedTrades = asNumber(totals.closed_trades) ?? 0;
  const totalWinRate = asNumber(totals.win_rate) ?? 0;
  const expectancyUsd = asNumber(totals.expectancy_usd);
  const profitFactor = asNumber(totals.profit_factor);
  const payoffRatio = asNumber(totals.payoff_ratio);
  const avgConfidence = asNumber(totals.avg_confidence);
  const confidenceCalibrationGap = asNumber(totals.confidence_calibration_gap);
  const maxConsecutiveLosses = asNumber(totals.max_consecutive_losses) ?? 0;
  const currentConsecutiveLosses = asNumber(totals.current_consecutive_losses) ?? 0;
  const recentClosedTrades = asNumber(totals.recent_closed_trades) ?? 0;
  const recentWinRate = asNumber(totals.recent_win_rate);
  const recentTotalPnlUsd = asNumber(totals.recent_total_pnl_usd) ?? 0;
  if (closedTrades < 10) {
    addSuggestion({
      priority: "high",
      direction: "investigate",
      target: "sample_size",
      config_keys: [],
      evidence: { closed_trades: closedTrades, win_rate: totalWinRate },
      suggestion:
        "Collect more filled entry/exit outcomes before making broad threshold changes. Use runtime blockers for buy starvation, not win-rate tuning, until at least 10 closed trades exist.",
    });
  }

  if (
    closedTrades >= 10 &&
    ((expectancyUsd !== null && expectancyUsd < 0) || (profitFactor !== null && profitFactor < 1))
  ) {
    addSuggestion({
      priority: "high",
      direction: "tighten",
      target: "negative_trade_expectancy",
      config_keys: [
        "take_profit_pct",
        "stop_loss_pct",
        "early_loss_exit_enabled",
        "early_loss_exit_pct",
        "early_loss_exit_max_hold_minutes",
        "profit_lock_activation_pct",
        "profit_lock_floor_pct",
        "trailing_stop_activation_pct",
        "trailing_stop_drawdown_pct",
      ],
      proposed_config_patch: {
        stop_loss_pct: clamp(Math.min(config.stop_loss_pct, 4), 1, 50),
        early_loss_exit_enabled: true,
        early_loss_exit_pct: clamp(Math.min(config.early_loss_exit_pct ?? 2.5, 2), 0, 50),
        early_loss_exit_max_hold_minutes: clamp(Math.min(config.early_loss_exit_max_hold_minutes ?? 90, 75), 0, 1440),
        profit_lock_stop_enabled: true,
        profit_lock_activation_pct: clamp(
          Math.min(config.profit_lock_activation_pct ?? 3, 3),
          0,
          Math.max(0, (config.breakeven_stop_activation_pct ?? 4) - 0.05)
        ),
        profit_lock_floor_pct: clamp(Math.min(config.profit_lock_floor_pct ?? 0.5, 0.5), 0, 10),
        trailing_stop_enabled: true,
        trailing_stop_activation_pct: clamp(Math.min(config.trailing_stop_activation_pct ?? 6, 5), 0, 100),
        trailing_stop_drawdown_pct: clamp(Math.min(config.trailing_stop_drawdown_pct ?? 3, 2.5), 0.1, 100),
      },
      evidence: {
        closed_trades: closedTrades,
        expectancy_usd: expectancyUsd,
        profit_factor: profitFactor,
        payoff_ratio: payoffRatio,
        win_rate: totalWinRate,
      },
      suggestion:
        "Closed-trade expectancy is negative. Tighten downside and preserve smaller winners before raising exposure; inspect whether losses are too large relative to average winners.",
    });
  }

  if (
    closedTrades >= 10 &&
    avgConfidence !== null &&
    confidenceCalibrationGap !== null &&
    avgConfidence >= 0.7 &&
    confidenceCalibrationGap >= 0.25 &&
    totalWinRate < 0.55
  ) {
    addSuggestion({
      priority: "high",
      direction: "tighten",
      target: "confidence_calibration_mismatch",
      config_keys: [
        "analyst_buy_requires_research_confirmation",
        "min_entry_signal_sources",
        "min_entry_catalysts",
        "max_entry_red_flags",
        "llm_size_conviction_scaling",
        "llm_size_medium_confidence_multiplier",
        "llm_size_low_confidence_multiplier",
      ],
      proposed_config_patch: {
        analyst_buy_requires_research_confirmation: true,
        min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
        min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1),
        max_entry_red_flags: 0,
        llm_size_conviction_scaling: true,
        llm_size_medium_confidence_multiplier: clamp(
          Math.min(config.llm_size_medium_confidence_multiplier ?? 0.7, 0.6),
          0.1,
          1
        ),
        llm_size_low_confidence_multiplier: clamp(
          Math.min(config.llm_size_low_confidence_multiplier ?? 0.4, 0.35),
          0.1,
          1
        ),
      },
      evidence: {
        closed_trades: closedTrades,
        win_rate: totalWinRate,
        avg_confidence: avgConfidence,
        confidence_calibration_gap: confidenceCalibrationGap,
      },
      suggestion:
        "Average model confidence is far above realized win rate. Treat confidence as poorly calibrated until more data improves: require independent confirmation, concrete catalysts, zero red flags, and keep confidence-based sizing conservative.",
    });
  }

  if (
    closedTrades >= 5 &&
    (currentConsecutiveLosses >= 3 ||
      maxConsecutiveLosses >= 4 ||
      (recentClosedTrades >= 5 && recentWinRate !== null && recentWinRate < 0.3 && recentTotalPnlUsd < 0))
  ) {
    addSuggestion({
      priority: "high",
      direction: "tighten",
      target: "loss_streak_risk_control",
      config_keys: [
        "cooldown_minutes_after_loss",
        "max_daily_loss_pct",
        "adaptive_performance_block_enabled",
        "adaptive_performance_min_trades",
        "adaptive_performance_min_win_rate",
        "max_daily_entry_orders",
        "min_minutes_between_entries",
        "position_size_pct_of_cash",
      ],
      proposed_config_patch: {
        cooldown_minutes_after_loss: Math.max(
          config.cooldown_minutes_after_loss ?? 30,
          currentConsecutiveLosses >= 3 ? 60 : 45
        ),
        max_daily_loss_pct: clamp(Math.min(config.max_daily_loss_pct ?? 0.02, 0.0125), 0.001, 1),
        adaptive_performance_block_enabled: true,
        adaptive_performance_min_trades: clamp(Math.min(config.adaptive_performance_min_trades ?? 3, 3), 1, 100),
        adaptive_performance_min_win_rate: clamp(Math.max(config.adaptive_performance_min_win_rate ?? 0.35, 0.4), 0, 1),
        max_daily_entry_orders: Math.max(1, Math.min(config.max_daily_entry_orders ?? 8, 5)),
        min_minutes_between_entries: Math.max(config.min_minutes_between_entries ?? 5, 10),
        position_size_pct_of_cash: clamp(Math.min(config.position_size_pct_of_cash, 10), 1, 100),
      },
      evidence: {
        closed_trades: closedTrades,
        max_consecutive_losses: maxConsecutiveLosses,
        current_consecutive_losses: currentConsecutiveLosses,
        recent_closed_trades: recentClosedTrades,
        recent_win_rate: recentWinRate,
        recent_total_pnl_usd: recentTotalPnlUsd,
      },
      suggestion:
        "Recent results show a loss streak or very weak rolling win rate. Increase cooldown, lower daily loss tolerance, keep adaptive blocks active, and reduce base exposure until the rolling sample recovers.",
    });
  }

  const weakBucketPriority = (bucket: Record<string, unknown>): number => {
    const group = asString(bucket.group) ?? "unknown";
    const key = asString(bucket.key) ?? "unknown";
    if (group === "by_confidence" && (key === "<0.60" || key === "0.60-0.69")) return 0;
    if (group === "by_confidence" && (key === "0.80-0.89" || key === "0.90+")) return 1;
    if (group === "by_asset_class" && (key === "options" || key === "crypto")) return 1;
    if (group === "by_portfolio_bucket" && key !== "unknown" && !key.startsWith("individual:")) return 2;
    if (group === "by_option_dte" && (key === "<7d" || key === "7d..14d")) return 1;
    if (group === "by_option_delta" && (key === "<0.30" || key === "0.70+")) return 1;
    if (group === "by_option_type" && (key === "call" || key === "put")) return 2;
    if (group === "by_crypto_momentum" && (key === "<2%" || key === "8%+")) return 2;
    if (group === "by_entry_selection_score" && (key === "<0.85" || key === "0.85-0.94")) return 1;
    if (group === "by_entry_spread_pct" && (key === "0.80%..2%" || key === "2%+")) return 2;
    if (group === "by_entry_quote_slippage_pct" && (key === "0.25%..0.75%" || key === "0.75%+")) return 2;
    if (group === "by_entry_price_change_pct" && (key === "2%..5%" || key === "5%+")) return 3;
    if (group === "by_entry_fill_delay" && (key === "5m..30m" || key === "30m+")) return 3;
    if (group === "by_entry_quality" && (key === "fair" || key === "poor")) return 2;
    if (group === "by_research_confirmation" && key === "unconfirmed") return 3;
    if (group === "by_red_flags" && key !== "0" && key !== "unknown") return 4;
    if (group === "by_catalysts" && key === "0") return 5;
    if (group === "by_signal_sources" && (key === "0" || key === "1")) return 6;
    if (group === "by_signal_consensus" && (key === "mixed" || key === "weak_mixed")) return 7;
    if (group === "by_research_age" && key === ">60") return 8;
    if (group === "by_market_regime" && (key === "weak_exceptional" || key === "blocked")) return 9;
    if (group === "by_mfe_pct" && key === "<1%") return 10;
    if (group === "by_mae_pct" && (key === "<=-10%" || key === "-10%..-5%" || key === "-5%..-2%")) return 11;
    if (group === "by_giveback_pct" && (key === "3%..6%" || key === "6%+")) return 12;
    if (group === "by_exit_efficiency_pct" && (key === "<25%" || key === "25%..50%")) return 12;
    if (group === "by_pnl_pct" && (key === "<=-10%" || key === "-10%..-5%")) return 10;
    if (group === "by_hold_time" && (key === "4h-1d" || key === "1d-5d" || key === "5d+")) return 11;
    if (group === "by_entry_session" && (key === "open_30m" || key === "close_30m" || key === "after_hours")) return 12;
    if (group === "by_entry_weekday") return 13;
    if (key === "unknown") return 20;
    if (
      group === "by_symbol" ||
      group === "by_entry_path" ||
      group === "by_size_multiplier" ||
      group === "by_entry_spread_pct" ||
      group === "by_entry_quote_slippage_pct" ||
      group === "by_entry_price_change_pct" ||
      group === "by_entry_fill_delay" ||
      group === "by_portfolio_bucket" ||
      group === "by_asset_class" ||
      group === "by_option_dte" ||
      group === "by_option_delta" ||
      group === "by_option_type" ||
      group === "by_crypto_momentum"
    )
      return 14;
    return 15;
  };
  const prioritizedWeakBuckets = [...weakBuckets]
    .sort((a, b) => {
      const priorityDiff = weakBucketPriority(a) - weakBucketPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return (asNumber(a.total_pnl_usd) ?? 0) - (asNumber(b.total_pnl_usd) ?? 0);
    })
    .slice(0, 12);

  for (const bucket of exitReasonBuckets) {
    const key = asString(bucket.key) ?? "unknown";
    const trades = asNumber(bucket.trades) ?? 0;
    const wins = asNumber(bucket.wins) ?? 0;
    const losses = asNumber(bucket.losses) ?? 0;
    if (trades < 3 || losses <= wins) continue;

    const winRate = asNumber(bucket.win_rate) ?? 0;
    const totalPnlUsd = asNumber(bucket.total_pnl_usd) ?? 0;
    const priority: TradeReviewTuningSuggestion["priority"] = trades >= 5 || totalPnlUsd < -100 ? "high" : "medium";
    const evidence = { group: "by_exit_reason", key, trades, win_rate: winRate, total_pnl_usd: totalPnlUsd };

    if (key === "profit_lock") {
      const currentActivation = config.profit_lock_activation_pct ?? 3;
      const breakevenActivation = config.breakeven_stop_activation_pct ?? 4;
      const proposedActivation = clamp(currentActivation + 1, 0, Math.max(0, breakevenActivation - 0.05));
      const proposedFloor = clamp(Math.min(config.profit_lock_floor_pct ?? 0.5, 0.5, proposedActivation), 0, 10);
      addSuggestion({
        priority,
        direction: "investigate",
        target: "profit_lock_exit",
        config_keys: ["profit_lock_stop_enabled", "profit_lock_activation_pct", "profit_lock_floor_pct"],
        proposed_config_patch: {
          profit_lock_stop_enabled: true,
          profit_lock_activation_pct: Number(proposedActivation.toFixed(2)),
          profit_lock_floor_pct: Number(proposedFloor.toFixed(2)),
        },
        evidence,
        suggestion:
          "Profit-lock exits are losing more than winning. Inspect these snapshots; if exits are too early, delay the activation slightly and keep the floor conservative.",
      });
    } else if (key === "stop_loss") {
      const proposedConfidence = clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1);
      addSuggestion({
        priority,
        direction: "investigate",
        target: "stop_loss_exits",
        config_keys: ["stop_loss_pct", "min_analyst_confidence", "min_entry_quality"],
        proposed_config_patch: {
          min_analyst_confidence: Number(proposedConfidence.toFixed(2)),
          min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
        },
        evidence,
        suggestion:
          "Stop-loss exits are a weak bucket. Inspect whether losses share entry quality, confidence, or timing traits; prefer tightening entry selectivity before widening the stop.",
      });
    } else if (key === "sentiment_reversal_loss") {
      addSuggestion({
        priority,
        direction: "investigate",
        target: "sentiment_reversal_loss_exit",
        config_keys: [
          "sentiment_reversal_exit_enabled",
          "sentiment_reversal_loss_pct",
          "sentiment_reversal_threshold",
          "sentiment_reversal_min_sources",
        ],
        proposed_config_patch: {
          sentiment_reversal_exit_enabled: true,
          sentiment_reversal_loss_pct: clamp(Math.min(config.sentiment_reversal_loss_pct ?? 1.5, 1.25), 0, 50),
          sentiment_reversal_min_sources: Math.max(config.sentiment_reversal_min_sources ?? 1, 2),
        },
        evidence,
        suggestion:
          "Sentiment-reversal loss exits are underperforming. Verify that reversal signals are genuinely independent; tighten source confirmation and reduce allowed loss depth before trusting this exit.",
      });
    }
  }

  for (const bucket of prioritizedWeakBuckets) {
    const group = asString(bucket.group) ?? "unknown";
    const key = asString(bucket.key) ?? "unknown";
    const trades = asNumber(bucket.trades) ?? 0;
    const winRate = asNumber(bucket.win_rate) ?? 0;
    const totalPnlUsd = asNumber(bucket.total_pnl_usd) ?? 0;
    const priority: TradeReviewTuningSuggestion["priority"] = trades >= 5 || totalPnlUsd < -100 ? "high" : "medium";
    const evidence = { group, key, trades, win_rate: winRate, total_pnl_usd: totalPnlUsd };

    if (group === "by_confidence" && (key === "<0.60" || key === "0.60-0.69")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "low_confidence_entries",
        config_keys: ["min_analyst_confidence", "llm_size_low_confidence_multiplier"],
        proposed_config_patch: {
          min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1),
          llm_size_low_confidence_multiplier: clamp(
            Math.min(config.llm_size_low_confidence_multiplier ?? 0.4, 0.35),
            0.1,
            1
          ),
        },
        evidence,
        suggestion:
          "Low-confidence closed trades are underperforming. Keep or raise min_analyst_confidence, and keep low-confidence size scaling conservative.",
      });
    } else if (group === "by_confidence" && (key === "0.80-0.89" || key === "0.90+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "high_confidence_overfit",
        config_keys: [
          "analyst_buy_requires_research_confirmation",
          "max_entry_red_flags",
          "min_entry_catalysts",
          "min_entry_signal_sources",
          "llm_size_conviction_scaling",
          "llm_size_medium_confidence_multiplier",
        ],
        proposed_config_patch: {
          analyst_buy_requires_research_confirmation: true,
          max_entry_red_flags: 0,
          min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1),
          min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
          llm_size_conviction_scaling: true,
          llm_size_medium_confidence_multiplier: clamp(
            Math.min(config.llm_size_medium_confidence_multiplier ?? 0.7, 0.6),
            0.1,
            1
          ),
        },
        evidence,
        suggestion:
          "High-confidence trades are losing more than winning. Treat this as overconfidence risk: require research confirmation, zero red flags, stronger source/catalyst support, and avoid scaling size up on confidence alone.",
      });
    } else if (group === "by_asset_class" && key === "options") {
      const proposedOptionsMinDte = clamp(Math.max(config.options_min_dte ?? 7, 14), 1, 365);
      const proposedOptionsMaxDte = clamp(
        Math.max(proposedOptionsMinDte, Math.min(config.options_max_dte ?? 45, 45)),
        1,
        365
      );
      addSuggestion({
        priority,
        direction: "tighten",
        target: "options_asset_class_risk",
        config_keys: [
          "options_enabled",
          "options_min_confidence",
          "options_max_pct_per_trade",
          "options_max_spread_pct",
          "options_early_loss_exit_enabled",
          "options_early_loss_exit_pct",
          "options_early_loss_exit_max_hold_minutes",
          "options_stop_loss_pct",
          "options_min_dte",
          "options_max_dte",
        ],
        proposed_config_patch: {
          options_enabled: true,
          options_min_confidence: clamp(Math.max(config.options_min_confidence ?? 0.75, 0.8), 0, 1),
          options_max_pct_per_trade: clamp(Math.min(config.options_max_pct_per_trade ?? 0.02, 0.015), 0.001, 1),
          options_max_spread_pct: clamp(Math.min(config.options_max_spread_pct ?? 8, 6), 0, 100),
          options_early_loss_exit_enabled: true,
          options_early_loss_exit_pct: clamp(Math.min(config.options_early_loss_exit_pct ?? 25, 20), 0, 100),
          options_early_loss_exit_max_hold_minutes: clamp(
            Math.min(config.options_early_loss_exit_max_hold_minutes ?? 60, 45),
            0,
            1440
          ),
          options_stop_loss_pct: clamp(Math.min(config.options_stop_loss_pct ?? 50, 35), 1, 100),
          options_min_dte: proposedOptionsMinDte,
          options_max_dte: proposedOptionsMaxDte,
        },
        evidence,
        suggestion:
          "Options trades are underperforming as an asset class. Require higher confidence, reduce per-trade option exposure, prefer more DTE, and cap option loss depth until this segment recovers.",
      });
    } else if (group === "by_asset_class" && key === "crypto") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "crypto_asset_class_risk",
        config_keys: [
          "crypto_enabled",
          "crypto_momentum_threshold",
          "crypto_max_position_value",
          "crypto_stop_loss_pct",
          "crypto_take_profit_pct",
        ],
        proposed_config_patch: {
          crypto_enabled: true,
          crypto_momentum_threshold: clamp(Math.max(config.crypto_momentum_threshold ?? 2, 2.5), 0, 100),
          crypto_max_position_value: clamp(Math.min(config.crypto_max_position_value ?? 1_000, 750), 1, 100_000),
          crypto_stop_loss_pct: clamp(Math.min(config.crypto_stop_loss_pct ?? 5, 4), 0.1, 100),
          crypto_take_profit_pct: clamp(Math.max(config.crypto_take_profit_pct ?? 10, 10), 0.1, 500),
        },
        evidence,
        suggestion:
          "Crypto trades are underperforming as an asset class. Demand stronger momentum, reduce max crypto position value, and tighten stop loss before allowing more 24/7 exposure.",
      });
    } else if (group === "by_asset_class" && key === "equity") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "equity_asset_class_risk",
        config_keys: ["min_analyst_confidence", "min_entry_quality", "min_entry_catalysts", "min_entry_signal_sources"],
        proposed_config_patch: {
          min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1),
          min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
          min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1),
          min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
        },
        evidence,
        suggestion:
          "Equity trades are underperforming as an asset class. Tighten the common stock entry gates before changing option or crypto-specific controls.",
      });
    } else if (group === "by_option_dte" && (key === "<7d" || key === "7d..14d")) {
      const proposedOptionsMinDte = clamp(Math.max(config.options_min_dte ?? 7, key === "<7d" ? 21 : 14), 1, 365);
      addSuggestion({
        priority,
        direction: "tighten",
        target: "options_dte_risk",
        config_keys: [
          "options_min_dte",
          "options_max_dte",
          "options_max_pct_per_trade",
          "options_early_loss_exit_enabled",
          "options_early_loss_exit_pct",
          "options_stop_loss_pct",
        ],
        proposed_config_patch: {
          options_min_dte: proposedOptionsMinDte,
          options_max_dte: clamp(Math.max(config.options_max_dte ?? 45, proposedOptionsMinDte), 1, 365),
          options_max_pct_per_trade: clamp(Math.min(config.options_max_pct_per_trade ?? 0.02, 0.015), 0.001, 1),
          options_early_loss_exit_enabled: true,
          options_early_loss_exit_pct: clamp(Math.min(config.options_early_loss_exit_pct ?? 25, 20), 0, 100),
          options_stop_loss_pct: clamp(Math.min(config.options_stop_loss_pct ?? 50, 35), 1, 100),
        },
        evidence,
        suggestion:
          "Short-dated option trades are weak. Move minimum DTE farther out and reduce option exposure while this expiration bucket is losing.",
      });
    } else if (group === "by_option_delta" && (key === "<0.30" || key === "0.70+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "options_delta_band",
        config_keys: ["options_min_delta", "options_max_delta", "options_target_delta", "options_min_confidence"],
        proposed_config_patch: {
          options_min_delta: clamp(Math.max(config.options_min_delta ?? 0.3, 0.3), 0.1, 0.9),
          options_max_delta: clamp(Math.min(config.options_max_delta ?? 0.7, 0.7), 0.1, 0.9),
          options_target_delta: clamp(
            key === "<0.30" ? 0.4 : Math.min(config.options_target_delta ?? 0.45, 0.45),
            0.1,
            0.9
          ),
          options_min_confidence: clamp(Math.max(config.options_min_confidence ?? 0.8, 0.82), 0, 1),
        },
        evidence,
        suggestion:
          "Weak option delta buckets suggest contracts are either too far OTM or too stock-like for the strategy. Keep deltas in the configured middle band and require stronger confidence.",
      });
    } else if (group === "by_option_type" && (key === "call" || key === "put")) {
      addSuggestion({
        priority,
        direction: "investigate",
        target: `options_type:${key}`,
        config_keys: ["options_min_confidence", "options_max_pct_per_trade"],
        proposed_config_patch: {
          options_min_confidence: clamp(Math.max(config.options_min_confidence ?? 0.8, 0.82), 0, 1),
          options_max_pct_per_trade: clamp(Math.min(config.options_max_pct_per_trade ?? 0.02, 0.015), 0.001, 1),
        },
        evidence,
        suggestion:
          "This option type is losing more than winning. Keep option size conservative and inspect whether the underlying directional signal is mismatched before adding type-specific rules.",
      });
    } else if (group === "by_crypto_momentum" && (key === "<2%" || key === "2%..4%")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "crypto_low_momentum_entries",
        config_keys: ["crypto_momentum_threshold", "crypto_max_position_value", "crypto_stop_loss_pct"],
        proposed_config_patch: {
          crypto_momentum_threshold: clamp(
            Math.max(config.crypto_momentum_threshold ?? 2, key === "<2%" ? 3 : 2.5),
            0.1,
            20
          ),
          crypto_max_position_value: clamp(Math.min(config.crypto_max_position_value ?? 1_000, 750), 1, 100_000),
          crypto_stop_loss_pct: clamp(Math.min(config.crypto_stop_loss_pct ?? 5, 4), 1, 50),
        },
        evidence,
        suggestion:
          "Low crypto momentum buckets are weak. Raise the crypto momentum threshold and reduce crypto exposure until weak momentum entries stop losing.",
      });
    } else if (group === "by_crypto_momentum" && key === "8%+") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "crypto_overextended_momentum",
        config_keys: [
          "crypto_max_momentum_pct",
          "crypto_max_position_value",
          "crypto_stop_loss_pct",
          "profit_lock_stop_enabled",
          "profit_lock_activation_pct",
          "trailing_stop_enabled",
          "trailing_stop_drawdown_pct",
        ],
        proposed_config_patch: {
          crypto_max_momentum_pct: clamp(Math.min(config.crypto_max_momentum_pct ?? 12, 8), 0, 100),
          crypto_max_position_value: clamp(Math.min(config.crypto_max_position_value ?? 1_000, 600), 1, 100_000),
          crypto_stop_loss_pct: clamp(Math.min(config.crypto_stop_loss_pct ?? 5, 3.5), 1, 50),
          profit_lock_stop_enabled: true,
          profit_lock_activation_pct: clamp(
            Math.min(config.profit_lock_activation_pct ?? 3, 2.5),
            0,
            Math.max(0, (config.breakeven_stop_activation_pct ?? 4) - 0.05)
          ),
          trailing_stop_enabled: true,
          trailing_stop_drawdown_pct: clamp(Math.min(config.trailing_stop_drawdown_pct ?? 3, 2), 0.1, 100),
        },
        evidence,
        suggestion:
          "Very high crypto momentum is underperforming, which often means late entries into overextended moves. Reduce size and protect profits earlier for this bucket.",
      });
    } else if (group === "by_entry_quality" && (key === "fair" || key === "poor")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "entry_quality",
        config_keys: ["min_entry_quality"],
        proposed_config_patch: { min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good" },
        evidence,
        suggestion:
          "Lower-quality entries are losing more than winning. Keep min_entry_quality at good or excellent until this bucket improves.",
      });
    } else if (group === "by_entry_selection_score" && (key === "<0.85" || key === "0.85-0.94")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "entry_selection_score",
        config_keys: [
          "min_entry_selection_score",
          "min_analyst_confidence",
          "min_entry_quality",
          "min_entry_catalysts",
          "min_entry_signal_sources",
        ],
        proposed_config_patch: {
          min_entry_selection_score: clamp(Math.max(config.min_entry_selection_score ?? 0.85, key === "<0.85" ? 0.85 : 0.95), 0, 2),
          min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1),
          min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
          min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1),
          min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
        },
        evidence,
        suggestion:
          "Lower entry-selection score trades are underperforming. Tighten the components that feed this score before allowing more marginal setups.",
      });
    } else if (group === "by_entry_spread_pct" && (key === "0.80%..2%" || key === "2%+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "executed_entry_liquidity",
        config_keys: ["max_entry_spread_pct", "ticker_blacklist", "allowed_exchanges"],
        proposed_config_patch: {
          max_entry_spread_pct: clamp(
            Math.min(config.max_entry_spread_pct ?? 0.8, key === "2%+" ? 0.5 : 0.7),
            0.01,
            10
          ),
        },
        evidence,
        suggestion:
          "Executed entries with wide bid/ask spreads are underperforming. Tighten max_entry_spread_pct and inspect the affected symbols or venues before allowing more illiquid fills.",
      });
    } else if (group === "by_entry_quote_slippage_pct" && (key === "0.25%..0.75%" || key === "0.75%+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "entry_execution_quality",
        config_keys: ["max_entry_spread_pct", "allowed_exchanges", "ticker_blacklist"],
        proposed_config_patch: {
          max_entry_spread_pct: clamp(
            Math.min(config.max_entry_spread_pct ?? 0.8, key === "0.75%+" ? 0.5 : 0.7),
            0.01,
            10
          ),
        },
        evidence,
        suggestion:
          "Entries filled above the pre-order quote reference are underperforming. Treat this as execution drag: tighten spread limits and inspect the affected symbols or venues before increasing exposure.",
      });
    } else if (group === "by_entry_price_change_pct" && (key === "2%..5%" || key === "5%+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "overextended_entry_chasing",
        config_keys: [
          "entry_timing_enabled",
          "entry_rsi_max",
          "entry_max_intraday_range_position",
          "max_entry_research_age_minutes",
          "max_entry_price_change_pct",
        ],
        proposed_config_patch: {
          entry_timing_enabled: true,
          entry_rsi_max: clamp(Math.min(config.entry_rsi_max ?? 55, key === "5%+" ? 50 : 52), 0, 100),
          entry_max_intraday_range_position: clamp(
            Math.min(config.entry_max_intraday_range_position ?? 0.75, key === "5%+" ? 0.65 : 0.7),
            0,
            1
          ),
          max_entry_research_age_minutes: clamp(Math.min(config.max_entry_research_age_minutes ?? 30, 20), 1, 1440),
          max_entry_price_change_pct: clamp(
            Math.min(config.max_entry_price_change_pct ?? 5, key === "5%+" ? 5 : 4),
            0,
            100
          ),
        },
        evidence,
        suggestion:
          "Entries after a strong same-day price run are underperforming. Reduce chase risk by keeping timing checks enabled, lowering the upper RSI entry band, requiring fresher research, and capping buys after extended moves.",
      });
    } else if (group === "by_entry_fill_delay" && (key === "5m..30m" || key === "30m+")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "slow_entry_fills",
        config_keys: ["max_entry_research_age_minutes", "entry_timing_enabled", "market_open_execute_window_minutes"],
        proposed_config_patch: {
          max_entry_research_age_minutes: clamp(Math.min(config.max_entry_research_age_minutes ?? 30, 20), 1, 1440),
          entry_timing_enabled: true,
          market_open_execute_window_minutes: clamp(Math.min(config.market_open_execute_window_minutes ?? 2, 1), 0, 10),
        },
        evidence,
        suggestion:
          "Entries filled several minutes after order creation are underperforming. Treat delayed fills as potentially stale signals: keep technical timing enabled, reduce market-open chase room, and prefer fresher research while this bucket is weak.",
      });
    } else if (group === "by_portfolio_bucket" && key !== "unknown" && !key.startsWith("individual:")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: `portfolio_bucket:${key}`,
        config_keys: ["portfolio_risk_enabled", "max_positions_per_sector", "adaptive_performance_block_enabled"],
        proposed_config_patch: {
          portfolio_risk_enabled: true,
          max_positions_per_sector: clamp(Math.min(config.max_positions_per_sector ?? 2, 1), 1, 10),
          adaptive_performance_block_enabled: true,
        },
        evidence,
        suggestion:
          "This portfolio bucket is underperforming. Keep portfolio concentration controls enabled and limit same-bucket exposure until the bucket recovers.",
      });
    } else if (group === "by_research_confirmation" && key === "unconfirmed") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "research_confirmation",
        config_keys: ["analyst_buy_requires_research_confirmation", "exceptional_entry_confidence"],
        proposed_config_patch: {
          analyst_buy_requires_research_confirmation: true,
          exceptional_entry_confidence: clamp(Math.max(config.exceptional_entry_confidence ?? 0.9, 0.9), 0, 1),
        },
        evidence,
        suggestion:
          "Unconfirmed recommendation buys are underperforming. Require research confirmation, and only consider bypasses for truly exceptional confidence with aligned live signals.",
      });
    } else if (group === "by_red_flags" && key !== "0" && key !== "unknown") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "red_flags",
        config_keys: ["max_entry_red_flags"],
        proposed_config_patch: { max_entry_red_flags: 0 },
        evidence,
        suggestion:
          "Entries with red flags are weak. Keep max_entry_red_flags at 0 unless later data proves otherwise.",
      });
    } else if (group === "by_catalysts" && key === "0") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "catalyst_requirement",
        config_keys: ["min_entry_catalysts"],
        proposed_config_patch: { min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1) },
        evidence,
        suggestion:
          "Trades without concrete catalysts are underperforming. Require at least one catalyst for autonomous entries.",
      });
    } else if (group === "by_signal_sources" && (key === "0" || key === "1")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "signal_confirmation",
        config_keys: ["min_entry_signal_sources", "single_source_entry_min_confidence"],
        proposed_config_patch: {
          min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
          single_source_entry_min_confidence: clamp(
            Math.max(config.single_source_entry_min_confidence ?? 0.82, key === "1" ? 0.85 : 0.88),
            0,
            1
          ),
        },
        evidence,
        suggestion:
          "Thin signal confirmation is underperforming. Require stronger independent-source support, and demand higher confidence when only one source confirms the setup.",
      });
    } else if (group === "by_signal_consensus" && (key === "mixed" || key === "weak_mixed")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "signal_consensus",
        config_keys: ["min_sentiment_score", "min_entry_signal_sources", "min_entry_signal_consensus"],
        proposed_config_patch: {
          min_sentiment_score: clamp(Math.max(config.min_sentiment_score, 0.3), 0, 1),
          min_entry_signal_sources: Math.max(config.min_entry_signal_sources ?? 1, 2),
          min_entry_signal_consensus: clamp(Math.max(config.min_entry_signal_consensus ?? 0.15, 0.2), 0, 1),
        },
        evidence,
        suggestion:
          "Mixed signal consensus is weak. Require a stronger average entry consensus and avoid loosening sentiment/source gates for this setup family.",
      });
    } else if (group === "by_research_age" && key === ">60") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "research_freshness",
        config_keys: ["max_entry_research_age_minutes"],
        proposed_config_patch: {
          max_entry_research_age_minutes: clamp(Math.min(config.max_entry_research_age_minutes ?? 30, 30), 1, 1440),
        },
        evidence,
        suggestion:
          "Older research is underperforming. Keep max_entry_research_age_minutes near the current value or lower it if stale entries keep losing.",
      });
    } else if (group === "by_market_regime" && (key === "weak_exceptional" || key === "blocked")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "market_regime",
        config_keys: ["market_regime_enabled", "regime_low_threshold", "exceptional_entry_confidence"],
        proposed_config_patch: {
          market_regime_enabled: true,
          exceptional_entry_confidence: clamp(Math.max(config.exceptional_entry_confidence ?? 0.9, 0.9), 0, 1),
        },
        evidence,
        suggestion:
          "Weak-regime entries are losing. Keep market regime gating enabled and reserve bypasses for excellent, high-confidence setups.",
      });
    } else if (group === "by_mfe_pct" && key === "<1%") {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "low_favorable_excursion_entries",
        config_keys: [
          "min_analyst_confidence",
          "min_entry_quality",
          "min_entry_catalysts",
          "max_entry_research_age_minutes",
        ],
        proposed_config_patch: {
          min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1),
          min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
          min_entry_catalysts: Math.max(config.min_entry_catalysts ?? 1, 1),
          max_entry_research_age_minutes: clamp(Math.min(config.max_entry_research_age_minutes ?? 30, 30), 1, 1440),
        },
        evidence,
        suggestion:
          "Trades with less than 1% favorable excursion are weak. Tighten entry quality, catalyst, confidence, and research freshness before adjusting exits.",
      });
    } else if (group === "by_mae_pct" && (key === "<=-10%" || key === "-10%..-5%" || key === "-5%..-2%")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "adverse_excursion_control",
        config_keys: [
          "stop_loss_pct",
          "early_loss_exit_enabled",
          "early_loss_exit_pct",
          "early_loss_exit_max_hold_minutes",
          "sentiment_reversal_loss_pct",
          "stale_loss_exit_pct",
          "cooldown_minutes_after_loss",
          "max_daily_loss_pct",
          "max_daily_entry_orders",
          "min_minutes_between_entries",
        ],
        proposed_config_patch: {
          stop_loss_pct: clamp(Math.min(config.stop_loss_pct, key === "-5%..-2%" ? 5 : 4), 1, 50),
          early_loss_exit_enabled: true,
          early_loss_exit_pct: clamp(Math.min(config.early_loss_exit_pct ?? 2.5, key === "-5%..-2%" ? 2 : 1.75), 0, 50),
          early_loss_exit_max_hold_minutes: clamp(Math.min(config.early_loss_exit_max_hold_minutes ?? 90, 75), 0, 1440),
          sentiment_reversal_loss_pct: clamp(Math.min(config.sentiment_reversal_loss_pct ?? 1.5, 1.25), 0, 50),
          stale_loss_exit_pct: clamp(Math.min(config.stale_loss_exit_pct ?? 2, 1.5), 0, 50),
          cooldown_minutes_after_loss: Math.max(config.cooldown_minutes_after_loss ?? 30, 45),
          max_daily_loss_pct: clamp(Math.min(config.max_daily_loss_pct ?? 0.02, 0.015), 0.001, 1),
          max_daily_entry_orders: Math.max(1, Math.min(config.max_daily_entry_orders ?? 8, 5)),
          min_minutes_between_entries: Math.max(config.min_minutes_between_entries ?? 5, 10),
        },
        evidence,
        suggestion:
          "Large adverse excursion buckets are underperforming. Reduce allowed downside with stop, stale-loss, and sentiment-reversal controls before expanding exposure.",
      });
    } else if (group === "by_giveback_pct" && (key === "3%..6%" || key === "6%+")) {
      const breakevenActivation = config.breakeven_stop_activation_pct ?? 4;
      const proposedProfitLockActivation = clamp(
        Math.min(config.profit_lock_activation_pct ?? 3, 3),
        0,
        Math.max(0, breakevenActivation - 0.05)
      );
      const proposedProfitLockFloor = clamp(
        Math.min(Math.max(config.profit_lock_floor_pct ?? 0.75, 0.75), proposedProfitLockActivation),
        0,
        10
      );
      addSuggestion({
        priority,
        direction: "tighten",
        target: "winner_giveback_control",
        config_keys: [
          "profit_lock_stop_enabled",
          "profit_lock_activation_pct",
          "profit_lock_floor_pct",
          "trailing_stop_enabled",
          "trailing_stop_activation_pct",
          "trailing_stop_drawdown_pct",
        ],
        proposed_config_patch: {
          profit_lock_stop_enabled: true,
          profit_lock_activation_pct: Number(proposedProfitLockActivation.toFixed(2)),
          profit_lock_floor_pct: Number(proposedProfitLockFloor.toFixed(2)),
          trailing_stop_enabled: true,
          trailing_stop_activation_pct: clamp(Math.min(config.trailing_stop_activation_pct ?? 6, 5), 0, 100),
          trailing_stop_drawdown_pct: clamp(
            Math.min(config.trailing_stop_drawdown_pct ?? 3, key === "6%+" ? 2 : 2.5),
            0.1,
            100
          ),
        },
        evidence,
        suggestion:
          "High giveback buckets are underperforming. Protect trades after favorable movement with earlier profit-lock activation and a tighter trailing drawdown.",
      });
    } else if (group === "by_exit_efficiency_pct" && (key === "<25%" || key === "25%..50%")) {
      const breakevenActivation = config.breakeven_stop_activation_pct ?? 4;
      const proposedProfitLockActivation = clamp(
        Math.min(config.profit_lock_activation_pct ?? 3, key === "<25%" ? 2.5 : 3),
        0,
        Math.max(0, breakevenActivation - 0.05)
      );
      const proposedProfitLockFloor = clamp(
        Math.min(
          Math.max(config.profit_lock_floor_pct ?? 0.75, key === "<25%" ? 1 : 0.75),
          proposedProfitLockActivation
        ),
        0,
        10
      );
      addSuggestion({
        priority,
        direction: "tighten",
        target: "low_exit_efficiency",
        config_keys: [
          "profit_lock_stop_enabled",
          "profit_lock_activation_pct",
          "profit_lock_floor_pct",
          "trailing_stop_enabled",
          "trailing_stop_activation_pct",
          "trailing_stop_drawdown_pct",
        ],
        proposed_config_patch: {
          profit_lock_stop_enabled: true,
          profit_lock_activation_pct: Number(proposedProfitLockActivation.toFixed(2)),
          profit_lock_floor_pct: Number(proposedProfitLockFloor.toFixed(2)),
          trailing_stop_enabled: true,
          trailing_stop_activation_pct: clamp(
            Math.min(config.trailing_stop_activation_pct ?? 6, key === "<25%" ? 4 : 5),
            0,
            100
          ),
          trailing_stop_drawdown_pct: clamp(
            Math.min(config.trailing_stop_drawdown_pct ?? 3, key === "<25%" ? 2 : 2.5),
            0.1,
            100
          ),
        },
        evidence,
        suggestion:
          "Exit efficiency is weak: trades are keeping too little of their favorable excursion. Lock profit earlier and trail tighter until realized exits retain more of the move.",
      });
    } else if (group === "by_pnl_pct" && (key === "<=-10%" || key === "-10%..-5%")) {
      addSuggestion({
        priority,
        direction: "tighten",
        target: "loss_depth_control",
        config_keys: [
          "stop_loss_pct",
          "early_loss_exit_enabled",
          "early_loss_exit_pct",
          "early_loss_exit_max_hold_minutes",
          "sentiment_reversal_loss_pct",
          "stale_loss_exit_pct",
          "cooldown_minutes_after_loss",
          "max_daily_loss_pct",
          "max_daily_entry_orders",
          "min_minutes_between_entries",
        ],
        proposed_config_patch: {
          stop_loss_pct: clamp(Math.min(config.stop_loss_pct, key === "<=-10%" ? 4 : 5), 1, 50),
          early_loss_exit_enabled: true,
          early_loss_exit_pct: clamp(Math.min(config.early_loss_exit_pct ?? 2.5, key === "<=-10%" ? 1.75 : 2), 0, 50),
          early_loss_exit_max_hold_minutes: clamp(Math.min(config.early_loss_exit_max_hold_minutes ?? 90, 75), 0, 1440),
          sentiment_reversal_loss_pct: clamp(Math.min(config.sentiment_reversal_loss_pct ?? 1.5, 1.25), 0, 50),
          stale_loss_exit_pct: clamp(Math.min(config.stale_loss_exit_pct ?? 2, 1.5), 0, 50),
          cooldown_minutes_after_loss: Math.max(config.cooldown_minutes_after_loss ?? 30, 45),
          max_daily_loss_pct: clamp(Math.min(config.max_daily_loss_pct ?? 0.02, 0.015), 0.001, 1),
          max_daily_entry_orders: Math.max(1, Math.min(config.max_daily_entry_orders ?? 8, 5)),
          min_minutes_between_entries: Math.max(config.min_minutes_between_entries ?? 5, 10),
        },
        evidence,
        suggestion:
          "Deep loss buckets are underperforming. Prefer reducing loss depth through stop, sentiment-reversal, and stale-loss exits before increasing position size or loosening entries.",
      });
    } else if (group === "by_hold_time" && (key === "4h-1d" || key === "1d-5d" || key === "5d+")) {
      const proposedMaxHoldDays = clamp(Math.min(config.stale_max_hold_days ?? 3, key === "5d+" ? 4 : 3), 1, 30);
      addSuggestion({
        priority,
        direction: "tighten",
        target: "stale_hold_time",
        config_keys: [
          "stale_position_enabled",
          "stale_min_hold_hours",
          "stale_loss_exit_pct",
          "stale_mid_hold_days",
          "stale_max_hold_days",
          "stale_min_gain_pct",
        ],
        proposed_config_patch: {
          stale_position_enabled: true,
          stale_min_hold_hours: clamp(Math.min(config.stale_min_hold_hours ?? 24, key === "4h-1d" ? 6 : 12), 0, 168),
          stale_loss_exit_pct: clamp(Math.min(config.stale_loss_exit_pct ?? 2, 1.5), 0, 50),
          stale_mid_hold_days: clamp(Math.min(config.stale_mid_hold_days ?? 2, 2, proposedMaxHoldDays), 1, 30),
          stale_max_hold_days: proposedMaxHoldDays,
          stale_min_gain_pct: clamp(Math.min(config.stale_min_gain_pct ?? 5, 3), 0, 100),
        },
        evidence,
        suggestion:
          "Longer-held trades are losing more than winning. Tighten stale-position exits so capital rotates out of positions that fail to show progress.",
      });
    } else if (group === "by_size_multiplier") {
      if (key === "<0.45" || key === "0.45-0.69") {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "low_conviction_position_sizing",
          config_keys: [
            "llm_size_conviction_scaling",
            "llm_size_low_confidence_multiplier",
            "llm_size_medium_confidence_multiplier",
          ],
          proposed_config_patch: {
            llm_size_conviction_scaling: true,
            llm_size_low_confidence_multiplier: clamp(
              Math.min(config.llm_size_low_confidence_multiplier ?? 0.4, 0.3),
              0.1,
              1
            ),
            llm_size_medium_confidence_multiplier: clamp(
              Math.min(config.llm_size_medium_confidence_multiplier ?? 0.7, 0.6),
              0.1,
              1
            ),
          },
          evidence,
          suggestion:
            "Reduced-size, lower-conviction entries are still underperforming. Keep conviction scaling enabled and cut low/medium confidence exposure until this bucket improves.",
        });
      } else if (key === "0.70-0.89") {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "medium_conviction_position_sizing",
          config_keys: ["llm_size_conviction_scaling", "llm_size_medium_confidence_multiplier"],
          proposed_config_patch: {
            llm_size_conviction_scaling: true,
            llm_size_medium_confidence_multiplier: clamp(
              Math.min(config.llm_size_medium_confidence_multiplier ?? 0.7, 0.6),
              0.1,
              1
            ),
          },
          evidence,
          suggestion:
            "Medium-conviction size buckets are weak. Reduce medium-confidence exposure before increasing max positions or per-trade sizing.",
        });
      } else if (key === "0.90+") {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "full_size_position_risk",
          config_keys: [
            "position_size_pct_of_cash",
            "max_position_value",
            "min_analyst_confidence",
            "min_entry_quality",
          ],
          proposed_config_patch: {
            position_size_pct_of_cash: clamp(Math.min(config.position_size_pct_of_cash, 15), 1, 100),
            max_position_value: clamp(Math.min(config.max_position_value, 4_000), 1, 100_000),
            min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.65), 0, 1),
            min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
          },
          evidence,
          suggestion:
            "Full-size entries are underperforming. Reduce base exposure and keep high-confidence, good-or-better entry gates until full-size trades recover.",
        });
      }
    } else if (group === "by_entry_session") {
      if (key === "open_30m") {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "entry_session:open_30m",
          config_keys: [
            "equity_entry_cooldown_minutes_after_open",
            "market_open_execute_window_minutes",
            "entry_timing_enabled",
          ],
          proposed_config_patch: {
            equity_entry_cooldown_minutes_after_open: clamp(
              Math.max(config.equity_entry_cooldown_minutes_after_open ?? 10, 15),
              0,
              120
            ),
            market_open_execute_window_minutes: clamp(
              Math.min(config.market_open_execute_window_minutes ?? 2, 1),
              0,
              10
            ),
            entry_timing_enabled: true,
          },
          evidence,
          suggestion:
            "Entries in the first 30 minutes are underperforming. Delay new equity entries after the open, keep technical timing enabled, and reduce the market-open execute window while this bucket is weak.",
        });
      } else if (key === "close_30m" || key === "after_hours") {
        addSuggestion({
          priority,
          direction: "tighten",
          target: `entry_session:${key}`,
          config_keys: ["equity_entry_cutoff_minutes_before_close", "after_hours_exit_limit_buffer_pct"],
          proposed_config_patch: {
            equity_entry_cutoff_minutes_before_close: clamp(
              Math.max(config.equity_entry_cutoff_minutes_before_close ?? 15, 30),
              0,
              120
            ),
          },
          evidence,
          suggestion:
            "Late-session entries are underperforming. Increase the equity entry cutoff so new positions are not opened into the closing liquidity window unless later review proves this bucket has recovered.",
        });
      } else if (key !== "unknown") {
        addSuggestion({
          priority,
          direction: "investigate",
          target: `entry_session:${key}`,
          config_keys: ["entry_timing_enabled"],
          evidence,
          suggestion:
            "This entry-session bucket is losing more than winning. Compare snapshots for timing traits before changing broad quality or confidence gates.",
        });
      }
    } else if (group === "by_entry_weekday" && key !== "unknown") {
      addSuggestion({
        priority,
        direction: "investigate",
        target: `entry_weekday:${key}`,
        config_keys: [],
        evidence,
        suggestion:
          "This weekday bucket is underperforming. Treat it as a review segment for now; require more samples before introducing day-of-week trading rules.",
      });
    } else if (group === "by_symbol" && key !== "unknown") {
      const parsedOption = parseOccOptionSymbol(key);
      const blacklistSymbol = parsedOption?.underlying ?? normalizeCryptoSymbol(key);
      addSuggestion({
        priority,
        direction: "tighten",
        target: `symbol_quarantine:${key}`,
        config_keys: ["ticker_blacklist", "recent_sell_cooldown_hours", "adaptive_performance_block_enabled"],
        proposed_config_patch: {
          ticker_blacklist: [...new Set([...(config.ticker_blacklist ?? []), blacklistSymbol])],
          recent_sell_cooldown_hours: clamp(Math.max(config.recent_sell_cooldown_hours ?? 72, 96), 0, 720),
          adaptive_performance_block_enabled: true,
        },
        evidence: { ...evidence, blacklist_symbol: blacklistSymbol },
        suggestion:
          "This symbol bucket is repeatedly losing. Quarantine the symbol, extend recent-sell cooldown, and keep adaptive performance blocks enabled until later review shows recovery.",
      });
    } else if (group === "by_entry_path") {
      if (key.includes("premarket")) {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "entry_path:premarket_plan",
          config_keys: [
            "market_open_execute_window_minutes",
            "entry_timing_enabled",
            "analyst_buy_requires_research_confirmation",
          ],
          proposed_config_patch: {
            market_open_execute_window_minutes: clamp(Math.min(config.market_open_execute_window_minutes ?? 2, 1), 0, 10),
            entry_timing_enabled: true,
            analyst_buy_requires_research_confirmation: true,
          },
          evidence,
          suggestion:
            "Pre-market plan entries are underperforming. Reduce the market-open execution window, keep timing checks enabled, and require fresh research confirmation before this path gets more exposure.",
        });
      } else if (key.includes("llm_recommendation")) {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "entry_path:llm_recommendation",
          config_keys: [
            "analyst_buy_requires_research_confirmation",
            "min_analyst_confidence",
            "min_entry_quality",
            "adaptive_performance_block_enabled",
          ],
          proposed_config_patch: {
            analyst_buy_requires_research_confirmation: true,
            min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.7), 0, 1),
            min_entry_quality: config.min_entry_quality === "excellent" ? "excellent" : "good",
            adaptive_performance_block_enabled: true,
          },
          evidence,
          suggestion:
            "LLM recommendation entries are underperforming. Require same-symbol research confirmation and raise the minimum conviction for this path while adaptive blocks learn the weak pattern.",
        });
      } else if (key.includes("crypto")) {
        addSuggestion({
          priority,
          direction: "tighten",
          target: "entry_path:crypto_momentum",
          config_keys: [
            "min_analyst_confidence",
            "profit_lock_stop_enabled",
            "trailing_stop_enabled",
            "trailing_stop_drawdown_pct",
          ],
          proposed_config_patch: {
            min_analyst_confidence: clamp(Math.max(config.min_analyst_confidence, 0.7), 0, 1),
            profit_lock_stop_enabled: true,
            trailing_stop_enabled: true,
            trailing_stop_drawdown_pct: clamp(Math.min(config.trailing_stop_drawdown_pct ?? 3, 2), 0.1, 100),
          },
          evidence,
          suggestion:
            "Crypto momentum entries are underperforming. Demand higher conviction and protect gains faster before allowing more momentum-path exposure.",
        });
      } else {
        addSuggestion({
          priority,
          direction: "investigate",
          target: `${group}:${key}`,
          config_keys: [],
          evidence,
          suggestion:
            "This entry path is losing more than winning. Inspect the included snapshots before increasing exposure for this pattern.",
        });
      }
    }
  }

  const buyEvents =
    (asNumber(runtimePipeline.buys_executed) ?? 0) +
    (asNumber(runtimePipeline.buys_submitted) ?? 0) +
    (asNumber(runtimePipeline.buys_deferred) ?? 0);
  const missedEntryEvaluated = asNumber(runtimePipeline.missed_entry_evaluated) ?? 0;
  const missedEntryWouldHaveWon = asNumber(runtimePipeline.missed_entry_would_have_won) ?? 0;
  const missedEntryWouldHaveLost = asNumber(runtimePipeline.missed_entry_would_have_lost) ?? 0;
  const missedEntryReasons = getNestedArray(runtimePipeline, "missed_entry_reasons");
  const topMissedEntryReason = missedEntryReasons.find(
    (reason) => (asNumber(reason.evaluated) ?? 0) >= 1 && (asNumber(reason.would_have_won) ?? 0) > 0
  );
  if (missedEntryEvaluated >= 3 && missedEntryWouldHaveWon > missedEntryWouldHaveLost) {
    const topReason = topMissedEntryReason
      ? {
          action: asString(topMissedEntryReason.action),
          reason: asString(topMissedEntryReason.reason),
          evaluated: asNumber(topMissedEntryReason.evaluated),
          would_have_won: asNumber(topMissedEntryReason.would_have_won),
          would_have_lost: asNumber(topMissedEntryReason.would_have_lost),
          symbols: Array.isArray(topMissedEntryReason.symbols) ? topMissedEntryReason.symbols.slice(0, 10) : [],
        }
      : null;
    const topReasonText = topReason?.reason ?? "";
    const topActionText = topReason?.action ?? "";
    const missedEntryConfigKeys = new Set<string>([
      "entry_timing_enabled",
      "entry_rsi_min",
      "entry_rsi_max",
      "entry_bb_lower_threshold",
      "equity_entry_cooldown_minutes_after_open",
      "equity_entry_cutoff_minutes_before_close",
      "min_analyst_confidence",
    ]);
    const missedEntryPatch: Partial<AgentConfig> = {};
    if (topReasonText === "low_signal_consensus") {
      missedEntryConfigKeys.add("min_entry_signal_consensus");
      missedEntryPatch.min_entry_signal_consensus = Number(
        clamp(Math.max(0, (config.min_entry_signal_consensus ?? 0.15) - 0.05), 0, 1).toFixed(4)
      );
    } else if (topReasonText === "low_entry_selection_score" || topActionText.includes("low_selection_score")) {
      missedEntryConfigKeys.add("min_entry_selection_score");
      missedEntryPatch.min_entry_selection_score = Number(
        clamp(Math.max(0, (config.min_entry_selection_score ?? 0.85) - 0.05), 0, 2).toFixed(4)
      );
    } else if (topReasonText === "insufficient_signal_sources") {
      missedEntryConfigKeys.add("min_entry_signal_sources");
    } else if (topReasonText === "recent_sell_cooldown" || topActionText.includes("recent_sell_cooldown")) {
      missedEntryConfigKeys.add("recent_sell_cooldown_hours");
    } else if (topActionText.includes("open_window")) {
      missedEntryConfigKeys.add("equity_entry_cooldown_minutes_after_open");
    } else if (topActionText.includes("close_window")) {
      missedEntryConfigKeys.add("equity_entry_cutoff_minutes_before_close");
    }
    addSuggestion({
      priority: "medium",
      direction: "investigate",
      target: topReason?.reason ? `missed_entry_opportunities:${topReason.reason}` : "missed_entry_opportunities",
      config_keys: [...missedEntryConfigKeys],
      proposed_config_patch: Object.keys(missedEntryPatch).length > 0 ? missedEntryPatch : undefined,
      evidence: {
        missed_entry_evaluated: missedEntryEvaluated,
        missed_entry_would_have_won: missedEntryWouldHaveWon,
        missed_entry_would_have_lost: missedEntryWouldHaveLost,
        top_missed_entry_reason: topReason,
      },
      suggestion:
        "Several skipped entry candidates later moved at least +2%. Review the top_missed_entry_reason before loosening timing, quality, confidence, or capacity gates, because these are direct counterfactuals from live data.",
    });
  }

  if (buyEvents === 0) {
    const signalResearchBuy = asNumber(runtimePipeline.signal_research_buy) ?? 0;
    const researchedBuyAvailable = asNumber(runtimePipeline.researched_buy_available) ?? 0;
    const strategyEntryCandidates = asNumber(runtimePipeline.strategy_entry_candidates) ?? 0;
    const analystBuyRecommendations = asNumber(runtimePipeline.analyst_buy_recommendations) ?? 0;
    const analystBuyRecommendationsAboveThreshold =
      asNumber(runtimePipeline.analyst_buy_recommendations_above_threshold) ?? 0;

    if (signalResearchBuy > 0 && strategyEntryCandidates === 0) {
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: "research_to_entry_conversion",
        config_keys: [
          "min_entry_quality",
          "max_entry_red_flags",
          "min_entry_catalysts",
          "min_entry_signal_sources",
          "max_entry_research_age_minutes",
        ],
        evidence: {
          signal_research_buy: signalResearchBuy,
          researched_buy_available: researchedBuyAvailable,
          strategy_entry_candidates: strategyEntryCandidates,
        },
        suggestion:
          "BUY research exists but no strategy entry candidates are produced. Inspect entry quality, red flags, catalysts, source confirmation, and research freshness before changing confidence thresholds.",
      });
    }

    if (strategyEntryCandidates > 0) {
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: "entry_candidate_execution",
        config_keys: [
          "entry_timing_enabled",
          "entry_rsi_min",
          "entry_rsi_max",
          "entry_bb_lower_threshold",
          "equity_entry_cooldown_minutes_after_open",
          "equity_entry_cutoff_minutes_before_close",
          "recent_sell_cooldown_hours",
          "position_size_pct_of_cash",
        ],
        evidence: {
          strategy_entry_candidates: strategyEntryCandidates,
          buy_events: buyEvents,
          dominant_blocker: runtimePipeline.dominant_entry_blocker ?? null,
        },
        suggestion:
          "Strategy entry candidates are being created but no buy orders are recorded. Focus on timing, close-window, cooldown, notional sizing, and broker/policy blockers.",
      });
    }

    if (analystBuyRecommendations > 0 && analystBuyRecommendationsAboveThreshold === 0) {
      addSuggestion({
        priority: "medium",
        direction: closedTrades >= 10 && totalWinRate >= 0.5 ? "loosen" : "investigate",
        target: "analyst_buy_confidence_threshold",
        config_keys: ["min_analyst_confidence"],
        proposed_config_patch:
          closedTrades >= 10 && totalWinRate >= 0.5
            ? { min_analyst_confidence: clamp((config.min_analyst_confidence ?? 0.6) - 0.05, 0.5, 1) }
            : undefined,
        evidence: {
          analyst_buy_recommendations: analystBuyRecommendations,
          analyst_buy_recommendations_above_threshold: analystBuyRecommendationsAboveThreshold,
          min_analyst_confidence: config.min_analyst_confidence,
        },
        suggestion:
          "The analyst is producing BUY ideas, but none meet the confidence threshold. Only lower min_analyst_confidence after enough closed trades prove lower-confidence ideas are profitable.",
      });
    }

    for (const blocker of blockerReasons.slice(0, 5)) {
      const action = asString(blocker.action) ?? "";
      const reason = asString(blocker.reason) ?? "";
      const count = asNumber(blocker.count) ?? 0;
      const evidence = { action, reason, count, symbols: blocker.symbols ?? [] };
      if (reason === "low_confidence") {
        addSuggestion({
          priority: "medium",
          direction: closedTrades >= 10 && totalWinRate >= 0.5 ? "loosen" : "investigate",
          target: "buy_starvation_confidence",
          config_keys: ["min_analyst_confidence"],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.5
              ? { min_analyst_confidence: clamp((config.min_analyst_confidence ?? 0.6) - 0.05, 0.5, 1) }
              : undefined,
          evidence,
          suggestion:
            "Low confidence is the dominant buy blocker. Only lower min_analyst_confidence after confirming profitable lower-confidence buckets, otherwise collect more data.",
        });
      } else if (reason === "insufficient_catalysts") {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "buy_starvation_catalysts",
          config_keys: ["min_entry_catalysts"],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.5
              ? { min_entry_catalysts: Math.max(0, (config.min_entry_catalysts ?? 1) - 1) }
              : undefined,
          evidence,
          suggestion:
            "Catalyst gating is blocking entries. Review skipped candidates before lowering this gate, because zero-catalyst trades often need separate proof.",
        });
      } else if (reason === "insufficient_signal_sources") {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "buy_starvation_signal_sources",
          config_keys: ["min_entry_signal_sources"],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.5
              ? { min_entry_signal_sources: Math.max(1, (config.min_entry_signal_sources ?? 1) - 1) }
              : undefined,
          evidence,
          suggestion:
            "Source confirmation is blocking entries. Check whether gatherers are producing enough independent sources before loosening the source requirement.",
        });
      } else if (reason === "weak_signal_consensus" || reason === "low_signal_consensus") {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "buy_starvation_signal_consensus",
          config_keys: [
            "min_entry_signal_consensus",
            "min_sentiment_score",
            "min_entry_signal_sources",
            "single_source_entry_min_confidence",
          ],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.55
              ? {
                  min_entry_signal_consensus: clamp(
                    Math.max(0, (config.min_entry_signal_consensus ?? 0.15) - 0.05),
                    0,
                    1
                  ),
                }
              : undefined,
          evidence,
          suggestion:
            "Signal consensus is blocking buys. Only loosen the consensus floor after enough closed trades or missed-entry review prove low-consensus setups are actually winning.",
        });
      } else if (reason === "stale_research") {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "research_refresh_rate",
          config_keys: ["max_entry_research_age_minutes", "signal_research_limit", "analyst_interval_ms"],
          proposed_config_patch: {
            signal_research_limit: clamp(Math.max(config.signal_research_limit, 8), 1, 20),
            analyst_interval_ms: clamp(Math.min(config.analyst_interval_ms, 90_000), 30_000, 600_000),
          },
          evidence,
          suggestion:
            "Research is going stale before entry. Prefer refreshing research cadence/limits before allowing older research to trade.",
        });
      } else if (reason === "low_entry_selection_score" || action.includes("low_selection_score")) {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "entry_selection_score_gate",
          config_keys: ["min_entry_selection_score", "min_analyst_confidence", "min_entry_quality"],
          evidence,
          suggestion:
            "The entry-selection score gate is blocking marginal setups. Keep it enabled unless missed-entry review shows these low-score candidates would have won.",
        });
      } else if (action.includes("timing_gate")) {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "entry_timing",
          config_keys: ["entry_timing_enabled", "entry_rsi_min", "entry_rsi_max", "entry_bb_lower_threshold"],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.5
              ? {
                  entry_rsi_min: clamp((config.entry_rsi_min ?? 40) - 5, 0, 100),
                  entry_rsi_max: clamp((config.entry_rsi_max ?? 55) + 5, 0, 100),
                }
              : undefined,
          evidence,
          suggestion:
            "Entry timing is blocking buys. Inspect whether blocked candidates later moved favorably before loosening RSI/Bollinger thresholds.",
        });
      } else if (action.includes("open_window")) {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "market_open_entry_cooldown",
          config_keys: ["equity_entry_cooldown_minutes_after_open", "market_open_execute_window_minutes"],
          evidence,
          suggestion:
            "The market-open cooldown is blocking buys. Keep it tight unless missed-entry review shows these skipped open-window candidates would have won.",
        });
      } else if (action.includes("notional_too_small")) {
        addSuggestion({
          priority: "medium",
          direction: "loosen",
          target: "position_sizing",
          config_keys: ["position_size_pct_of_cash", "max_position_value"],
          proposed_config_patch: {
            position_size_pct_of_cash: clamp(Math.max(config.position_size_pct_of_cash, 10), 1, 100),
            max_position_value: clamp(Math.max(config.max_position_value, 1_000), 1, 100_000),
          },
          evidence,
          suggestion:
            "Candidate notional is below the minimum order size. Increase position sizing or available cash allocation if this account should trade smaller signal sets.",
        });
      } else if (reason === "wide_spread" || action.includes("wide_spread")) {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "entry_liquidity",
          config_keys: ["max_entry_spread_pct", "ticker_blacklist", "allowed_exchanges"],
          evidence,
          suggestion:
            "Wide bid/ask spreads are blocking buys. Treat this as a liquidity-quality filter; inspect symbols and venues before loosening max_entry_spread_pct.",
        });
      } else if (action.includes("no_signals")) {
        addSuggestion({
          priority: "high",
          direction: "investigate",
          target: "signal_ingestion",
          config_keys: ["data_poll_interval_ms", "ticker_blacklist", "allowed_exchanges"],
          proposed_config_patch: {
            data_poll_interval_ms: clamp(Math.min(config.data_poll_interval_ms, 30_000), 5_000, 300_000),
          },
          evidence,
          suggestion:
            "The entry loop has no signals. Prioritize gatherer health and signal source coverage before changing trading thresholds.",
        });
      } else if (action.includes("no_capacity")) {
        addSuggestion({
          priority: "medium",
          direction: "investigate",
          target: "capacity",
          config_keys: ["max_positions", "max_positions_per_sector"],
          proposed_config_patch:
            closedTrades >= 10 && totalWinRate >= 0.5
              ? {
                  max_positions: clamp(config.max_positions + 1, 1, 50),
                  max_positions_per_sector: clamp((config.max_positions_per_sector ?? 2) + 1, 1, 10),
                }
              : undefined,
          evidence,
          suggestion:
            "Capacity is blocking new entries. Review open positions and pending orders before increasing max_positions.",
        });
      }
    }
  }

  const reviewBlockerReasons = blockerReasons.slice(0, 8);
  const reviewBlockerKeys = new Set(
    reviewBlockerReasons.map((blocker) => `${asString(blocker.action) ?? ""}:${asString(blocker.reason) ?? ""}`)
  );
  for (const blocker of blockerReasons) {
    const action = asString(blocker.action) ?? "";
    const reason = asString(blocker.reason) ?? "";
    const key = `${action}:${reason}`;
    if (reviewBlockerKeys.has(key)) continue;
    if (reason !== "pending_order_check_unavailable" && !action.includes("pending_order_check_unavailable")) continue;
    reviewBlockerReasons.push(blocker);
    reviewBlockerKeys.add(key);
  }

  for (const blocker of reviewBlockerReasons) {
    const action = asString(blocker.action) ?? "";
    const reason = asString(blocker.reason) ?? "";
    const count = asNumber(blocker.count) ?? 0;
    if (count <= 0) continue;

    const evidence = { action, reason, count, symbols: blocker.symbols ?? [] };
    if (reason === "daily_loss_soft_guard" || action.includes("daily_loss_soft_guard")) {
      addSuggestion({
        priority: "high",
        direction: "tighten",
        target: "daily_loss_entry_guard",
        config_keys: [
          "daily_loss_entry_guard_enabled",
          "daily_loss_entry_guard_pct",
          "daily_loss_guard_min_confidence",
          "daily_loss_guard_min_entry_quality",
          "max_daily_loss_pct",
        ],
        proposed_config_patch: {
          daily_loss_entry_guard_enabled: true,
          daily_loss_entry_guard_pct: clamp(Math.min(config.daily_loss_entry_guard_pct ?? 0.0075, 0.005), 0, 1),
          daily_loss_guard_min_confidence: clamp(
            Math.max(config.daily_loss_guard_min_confidence ?? 0.8, 0.85),
            0,
            1
          ),
          daily_loss_guard_min_entry_quality:
            config.daily_loss_guard_min_entry_quality === "excellent" ? "excellent" : "good",
          max_daily_loss_pct: clamp(Math.min(config.max_daily_loss_pct ?? 0.02, 0.015), 0.001, 1),
        },
        evidence,
        suggestion:
          "The daily-loss soft guard is being hit. Keep the guard enabled and require stronger confidence after intraday drawdown instead of trying to trade out of a losing day.",
      });
    } else if (
      reason === "open_position_loss_guard" ||
      reason === "open_position_loss_entry_guard" ||
      action.includes("open_position_loss_guard")
    ) {
      addSuggestion({
        priority: "high",
        direction: "tighten",
        target: "open_position_loss_entry_guard",
        config_keys: [
          "open_position_loss_entry_guard_enabled",
          "open_position_loss_entry_guard_pct",
          "open_position_loss_guard_min_confidence",
          "open_position_loss_guard_min_entry_quality",
        ],
        proposed_config_patch: {
          open_position_loss_entry_guard_enabled: true,
          open_position_loss_entry_guard_pct: clamp(
            Math.min(config.open_position_loss_entry_guard_pct ?? 0.01, 0.01),
            0,
            1
          ),
          open_position_loss_guard_min_confidence: clamp(
            Math.max(config.open_position_loss_guard_min_confidence ?? 0.85, 0.85),
            0,
            1
          ),
          open_position_loss_guard_min_entry_quality:
            config.open_position_loss_guard_min_entry_quality === "excellent" ? "excellent" : "good",
        },
        evidence,
        suggestion:
          "Open positions are in aggregate drawdown while new buys are being considered. Keep this guard enabled so the agent waits for unusually strong entries before adding risk to a losing open book.",
      });
    } else if (action.includes("daily_entry_limit")) {
      addSuggestion({
        priority: "medium",
        direction: closedTrades >= 10 && totalWinRate >= 0.55 ? "investigate" : "tighten",
        target: "daily_entry_frequency",
        config_keys: ["max_daily_entry_orders", "min_minutes_between_entries", "adaptive_performance_block_enabled"],
        proposed_config_patch:
          closedTrades >= 10 && totalWinRate >= 0.55
            ? undefined
            : {
                max_daily_entry_orders: Math.max(1, Math.min(config.max_daily_entry_orders ?? 8, 5)),
                min_minutes_between_entries: clamp(Math.max(config.min_minutes_between_entries ?? 5, 10), 0, 1440),
                adaptive_performance_block_enabled: true,
              },
        evidence,
        suggestion:
          "The daily entry limit is being reached. Unless recent trade buckets prove high-frequency entries are winning, cap daily entries and increase spacing to reduce marginal late-day setups.",
      });
    } else if (action.includes("entry_spacing")) {
      addSuggestion({
        priority: "medium",
        direction: "tighten",
        target: "entry_spacing",
        config_keys: ["min_minutes_between_entries", "max_daily_entry_orders"],
        proposed_config_patch: {
          min_minutes_between_entries: clamp(Math.max(config.min_minutes_between_entries ?? 5, 10), 0, 1440),
          max_daily_entry_orders: Math.max(1, Math.min(config.max_daily_entry_orders ?? 8, 6)),
        },
        evidence,
        suggestion:
          "Entry spacing is blocking clustered buys. Keep spacing conservative so the agent does not stack correlated entries before the first setup has proved itself.",
      });
    } else if (reason === "overextended_entry" || action.includes("overextended_entry")) {
      addSuggestion({
        priority: "medium",
        direction: "tighten",
        target: "policy_overextended_entry_guard",
        config_keys: ["max_entry_price_change_pct", "entry_timing_enabled", "entry_max_intraday_range_position"],
        proposed_config_patch: {
          max_entry_price_change_pct: clamp(Math.min(config.max_entry_price_change_pct ?? 5, 5), 0, 100),
          entry_timing_enabled: true,
          entry_max_intraday_range_position: clamp(
            Math.min(config.entry_max_intraday_range_position ?? 0.75, 0.7),
            0,
            1
          ),
        },
        evidence,
        suggestion:
          "The policy broker is blocking overextended equity entries. Keep this chase guard tight and prefer pullback entries unless missed-entry review proves these blocked moves kept running.",
      });
    } else if (reason === "thin_quote" || action.includes("thin_quote")) {
      addSuggestion({
        priority: "medium",
        direction: "tighten",
        target: "thin_quote_liquidity",
        config_keys: ["min_entry_quote_size", "max_entry_spread_pct", "ticker_blacklist", "allowed_exchanges"],
        proposed_config_patch: {
          min_entry_quote_size: Math.max(config.min_entry_quote_size ?? 1, 1),
          max_entry_spread_pct: clamp(Math.min(config.max_entry_spread_pct ?? 0.8, 0.8), 0, 10),
        },
        evidence,
        suggestion:
          "Thin quotes are blocking buys. Treat this as a fill-quality warning: keep quote-size and spread filters tight, and review the symbols before allowing more illiquid entries.",
      });
    } else if (reason === "averaging_down_blocked" || action.includes("averaging_down")) {
      addSuggestion({
        priority: "medium",
        direction: "investigate",
        target: "averaging_down_guard",
        config_keys: [],
        evidence,
        suggestion:
          "The policy layer is blocking attempts to add to losing positions. Keep this guard active unless trade-review logs prove that deliberate add-ons to drawdowns have positive expectancy.",
      });
    } else if (reason === "pending_order_check_unavailable" || action.includes("pending_order_check_unavailable")) {
      const isOptionsEntry = action.includes("options_");
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: isOptionsEntry ? "options_entry_order_status_visibility" : "entry_order_status_visibility",
        config_keys: [],
        evidence,
        suggestion:
          isOptionsEntry
            ? "The broker pending-order check is unavailable before options entries. Keep options buys blocked until order-list visibility recovers so the agent cannot duplicate pending option contracts."
            : "The broker pending-order check is unavailable before entries. Keep buys blocked until order-list visibility recovers so the agent cannot duplicate pending buys or exceed intended capacity.",
      });
    }
  }

  for (const blocker of exitBlockers.slice(0, 8)) {
    const action = asString(blocker.action) ?? "";
    const count = asNumber(blocker.count) ?? 0;
    if (!action || count <= 0) continue;

    const evidence = { action, count, symbols: blocker.symbols ?? [] };
    if (action.includes("llm_sell_blocked")) {
      addSuggestion({
        priority: "medium",
        direction: "investigate",
        target: "llm_sell_min_hold_gate",
        config_keys: ["llm_min_hold_minutes", "llm_force_sell_pnl_pct", "llm_force_sell_min_confidence"],
        proposed_config_patch: {
          llm_min_hold_minutes: clamp(Math.min(config.llm_min_hold_minutes ?? 30, 20), 0, 1440),
          llm_force_sell_pnl_pct: clamp(Math.min(config.llm_force_sell_pnl_pct ?? 2, 2), 0, 50),
          llm_force_sell_min_confidence: clamp(Math.min(config.llm_force_sell_min_confidence ?? 0.65, 0.65), 0, 1),
        },
        evidence,
        suggestion:
          "LLM sell recommendations are being blocked by the minimum-hold gate. Keep the gate, but allow faster risk-reducing exits when losses breach the configured force-sell threshold.",
      });
    } else if (action.includes("sell_blocked_pending_order")) {
      addSuggestion({
        priority: "medium",
        direction: "investigate",
        target: "exit_pending_order_block",
        config_keys: ["after_hours_exit_limit_buffer_pct"],
        evidence,
        suggestion:
          "Exit attempts are blocked by an existing pending sell order. Review broker open orders and cancellation/reconciliation behavior before assuming exits are executing.",
      });
    } else if (action.includes("sell_pending_order_check_unavailable")) {
      addSuggestion({
        priority: "medium",
        direction: "investigate",
        target: "exit_order_status_visibility",
        config_keys: [],
        evidence,
        suggestion:
          "The broker pending-order check is unavailable during exit. Treat this as an execution visibility issue; verify Alpaca order-list access and avoid adding exposure until sell status checks recover.",
      });
    } else if (action.includes("deferred_sell_canceled_stale_exit")) {
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: "stale_exit_order_repricing",
        config_keys: ["after_hours_exit_limit_buffer_pct"],
        proposed_config_patch: {
          after_hours_exit_limit_buffer_pct: clamp(Math.max(config.after_hours_exit_limit_buffer_pct ?? 0.25, 0.5), 0, 5),
        },
        evidence,
        suggestion:
          "A risk-reducing sell order stayed open too long and was canceled for repricing. Inspect fill quality and consider a wider after-hours exit limit buffer so exits do not sit stale while risk remains open.",
      });
    } else if (action.includes("sell_outcome_deferred") || action.includes("deferred_sell_partially_filled")) {
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: "incomplete_exit_fill_tracking",
        config_keys: ["after_hours_exit_limit_buffer_pct"],
        proposed_config_patch: action.includes("deferred_sell_partially_filled")
          ? {
              after_hours_exit_limit_buffer_pct: clamp(
                Math.max(config.after_hours_exit_limit_buffer_pct ?? 0.25, 0.5),
                0,
                5
              ),
            }
          : undefined,
        evidence,
        suggestion:
          "Exit orders are not fully filled yet. Keep the trade journal open, verify residual position size, and review limit pricing so risk-reducing sells do not linger as partial or submitted orders.",
      });
    } else if (action.includes("sell_failed")) {
      addSuggestion({
        priority: "high",
        direction: "investigate",
        target: "exit_execution_failure",
        config_keys: ["after_hours_exit_limit_buffer_pct"],
        proposed_config_patch: {
          after_hours_exit_limit_buffer_pct: clamp(Math.max(config.after_hours_exit_limit_buffer_pct ?? 0.25, 0.5), 0, 5),
        },
        evidence,
        suggestion:
          "Sell execution is failing. Prioritize broker/API investigation and consider a wider after-hours exit limit buffer so risk-reducing exits have a better chance to fill outside regular hours.",
      });
    }
  }

  if (config.adaptive_performance_block_enabled && weakBuckets.length > 0) {
    addSuggestion({
      priority: "low",
      direction: "investigate",
      target: "adaptive_blocks",
      config_keys: [
        "adaptive_performance_block_enabled",
        "adaptive_performance_min_trades",
        "adaptive_performance_min_win_rate",
      ],
      proposed_config_patch: {
        adaptive_performance_block_enabled: true,
        adaptive_performance_min_trades: clamp(config.adaptive_performance_min_trades ?? 3, 2, 100),
      },
      evidence: {
        weak_bucket_count: weakBuckets.length,
        min_trades: config.adaptive_performance_min_trades,
        min_win_rate: config.adaptive_performance_min_win_rate,
      },
      suggestion:
        "Adaptive blocks have weak patterns to learn from. Keep them enabled, but avoid setting min_trades too low if a few noisy trades block too much.",
    });
  }

  return suggestions.sort((a, b) => {
    const priorityRank = { high: 0, medium: 1, low: 2 } satisfies Record<
      TradeReviewTuningSuggestion["priority"],
      number
    >;
    return priorityRank[a.priority] - priorityRank[b.priority] || a.target.localeCompare(b.target);
  });
}

// ============================================================================
// DURABLE OBJECT CLASS
// ============================================================================

export class MahoragaHarness extends DurableObject<Env> {
  private state: AgentState = { ...DEFAULT_STATE };
  private _llm: LLMProvider | null = null;
  private _etDayFormatter: Intl.DateTimeFormat | null = null;
  private discordCooldowns: Map<string, number> = new Map();
  private readonly DISCORD_COOLDOWN_MS = 30 * 60 * 1000;

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
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
        this.state.config = mergeAgentConfigWithDefaults(this.state.config);
        this.state.recentSells = this.state.recentSells ?? {};
        this.state.missedEntryOpportunities = this.state.missedEntryOpportunities ?? {};
        this.state.lastDiscordDailyReportDay = this.state.lastDiscordDailyReportDay ?? null;
      }
      this.initializeLLM();

      if (this.state.enabled) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        const now = Date.now();
        if (!existingAlarm || existingAlarm < now) {
          await this.ctx.storage.setAlarm(now + 5_000);
        }
      }
    });
  }

  private initializeLLM() {
    const provider = this.state.config.llm_provider || this.env.LLM_PROVIDER || "openai-raw";
    const model = this.state.config.llm_model || this.env.LLM_MODEL || "gpt-4o-mini";

    const effectiveEnv: Env = {
      ...this.env,
      LLM_PROVIDER: provider as Env["LLM_PROVIDER"],
      LLM_MODEL: model,
      OPENAI_BASE_URL: this.state.config.openai_base_url || this.env.OPENAI_BASE_URL,
    };

    this._llm = createLLMProvider(effectiveEnv);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${provider} (${model})`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured");
    }
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

  private normalizeStateSymbol(symbol: string): string {
    return normalizeCryptoSymbol(symbol.trim().toUpperCase());
  }

  private getPositionEntry(symbol: string): PositionEntry | undefined {
    return this.state.positionEntries[symbol] ?? this.state.positionEntries[this.normalizeStateSymbol(symbol)];
  }

  private setPositionEntry(symbol: string, entry: PositionEntry): void {
    const symbolKey = this.normalizeStateSymbol(symbol);
    this.state.positionEntries[symbolKey] = { ...entry, symbol: symbolKey };
  }

  private enrichPositionEntryWithExecutionMetadata(
    entry: PositionEntry,
    metadata?: Record<string, unknown>
  ): PositionEntry {
    const quoteMid = asNumber(metadata?.entry_quote_mid) ?? asNumber(metadata?.quote_mid);
    if (quoteMid === null || quoteMid <= 0 || !Number.isFinite(entry.entry_price) || entry.entry_price <= 0) {
      return entry;
    }

    return {
      ...entry,
      entry_quote_mid: quoteMid,
      entry_slippage_pct: Number((((entry.entry_price - quoteMid) / quoteMid) * 100).toFixed(4)),
    };
  }

  private updatePositionEntryPriceExtremes(symbol: string, currentPrice: number): PositionEntry | undefined {
    const entry = this.getPositionEntry(symbol);
    if (!entry || !Number.isFinite(currentPrice) || currentPrice <= 0) return entry;
    entry.peak_price = Math.max(entry.peak_price || entry.entry_price || currentPrice, currentPrice);
    entry.trough_price = Math.min(entry.trough_price ?? entry.entry_price ?? currentPrice, currentPrice);
    this.setPositionEntry(symbol, entry);
    return entry;
  }

  private async restoreMissingPositionEntriesFromJournal(positions: Position[]): Promise<void> {
    const missing = positions.filter((position) => !this.getPositionEntry(position.symbol));
    if (missing.length === 0) return;

    const db = createD1Client(this.env.DB);
    for (const position of missing) {
      const symbolKey = this.normalizeStateSymbol(position.symbol);
      try {
        const row = await db.executeOne<
          Pick<
            import("../storage/d1/client").TradeJournalRow,
            "symbol" | "entry_price" | "entry_at" | "created_at" | "signals_json" | "notes"
          >
        >(
          `SELECT symbol, entry_price, entry_at, created_at, signals_json, notes
           FROM trade_journal
           WHERE symbol IN (?, ?) AND exit_at IS NULL
           ORDER BY COALESCE(entry_at, created_at) DESC
           LIMIT 1`,
          [position.symbol, symbolKey]
        );
        if (!row) continue;

        const entry = buildRecoveredPositionEntryFromJournal(row, position);
        if (!entry) continue;
        this.setPositionEntry(position.symbol, entry);
        this.log("System", "position_entry_restored_from_journal", {
          symbol: position.symbol,
          journal_symbol: row.symbol,
          entry_at: row.entry_at,
          entry_price: entry.entry_price,
        });
      } catch (error) {
        this.log("System", "position_entry_restore_failed", { symbol: position.symbol, error: String(error) });
      }
    }
  }

  private getPositionLifecycleMetadata(symbol: string, exitPrice?: number): Record<string, unknown> | undefined {
    const entry = this.getPositionEntry(symbol);
    if (!entry || !Number.isFinite(entry.entry_price) || entry.entry_price <= 0) return undefined;

    const peakPrice = Math.max(entry.peak_price || entry.entry_price, entry.entry_price);
    const troughPrice = Math.min(entry.trough_price ?? entry.entry_price, entry.entry_price);
    const mfePct = ((peakPrice - entry.entry_price) / entry.entry_price) * 100;
    const maePct = ((troughPrice - entry.entry_price) / entry.entry_price) * 100;
    const exitGainPct =
      exitPrice !== undefined && Number.isFinite(exitPrice) && exitPrice > 0
        ? ((exitPrice - entry.entry_price) / entry.entry_price) * 100
        : null;
    const givebackPct = exitGainPct === null ? null : Math.max(0, mfePct - Math.max(0, exitGainPct));
    const exitEfficiencyPct =
      exitGainPct === null || mfePct <= 0 ? null : Math.max(0, Math.min(100, (exitGainPct / mfePct) * 100));

    return {
      entry_price: entry.entry_price,
      peak_price: peakPrice,
      trough_price: troughPrice,
      mfe_pct: Number(mfePct.toFixed(4)),
      mae_pct: Number(maePct.toFixed(4)),
      ...(exitPrice !== undefined && Number.isFinite(exitPrice) && exitPrice > 0
        ? { exit_price: Number(exitPrice.toFixed(4)) }
        : {}),
      ...(exitGainPct !== null ? { exit_gain_pct: Number(exitGainPct.toFixed(4)) } : {}),
      ...(givebackPct !== null ? { giveback_pct: Number(givebackPct.toFixed(4)) } : {}),
      ...(exitEfficiencyPct !== null ? { exit_efficiency_pct: Number(exitEfficiencyPct.toFixed(4)) } : {}),
      entry_time: entry.entry_time,
      entry_reason: entry.entry_reason,
    };
  }

  private findPositionForSymbol(positions: Position[], symbol: string): Position | undefined {
    const symbolKey = this.normalizeStateSymbol(symbol);
    return positions.find((position) => this.normalizeStateSymbol(position.symbol) === symbolKey);
  }

  private getPositionEntryPrice(position: Position | undefined): number {
    if (!position) return 0;
    return position.avg_entry_price || position.current_price || position.lastday_price || 0;
  }

  private async getFilledPosition(ctx: StrategyContext, symbol: string): Promise<Position | undefined> {
    try {
      return this.findPositionForSymbol(await ctx.broker.getPositions(), symbol);
    } catch (error) {
      this.log("System", "entry_position_lookup_failed", { symbol, error: String(error) });
      return undefined;
    }
  }

  private getSnapshotPrice(snapshot: {
    latest_trade?: { price?: number };
    latest_quote?: { ask_price?: number; bid_price?: number };
  }): number {
    const tradePrice = Number(snapshot.latest_trade?.price);
    if (Number.isFinite(tradePrice) && tradePrice > 0) return tradePrice;
    const ask = Number(snapshot.latest_quote?.ask_price);
    const bid = Number(snapshot.latest_quote?.bid_price);
    if (Number.isFinite(ask) && ask > 0 && Number.isFinite(bid) && bid > 0) return (ask + bid) / 2;
    if (Number.isFinite(ask) && ask > 0) return ask;
    if (Number.isFinite(bid) && bid > 0) return bid;
    return 0;
  }

  private async getReferencePrice(symbol: string): Promise<number> {
    const alpaca = createAlpacaProviders(this.env);
    const crypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
    const snapshot = crypto
      ? await alpaca.marketData.getCryptoSnapshot(normalizeCryptoSymbol(symbol))
      : await alpaca.marketData.getSnapshot(symbol);
    return this.getSnapshotPrice(snapshot);
  }

  private async enrichEntryExecutionMetadata(
    symbol: string,
    metadata?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const enriched = { ...(metadata ?? {}) };
    try {
      const alpaca = createAlpacaProviders(this.env);
      const crypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
      const snapshot = crypto
        ? await alpaca.marketData.getCryptoSnapshot(normalizeCryptoSymbol(symbol))
        : await alpaca.marketData.getSnapshot(symbol);
      const referencePrice = this.getSnapshotPrice(snapshot);
      const prevClose = Number(snapshot.prev_daily_bar?.c);
      if (Number.isFinite(referencePrice) && referencePrice > 0) {
        enriched.entry_reference_price = Number(referencePrice.toFixed(6));
      }
      const bid = Number(snapshot.latest_quote?.bid_price);
      const ask = Number(snapshot.latest_quote?.ask_price);
      if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0 && ask >= bid) {
        enriched.entry_quote_bid = Number(bid.toFixed(6));
        enriched.entry_quote_ask = Number(ask.toFixed(6));
        enriched.entry_quote_mid = Number(((bid + ask) / 2).toFixed(6));
        enriched.entry_spread_pct = Number((((ask - bid) / ask) * 100).toFixed(4));
      }
      if (Number.isFinite(prevClose) && prevClose > 0 && Number.isFinite(referencePrice) && referencePrice > 0) {
        enriched.entry_prev_close = Number(prevClose.toFixed(6));
        enriched.entry_price_change_pct = Number((((referencePrice - prevClose) / prevClose) * 100).toFixed(4));
      }
      const volume = Number(snapshot.daily_bar?.v);
      if (Number.isFinite(volume) && volume >= 0) {
        enriched.entry_daily_volume = volume;
      }
    } catch (error) {
      this.log("System", "entry_execution_metadata_unavailable", { symbol, reason: String(error) });
    }

    return enriched;
  }

  private pruneMissedEntryOpportunities(now = Date.now()): void {
    const maxAgeMs = 48 * 60 * 60 * 1000;
    const entries = Object.entries(this.state.missedEntryOpportunities ?? {});
    for (const [id, opportunity] of entries) {
      if (now - opportunity.blocked_at > maxAgeMs) delete this.state.missedEntryOpportunities[id];
    }

    const remaining = Object.entries(this.state.missedEntryOpportunities ?? {}).sort(
      ([, a], [, b]) => b.blocked_at - a.blocked_at
    );
    for (const [id] of remaining.slice(80)) delete this.state.missedEntryOpportunities[id];
  }

  private async recordMissedEntryOpportunity(
    symbol: string,
    reason: string,
    options: {
      agent: string;
      action: string;
      confidence?: number;
      entryQuality?: ResearchResult["entry_quality"];
      notional?: number;
    }
  ): Promise<void> {
    const now = Date.now();
    this.state.missedEntryOpportunities = this.state.missedEntryOpportunities ?? {};
    this.pruneMissedEntryOpportunities(now);

    const symbolKey = this.normalizeStateSymbol(symbol);
    const duplicate = Object.values(this.state.missedEntryOpportunities).find(
      (opportunity) =>
        opportunity.symbol_key === symbolKey &&
        opportunity.reason === reason &&
        now - opportunity.blocked_at < 30 * 60 * 1000
    );
    if (duplicate) return;

    try {
      const blockedPrice = await this.getReferencePrice(symbol);
      if (!Number.isFinite(blockedPrice) || blockedPrice <= 0) return;

      const id = `${symbolKey}:${reason}:${now}`;
      this.state.missedEntryOpportunities[id] = {
        id,
        symbol,
        symbol_key: symbolKey,
        blocked_at: now,
        blocked_price: blockedPrice,
        reason,
        agent: options.agent,
        action: options.action,
        confidence: options.confidence,
        entry_quality: options.entryQuality,
        notional: options.notional,
      };
      this.log(options.agent, "missed_entry_recorded", {
        symbol,
        reason,
        blocked_action: options.action,
        blocked_price: blockedPrice,
        confidence: options.confidence,
        quality: options.entryQuality,
        notional: options.notional,
      });
    } catch (error) {
      this.log("System", "missed_entry_record_failed", { symbol, reason, error: String(error) });
    }
  }

  private async evaluateMissedEntryOpportunities(): Promise<void> {
    const now = Date.now();
    const minAgeMs = 4 * 60 * 60 * 1000;
    this.state.missedEntryOpportunities = this.state.missedEntryOpportunities ?? {};
    this.pruneMissedEntryOpportunities(now);

    const due = Object.values(this.state.missedEntryOpportunities)
      .filter((opportunity) => !opportunity.evaluated_at && now - opportunity.blocked_at >= minAgeMs)
      .sort((a, b) => a.blocked_at - b.blocked_at)
      .slice(0, 10);

    for (const opportunity of due) {
      try {
        const evaluationPrice = await this.getReferencePrice(opportunity.symbol);
        if (!Number.isFinite(evaluationPrice) || evaluationPrice <= 0) continue;
        const changePct = ((evaluationPrice - opportunity.blocked_price) / opportunity.blocked_price) * 100;
        opportunity.evaluated_at = now;
        opportunity.evaluation_price = evaluationPrice;
        opportunity.change_pct = Number(changePct.toFixed(4));
        this.state.missedEntryOpportunities[opportunity.id] = opportunity;
        this.log(opportunity.agent || "System", "missed_entry_evaluated", {
          symbol: opportunity.symbol,
          reason: opportunity.reason,
          blocked_action: opportunity.action,
          blocked_price: opportunity.blocked_price,
          evaluation_price: evaluationPrice,
          change_pct: opportunity.change_pct,
          age_hours: Number(((now - opportunity.blocked_at) / (60 * 60 * 1000)).toFixed(2)),
          confidence: opportunity.confidence,
          quality: opportunity.entry_quality,
        });
      } catch (error) {
        this.log("System", "missed_entry_evaluation_failed", {
          symbol: opportunity.symbol,
          reason: opportunity.reason,
          error: String(error),
        });
      }
    }
  }

  private async reconcileDeferredBuyJournals(): Promise<void> {
    const db = createD1Client(this.env.DB);
    const deferredTrades = await db.execute<{
      id: string;
      alpaca_order_id: string;
      symbol: string;
      side: string;
      qty: number;
      order_type: string;
      limit_price: number | null;
      status: string;
      created_at: string;
    }>(
      `SELECT t.id, t.alpaca_order_id, t.symbol, t.side, t.qty, t.order_type, t.limit_price, t.status, t.created_at
       FROM trades t
       LEFT JOIN trade_journal tj ON tj.trade_id = t.id
       WHERE t.side = 'buy'
         AND tj.id IS NULL
         AND t.status NOT IN ('canceled', 'expired', 'rejected')
       ORDER BY t.created_at ASC
       LIMIT 25`
    );

    if (deferredTrades.length === 0) return;

    const alpaca = createAlpacaProviders(this.env);
    const r2 = createR2Client(this.env.ARTIFACTS);

    for (const trade of deferredTrades) {
      try {
        const order = await alpaca.trading.getOrder(trade.alpaca_order_id);
        const filledQty = asNumber(order.filled_qty) ?? undefined;
        const filledAvgPrice = asNumber(order.filled_avg_price) ?? undefined;
        await updateTradeStatus(db, trade.id, order.status, filledQty, filledAvgPrice);

        const orderFilled = order.status === "filled" || order.status === "partially_filled";
        if (!orderFilled) {
          const staleOrder = shouldCancelStaleDeferredBuyOrder(
            order,
            this.state.config.max_entry_research_age_minutes ?? 30
          );
          if (staleOrder.cancel) {
            try {
              await alpaca.trading.cancelOrder(trade.alpaca_order_id);
              await updateTradeStatus(db, trade.id, "canceled", filledQty, filledAvgPrice);
              this.log("PolicyBroker", "deferred_buy_canceled_stale_signal", {
                symbol: trade.symbol,
                order_id: trade.alpaca_order_id,
                status: order.status,
                age_minutes: staleOrder.ageMinutes,
                max_entry_research_age_minutes: this.state.config.max_entry_research_age_minutes ?? 30,
              });
            } catch (cancelError) {
              this.log("PolicyBroker", "deferred_buy_cancel_failed", {
                symbol: trade.symbol,
                order_id: trade.alpaca_order_id,
                status: order.status,
                age_minutes: staleOrder.ageMinutes,
                error: String(cancelError),
              });
            }
          }
          continue;
        }

        const parsedOption = parseOccOptionSymbol(trade.symbol);
        const entryPrice = filledAvgPrice ?? trade.limit_price ?? 0;
        const qty = filledQty ?? trade.qty;
        const regimeTags = parsedOption
          ? ["autonomous", "options", "policy_broker", "reconciled_fill"]
          : ["autonomous", "policy_broker", "reconciled_fill"];
        const originalSnapshot = await r2.getJson(R2Paths.tradeSnapshot(trade.id)).catch(() => null);
        const originalSnapshotRecord =
          originalSnapshot && typeof originalSnapshot === "object" && !Array.isArray(originalSnapshot)
            ? (originalSnapshot as Record<string, unknown>)
            : null;
        const originalPolicy = originalSnapshotRecord ? getNestedRecord(originalSnapshotRecord, "policy") : null;
        const originalAccount = originalSnapshotRecord ? getNestedRecord(originalSnapshotRecord, "account") : null;

        await createJournalEntry(db, {
          trade_id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          entry_price: entryPrice,
          qty,
          signals: buildDeferredBuyJournalSignals(originalSnapshot, {
            reason: "deferred_buy_fill_reconciliation",
            alpaca_order_id: trade.alpaca_order_id,
            order_status: order.status,
          }),
          technicals: parsedOption
            ? {
                underlying: parsedOption.underlying,
                expiration: parsedOption.expiration,
                option_type: parsedOption.optionType,
                strike: parsedOption.strike,
                account_equity: asNumber(originalAccount?.equity),
                account_cash: asNumber(originalAccount?.cash),
              }
            : {
                account_equity: asNumber(originalAccount?.equity),
                account_cash: asNumber(originalAccount?.cash),
              },
          regime_tags: regimeTags,
          notes: "Reconciled deferred BUY fill",
        });

        const entryTime = asString(order.filled_at) ? new Date(asString(order.filled_at)!).getTime() : Date.now();
        const normalizedSymbol = this.normalizeStateSymbol(trade.symbol);
        const socialSnapshot = this.getSocialSnapshotCache();
        const social = socialSnapshot[trade.symbol] ?? socialSnapshot[normalizedSymbol];
        this.setPositionEntry(trade.symbol, {
          symbol: normalizedSymbol,
          entry_time: Number.isFinite(entryTime) ? entryTime : Date.now(),
          entry_price: entryPrice,
          entry_sentiment: social?.sentiment ?? 0,
          entry_social_volume: social?.volume ?? 0,
          entry_sources: social?.sources ?? [parsedOption ? "reconciled_options_fill" : "reconciled_buy_fill"],
          entry_reason: "Reconciled deferred BUY fill",
          peak_price: entryPrice,
          trough_price: entryPrice,
          peak_sentiment: social?.sentiment ?? 0,
        });
        this.clearRecentSell(trade.symbol);

        await r2.putJson(R2Paths.tradeSnapshot(trade.id), {
          trade_id: trade.id,
          exported_from: "deferred_buy_reconciliation",
          captured_at: new Date().toISOString(),
          symbol: trade.symbol,
          side: trade.side,
          status: order.status,
          filled_qty: filledQty,
          filled_avg_price: filledAvgPrice,
          original_metadata: originalSnapshotRecord ? getNestedRecord(originalSnapshotRecord, "metadata") : null,
          original_policy: originalPolicy,
          order,
        });

        this.log("PolicyBroker", "deferred_buy_reconciled", {
          symbol: trade.symbol,
          order_id: trade.alpaca_order_id,
          status: order.status,
          filled_qty: filledQty,
          filled_avg_price: filledAvgPrice,
        });
        await this.sendTradeExecutionNotification("buy", trade.symbol, {
          notional: entryPrice * qty,
          reason: "Reconciled deferred BUY fill",
        });
      } catch (error) {
        this.log("PolicyBroker", "deferred_buy_reconcile_failed", {
          symbol: trade.symbol,
          order_id: trade.alpaca_order_id,
          error: String(error),
        });
      }
    }
  }

  private async reconcileDeferredSellJournals(): Promise<void> {
    const db = createD1Client(this.env.DB);
    const deferredTrades = await db.execute<{
      id: string;
      alpaca_order_id: string;
      symbol: string;
      side: string;
      qty: number;
      order_type: string;
      limit_price: number | null;
      status: string;
      created_at: string;
    }>(
      `SELECT id, alpaca_order_id, symbol, side, qty, order_type, limit_price, status, created_at
       FROM trades
       WHERE side = 'sell'
         AND status NOT IN ('filled', 'canceled', 'expired', 'rejected')
       ORDER BY created_at ASC
       LIMIT 25`
    );

    if (deferredTrades.length === 0) return;

    const alpaca = createAlpacaProviders(this.env);
    const r2 = createR2Client(this.env.ARTIFACTS);
    const policyConfig = getDefaultPolicyConfig(this.env);

    for (const trade of deferredTrades) {
      try {
        const order = await alpaca.trading.getOrder(trade.alpaca_order_id);
        const filledQty = asNumber(order.filled_qty) ?? undefined;
        const filledAvgPrice = asNumber(order.filled_avg_price) ?? undefined;
        await updateTradeStatus(db, trade.id, order.status, filledQty, filledAvgPrice);

        if (!isDeferredSellComplete(order)) {
          const orderStatus = (order.status || "").toLowerCase();
          if (orderStatus === "partially_filled") {
            await r2.putJson(R2Paths.tradeSnapshot(trade.id), {
              trade_id: trade.id,
              exported_from: "deferred_sell_partial_reconciliation",
              captured_at: new Date().toISOString(),
              symbol: trade.symbol,
              side: trade.side,
              status: order.status,
              filled_qty: filledQty,
              filled_avg_price: filledAvgPrice,
              order,
            });
            this.log("PolicyBroker", "deferred_sell_partially_filled", {
              symbol: trade.symbol,
              order_id: trade.alpaca_order_id,
              status: order.status,
              filled_qty: filledQty,
              filled_avg_price: filledAvgPrice,
              reason: "Sell order only partially filled; leaving trade journal and position tracking open",
            });
            continue;
          }

          const staleOrder = shouldCancelStaleDeferredSellOrder(order, 15);
          if (staleOrder.cancel) {
            try {
              await alpaca.trading.cancelOrder(trade.alpaca_order_id);
              await updateTradeStatus(db, trade.id, "canceled", filledQty, filledAvgPrice);
              this.log("PolicyBroker", "deferred_sell_canceled_stale_exit", {
                symbol: trade.symbol,
                order_id: trade.alpaca_order_id,
                status: order.status,
                order_type: trade.order_type,
                age_minutes: staleOrder.ageMinutes,
                max_age_minutes: 15,
              });
            } catch (cancelError) {
              this.log("PolicyBroker", "deferred_sell_cancel_failed", {
                symbol: trade.symbol,
                order_id: trade.alpaca_order_id,
                status: order.status,
                order_type: trade.order_type,
                age_minutes: staleOrder.ageMinutes,
                error: String(cancelError),
              });
            }
          }
          continue;
        }

        const aliases = this.symbolAliases(trade.symbol);
        const placeholders = aliases.map(() => "?").join(", ");
        const openJournal = await db.executeOne<{
          id: string;
          entry_price: number | null;
          entry_at: string | null;
          qty: number | null;
        }>(
          `SELECT id, entry_price, entry_at, qty
           FROM trade_journal
           WHERE symbol IN (${placeholders})
             AND exit_at IS NULL
           ORDER BY COALESCE(entry_at, created_at) DESC
           LIMIT 1`,
          aliases
        );

        if (!openJournal) {
          this.log("PolicyBroker", "deferred_sell_reconcile_no_open_journal", {
            symbol: trade.symbol,
            order_id: trade.alpaca_order_id,
            status: order.status,
          });
          continue;
        }

        const entryPrice = asNumber(openJournal.entry_price) ?? 0;
        const exitPrice = filledAvgPrice ?? asNumber(order.limit_price) ?? trade.limit_price ?? 0;
        const qty = filledQty ?? asNumber(openJournal.qty) ?? trade.qty;
        if (entryPrice <= 0 || exitPrice <= 0 || !qty || qty <= 0) {
          this.log("PolicyBroker", "deferred_sell_reconcile_missing_price", {
            symbol: trade.symbol,
            order_id: trade.alpaca_order_id,
            entry_price: entryPrice,
            exit_price: exitPrice,
            qty,
          });
          continue;
        }

        const realizedOutcome = calculateTradeOutcome({
          entryPrice,
          exitPrice,
          qty,
          entryAt: openJournal.entry_at,
        });
        if (!realizedOutcome) {
          this.log("PolicyBroker", "deferred_sell_reconcile_invalid_outcome", {
            symbol: trade.symbol,
            order_id: trade.alpaca_order_id,
            entry_price: entryPrice,
            exit_price: exitPrice,
            qty,
          });
          continue;
        }

        const lifecycleMetadata = this.getPositionLifecycleMetadata(trade.symbol, realizedOutcome.exitPrice);
        await logOutcome(db, {
          journal_id: openJournal.id,
          exit_price: realizedOutcome.exitPrice,
          pnl_usd: realizedOutcome.pnlUsd,
          pnl_pct: realizedOutcome.pnlPct,
          hold_duration_mins: realizedOutcome.holdDurationMins,
          outcome: realizedOutcome.outcome,
          lessons_learned: "Reconciled deferred SELL fill",
          signal_updates: lifecycleMetadata
            ? {
                exit_reason: "Reconciled deferred SELL fill",
                lifecycle: lifecycleMetadata,
                ...lifecycleMetadata,
              }
            : { exit_reason: "Reconciled deferred SELL fill" },
        });

        if (realizedOutcome.outcome === "loss") {
          await recordDailyLoss(db, Math.abs(realizedOutcome.pnlUsd));
          const cooldownMinutes = policyConfig.cooldown_minutes_after_loss;
          if (cooldownMinutes > 0) {
            await setCooldown(db, new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString());
          }
        }

        await r2.putJson(R2Paths.tradeSnapshot(trade.id), {
          trade_id: trade.id,
          exported_from: "deferred_sell_reconciliation",
          captured_at: new Date().toISOString(),
          symbol: trade.symbol,
          side: trade.side,
          status: order.status,
          filled_qty: filledQty,
          filled_avg_price: filledAvgPrice,
          entry_price: entryPrice,
          exit_price: realizedOutcome.exitPrice,
          pnl_usd: realizedOutcome.pnlUsd,
          pnl_pct: realizedOutcome.pnlPct,
          outcome: realizedOutcome.outcome,
          lifecycle_metadata: lifecycleMetadata,
          order,
        });
        this.recordSellAndClearPosition(trade.symbol, "Reconciled deferred SELL fill");

        this.log("PolicyBroker", "deferred_sell_reconciled", {
          symbol: trade.symbol,
          order_id: trade.alpaca_order_id,
          status: order.status,
          filled_qty: filledQty,
          filled_avg_price: filledAvgPrice,
          pnl_usd: Number(realizedOutcome.pnlUsd.toFixed(2)),
          pnl_pct: Number(realizedOutcome.pnlPct.toFixed(4)),
          outcome: realizedOutcome.outcome,
        });
      } catch (error) {
        this.log("PolicyBroker", "deferred_sell_reconcile_failed", {
          symbol: trade.symbol,
          order_id: trade.alpaca_order_id,
          error: String(error),
        });
      }
    }
  }

  private symbolAliases(symbol: string): string[] {
    const trimmed = symbol.trim();
    return Array.from(new Set([trimmed, trimmed.toUpperCase(), this.normalizeStateSymbol(trimmed)]));
  }

  private recentSellAliases(symbol: string): string[] {
    const aliases = this.symbolAliases(symbol);
    const parsedOption = parseOccOptionSymbol(symbol);
    if (parsedOption) {
      aliases.push(parsedOption.underlying, this.normalizeStateSymbol(parsedOption.underlying));
    }
    return Array.from(new Set(aliases.filter((alias) => alias.trim().length > 0)));
  }

  private clearRecentSell(symbol: string): void {
    this.state.recentSells = this.state.recentSells ?? {};
    for (const alias of this.recentSellAliases(symbol)) {
      delete this.state.recentSells[alias];
    }
  }

  private recordSellAndClearPosition(symbol: string, reason: string): void {
    this.state.recentSells = this.state.recentSells ?? {};
    for (const alias of this.recentSellAliases(symbol)) {
      this.state.recentSells[alias] = { symbol: alias, sold_at: Date.now(), reason };
    }

    for (const alias of this.symbolAliases(symbol)) {
      delete this.state.positionEntries[alias];
      delete this.state.socialHistory[alias];
      delete this.state.stalenessAnalysis[alias];
    }
  }

  // ============================================================================
  // STRATEGY CONTEXT BUILDER
  // ============================================================================

  private buildStrategyContext(): StrategyContext {
    const self = this;
    const db = createD1Client(this.env.DB);
    const r2 = createR2Client(this.env.ARTIFACTS);
    const alpaca = createAlpacaProviders(this.env);
    const policyConfig = getDefaultPolicyConfig(this.env);
    policyConfig.max_open_positions = self.state.config.max_positions;
    policyConfig.max_notional_per_trade = self.state.config.max_position_value;
    policyConfig.max_daily_loss_pct = self.state.config.max_daily_loss_pct ?? policyConfig.max_daily_loss_pct;
    policyConfig.cooldown_minutes_after_loss =
      self.state.config.cooldown_minutes_after_loss ?? policyConfig.cooldown_minutes_after_loss;
    policyConfig.open_position_loss_entry_guard_enabled =
      self.state.config.open_position_loss_entry_guard_enabled ?? policyConfig.open_position_loss_entry_guard_enabled;
    policyConfig.open_position_loss_entry_guard_pct =
      self.state.config.open_position_loss_entry_guard_pct ?? policyConfig.open_position_loss_entry_guard_pct;
    policyConfig.open_position_loss_guard_min_confidence =
      self.state.config.open_position_loss_guard_min_confidence ??
      policyConfig.open_position_loss_guard_min_confidence;
    policyConfig.max_daily_entry_orders =
      self.state.config.max_daily_entry_orders ?? policyConfig.max_daily_entry_orders;
    policyConfig.min_minutes_between_entries =
      self.state.config.min_minutes_between_entries ?? policyConfig.min_minutes_between_entries;
    policyConfig.deny_symbols = self.state.config.ticker_blacklist ?? policyConfig.deny_symbols;

    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db,
      r2,
      log: (agent, action, details) => self.log(agent, action, details),
      cryptoSymbols: self.state.config.crypto_symbols || [],
      allowedExchanges: self.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
      maxEntrySpreadPct: self.state.config.max_entry_spread_pct ?? 0.8,
      minEntryQuoteSize: self.state.config.min_entry_quote_size ?? 1,
      maxEntryPriceChangePct: self.state.config.max_entry_price_change_pct ?? 5,
      dailyLossGuardEnabled: self.state.config.daily_loss_entry_guard_enabled ?? true,
      dailyLossSoftLimitPct: self.state.config.daily_loss_entry_guard_pct ?? 0.0075,
      dailyLossMinConfidence: self.state.config.daily_loss_guard_min_confidence ?? 0.8,
      dailyLossMinEntryQuality: self.state.config.daily_loss_guard_min_entry_quality ?? "good",
      openPositionLossGuardEnabled: self.state.config.open_position_loss_entry_guard_enabled ?? true,
      openPositionLossSoftLimitPct: self.state.config.open_position_loss_entry_guard_pct ?? 0.01,
      openPositionLossMinConfidence: self.state.config.open_position_loss_guard_min_confidence ?? 0.85,
      openPositionLossMinEntryQuality: self.state.config.open_position_loss_guard_min_entry_quality ?? "excellent",
      afterHoursExitLimitBufferPct: self.state.config.after_hours_exit_limit_buffer_pct ?? 0.25,
      onBuy: async (symbol, notional, reason) => {
        self.clearRecentSell(symbol);
        await self.sendTradeExecutionNotification("buy", symbol, { notional, reason });
      },
      onSell: async (symbol, reason) => {
        const lifecycleMetadata = self.getPositionLifecycleMetadata(symbol);
        self.recordSellAndClearPosition(symbol, reason);
        await self.sendTradeExecutionNotification("sell", symbol, { reason });
        return lifecycleMetadata;
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
    if (!this.state.enabled) {
      this.log("System", "alarm_skipped", { reason: "Agent not enabled" });
      return;
    }

    const now = Date.now();
    const MIN_ALARM_INTERVAL_MS = 20_000;
    const lastAlarmStartedAt = this.state.lastAlarmStartedAt ?? 0;
    if (lastAlarmStartedAt > 0 && now - lastAlarmStartedAt < MIN_ALARM_INTERVAL_MS) {
      this.log("System", "alarm_skipped", {
        reason: "recent_alarm_in_progress_or_completed",
        age_ms: now - lastAlarmStartedAt,
        min_interval_ms: MIN_ALARM_INTERVAL_MS,
      });
      await this.scheduleNextAlarm();
      return;
    }
    this.state.lastAlarmStartedAt = now;

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

      await this.reconcileDeferredBuyJournals();
      await this.reconcileDeferredSellJournals();

      // Data gathering
      if (now - this.state.lastDataGatherRun >= this.state.config.data_poll_interval_ms) {
        await this.runDataGatherers(ctx);
      }

      // Signal research
      if (now - this.state.lastResearchRun >= RESEARCH_INTERVAL_MS) {
        await this.researchTopSignals(ctx, this.state.config.signal_research_limit ?? 5);
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
      if (!clock.is_open && !this.state.premarketPlan) {
        const minutesToOpen = nextOpenValid ? (nextOpenMs - clockNowMs) / 60000 : Number.POSITIVE_INFINITY;
        const shouldPlan =
          minutesToOpen > 0 &&
          minutesToOpen <= premarketPlanWindowMinutes &&
          this.state.lastPremarketPlanDayEt !== etDay;

        if (shouldPlan) {
          await this.runPreMarketAnalysis(ctx);
          if (this.state.premarketPlan) this.state.lastPremarketPlanDayEt = etDay;
        }
      }

      // Positions snapshot
      const positions = await ctx.broker.getPositions();

      // Crypto trading (24/7)
      if (this.state.config.crypto_enabled) {
        await this.refreshEntryPerformanceBlocksIfStale(ctx, now, this.state.config.analyst_interval_ms);
        await runCryptoTrading(ctx, positions);
      }

      await this.maybeSendDiscordDailyReport(ctx, positions, now);

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

        // Position research
        if (positions.length > 0 && now - this.state.lastPositionResearchRun >= POSITION_RESEARCH_INTERVAL_MS) {
          for (const pos of positions) {
            if (pos.asset_class !== "us_option") {
              await this.callPositionResearch(ctx, pos);
            }
          }
          this.state.lastPositionResearchRun = now;
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
            } else {
              const entry = this.getPositionEntry(pos.symbol) ?? {
                symbol: pos.symbol,
                entry_time: Date.now(),
                entry_price: ep,
                entry_sentiment: 0,
                entry_social_volume: 0,
                entry_sources: ["options_position"],
                entry_reason: "Recovered options position metadata",
                peak_price: Math.max(ep, pos.current_price || ep),
                trough_price: Math.min(ep, pos.current_price || ep),
                peak_sentiment: 0,
              };
              this.setPositionEntry(pos.symbol, entry);

              this.updatePositionEntryPriceExtremes(pos.symbol, pos.current_price);

              const entryPrice = entry.entry_price > 0 ? entry.entry_price : ep;
              if (entryPrice <= 0 || pos.current_price <= 0) continue;

              const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
              const earlyLossExit = evaluateOptionsEarlyLossExit(plPct, entry.entry_time, this.state.config);
              if (earlyLossExit.shouldExit && earlyLossExit.reason) {
                await ctx.broker.sell(pos.symbol, earlyLossExit.reason);
                continue;
              }

              const staleLossExitPct = this.state.config.stale_loss_exit_pct ?? 2;
              if (
                (this.state.config.stale_position_enabled ?? true) &&
                staleLossExitPct > 0 &&
                holdHours >= (this.state.config.stale_min_hold_hours ?? 24) &&
                plPct <= -staleLossExitPct
              ) {
                await ctx.broker.sell(
                  pos.symbol,
                  `Options timed loss exit at ${plPct.toFixed(1)}% after ${holdHours.toFixed(1)}h`
                );
                continue;
              }

              const peakPrice = Math.max(entry.peak_price || pos.current_price, pos.current_price);
              const peakGainPct = ((peakPrice - entryPrice) / entryPrice) * 100;
              const drawdownFromPeakPct = ((peakPrice - pos.current_price) / peakPrice) * 100;
              const breakevenBufferPct = this.state.config.breakeven_stop_buffer_pct ?? 0.25;
              const breakevenActivationPct = this.state.config.breakeven_stop_activation_pct ?? 4;
              const profitLockActivationPct = this.state.config.profit_lock_activation_pct ?? 3;
              const profitLockBufferPct = this.state.config.profit_lock_floor_pct ?? 0.5;
              const profitLockPrice = entryPrice * (1 + profitLockBufferPct / 100);
              if (
                (this.state.config.profit_lock_stop_enabled ?? true) &&
                peakGainPct >= profitLockActivationPct &&
                pos.current_price <= profitLockPrice
              ) {
                await ctx.broker.sell(
                  pos.symbol,
                  `Options profit lock stop: peak +${peakGainPct.toFixed(1)}%, current near +${profitLockBufferPct.toFixed(2)}% floor`
                );
                continue;
              }

              if (
                (this.state.config.trailing_stop_enabled ?? true) &&
                peakGainPct >= (this.state.config.trailing_stop_activation_pct ?? 6) &&
                drawdownFromPeakPct >= (this.state.config.trailing_stop_drawdown_pct ?? 3)
              ) {
                await ctx.broker.sell(
                  pos.symbol,
                  `Options trailing stop: peak +${peakGainPct.toFixed(1)}%, gave back ${drawdownFromPeakPct.toFixed(1)}%`
                );
                continue;
              }

              const breakevenPrice = entryPrice * (1 + breakevenBufferPct / 100);
              if (
                (this.state.config.breakeven_stop_enabled ?? true) &&
                peakGainPct >= breakevenActivationPct &&
                pos.current_price <= breakevenPrice
              ) {
                await ctx.broker.sell(
                  pos.symbol,
                  `Options breakeven stop: peak +${peakGainPct.toFixed(1)}%, current near entry`
                );
              }
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

      this.state.lastClockIsOpen = clock.is_open;
      await this.persist();
    } catch (error) {
      this.log("System", "alarm_error", { error: String(error) });
    }

    await this.scheduleNextAlarm();
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

    const freshSignals = buildFreshSignalCache(allSignals, now, MAX_AGE_MS, MAX_SIGNALS, (symbol) =>
      this.normalizeStateSymbol(symbol)
    );

    const socialSnapshot = this.buildSocialSnapshot(freshSignals);
    this.updateSocialHistoryFromSnapshot(socialSnapshot, now);
    this.state.socialSnapshotCache = {};
    for (const [symbol, s] of socialSnapshot) {
      this.state.socialSnapshotCache[symbol] = {
        volume: s.volume,
        sentiment: s.sentiment,
        sources: Array.from(s.sources),
      };
    }
    this.state.socialSnapshotCacheUpdatedAt = now;

    this.state.signalCache = freshSignals;
    this.state.lastDataGatherRun = now;

    this.log("System", "data_gathered", { ...counts, total: this.state.signalCache.length });
  }

  private buildSocialSnapshot(
    signals: Signal[]
  ): Map<string, { volume: number; sentiment: number; sources: Set<string> }> {
    const aggregated = new Map<string, { volume: number; sentimentNumerator: number; sources: Set<string> }>();

    for (const sig of signals) {
      if (!sig.symbol) continue;
      const volume = Number.isFinite(sig.volume) && sig.volume > 0 ? sig.volume : 1;

      let entry = aggregated.get(sig.symbol);
      if (!entry) {
        entry = { volume: 0, sentimentNumerator: 0, sources: new Set() };
        aggregated.set(sig.symbol, entry);
      }
      entry.volume += volume;
      entry.sentimentNumerator += (getSignedSignalSentiment(sig) ?? 0) * volume;
      entry.sources.add(sig.source_detail || sig.source);
    }

    const out = new Map<string, { volume: number; sentiment: number; sources: Set<string> }>();
    for (const [symbol, entry] of aggregated) {
      out.set(symbol, {
        volume: entry.volume,
        sentiment: entry.volume > 0 ? entry.sentimentNumerator / entry.volume : 0,
        sources: entry.sources,
      });
    }
    return out;
  }

  private pruneSocialHistoryInPlace(history: SocialHistoryEntry[], cutoffMs: number): void {
    if (history.length === 0) return;
    const pruned = history.filter((entry) => entry.timestamp >= cutoffMs);
    pruned.sort((a, b) => a.timestamp - b.timestamp);
    history.splice(0, history.length, ...pruned);
  }

  private updateSocialHistoryFromSnapshot(
    snapshot: Map<string, { volume: number; sentiment: number; sources: Set<string> }>,
    nowMs: number
  ): void {
    const SOCIAL_HISTORY_BUCKET_MS = 5 * 60 * 1000;
    const SOCIAL_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const cutoff = nowMs - SOCIAL_HISTORY_MAX_AGE_MS;

    const touchedSymbols = new Set<string>();
    for (const [symbol, s] of snapshot) {
      touchedSymbols.add(symbol);
      const history = this.state.socialHistory[symbol] ?? [];
      if (history.length > 1) history.sort((a, b) => a.timestamp - b.timestamp);
      const last = history[history.length - 1];

      if (last && nowMs - last.timestamp < SOCIAL_HISTORY_BUCKET_MS) {
        last.timestamp = nowMs;
        last.volume = s.volume;
        last.sentiment = s.sentiment;
      } else {
        history.push({ timestamp: nowMs, volume: s.volume, sentiment: s.sentiment });
      }

      this.pruneSocialHistoryInPlace(history, cutoff);
      if (history.length === 0) {
        delete this.state.socialHistory[symbol];
      } else {
        this.state.socialHistory[symbol] = history;
      }
    }

    for (const symbol of Object.keys(this.state.socialHistory)) {
      if (touchedSymbols.has(symbol)) continue;
      const history = this.state.socialHistory[symbol];
      if (!history || history.length === 0) {
        delete this.state.socialHistory[symbol];
        continue;
      }
      this.pruneSocialHistoryInPlace(history, cutoff);
      if (history.length === 0) {
        delete this.state.socialHistory[symbol];
      }
    }
  }

  private getSocialSnapshotCache(): Record<string, SocialSnapshotCacheEntry> {
    if (this.state.socialSnapshotCacheUpdatedAt > 0) {
      return this.state.socialSnapshotCache;
    }

    const fallback = this.buildSocialSnapshot(this.state.signalCache);
    const out: Record<string, SocialSnapshotCacheEntry> = {};
    for (const [symbol, s] of fallback) {
      out[symbol] = { volume: s.volume, sentiment: s.sentiment, sources: Array.from(s.sources) };
    }
    return out;
  }

  private findSignalForSymbol(symbol: string): Signal | undefined {
    return findSignalForSymbolByAlias(this.state.signalCache, symbol, (value) => this.normalizeStateSymbol(value));
  }

  private findSocialSnapshotForSymbol(
    snapshot: Record<string, SocialSnapshotCacheEntry>,
    symbol: string
  ): SocialSnapshotCacheEntry | undefined {
    return findSocialSnapshotForSymbolByAlias(snapshot, symbol, (value) => this.normalizeStateSymbol(value));
  }

  // ============================================================================
  // LLM RESEARCH — uses strategy prompt builders
  // ============================================================================

  private async researchTopSignals(ctx: StrategyContext, limit = 5): Promise<ResearchResult[]> {
    const positions = await ctx.broker.getPositions();
    const heldSymbols = new Set(positions.flatMap((p) => [p.symbol, this.normalizeStateSymbol(p.symbol)]));

    const allSignals = this.state.signalCache.filter((signal) => !signal.isCrypto);
    const notHeld = allSignals.filter(
      (s) => !heldSymbols.has(s.symbol) && !heldSymbols.has(this.normalizeStateSymbol(s.symbol))
    );
    const aboveThreshold = notHeld.filter((s) => {
      const signedSentiment = getSignedSignalSentiment(s);
      return signedSentiment !== null && signedSentiment >= this.state.config.min_sentiment_score;
    });
    const candidates = buildSignalResearchCandidates(
      allSignals,
      heldSymbols,
      this.state.config.min_sentiment_score,
      limit,
      (symbol) => this.normalizeStateSymbol(symbol)
    );
    const eligibleSymbols = new Set(aboveThreshold.map((signal) => this.normalizeStateSymbol(signal.symbol))).size;

    if (candidates.length === 0) {
      this.log("SignalResearch", "no_candidates", {
        total_signals: allSignals.length,
        not_held: notHeld.length,
        above_threshold: aboveThreshold.length,
        min_sentiment: this.state.config.min_sentiment_score,
      });
      return [];
    }

    this.log("SignalResearch", "researching_signals", {
      count: candidates.length,
      eligible_symbols: eligibleSymbols,
      eligible_signals: aboveThreshold.length,
    });
    this.state.signalResearch = pruneSignalResearchMap(this.state.signalResearch);

    const results: ResearchResult[] = [];
    for (const candidate of candidates) {
      const analysis = await this.callSignalResearch(ctx, candidate.symbol, candidate.sentiment, candidate.sources);
      if (analysis) results.push(analysis);
      await this.sleep(500);
    }

    this.state.signalResearch = pruneSignalResearchMap(this.state.signalResearch);
    return results;
  }

  private async callSignalResearch(
    ctx: StrategyContext,
    symbol: string,
    sentiment: number,
    sources: string[]
  ): Promise<ResearchResult | null> {
    if (!this._llm || !activeStrategy.prompts.researchSignal) return null;

    const symbolKey = this.normalizeStateSymbol(symbol);
    const cached =
      this.state.signalResearch[symbolKey] ??
      this.state.signalResearch[symbol] ??
      findEntryResearch(Object.values(this.state.signalResearch), symbol);
    const maxResearchAgeMinutes = this.state.config.max_entry_research_age_minutes ?? 30;
    const cacheTtlMs = Math.max(5, Math.min(60, maxResearchAgeMinutes)) * 60_000;
    if (cached && Date.now() - cached.timestamp < cacheTtlMs) return cached;

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

      const response = await this._llm.complete({
        model: prompt.model || this.state.config.llm_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 250,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      const content = response.content || "{}";
      const parsed = parseJsonObject(content.replace(/```json\n?|```/g, "").trim());
      const result = sanitizeSignalResearchResult(parsed, symbolKey);

      this.state.signalResearch[symbolKey] = result;
      this.log("SignalResearch", "signal_researched", {
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
      this.log("SignalResearch", "error", { symbol, message: String(error) });
      return null;
    }
  }

  private async callPositionResearch(ctx: StrategyContext, position: Position): Promise<void> {
    if (!this._llm || !activeStrategy.prompts.researchPosition) return;

    const plPct = (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100;
    const prompt = activeStrategy.prompts.researchPosition(position.symbol, position, plPct, ctx);

    try {
      const response = await this._llm.complete({
        model: prompt.model || this.state.config.llm_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 200,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      const content = response.content || "{}";
      const analysis = sanitizePositionResearchResult(
        parseJsonObject(content.replace(/```json\n?|```/g, "").trim())
      );
      this.state.positionResearch[position.symbol] = analysis;
      this.log("PositionResearch", "position_analyzed", {
        symbol: position.symbol,
        recommendation: analysis.recommendation,
        risk: analysis.risk_level,
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
    if (!this._llm || !activeStrategy.prompts.analyzeSignals || (signals.length === 0 && positions.length === 0)) {
      return { recommendations: [], market_summary: "No signals to analyze", high_conviction: [] };
    }

    const prompt = activeStrategy.prompts.analyzeSignals(signals, positions, account, ctx);

    try {
      const response = await this._llm.complete({
        model: prompt.model || this.state.config.llm_analyst_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 800,
        temperature: 0.4,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_analyst_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      const content = response.content || "{}";
      const analysis = parseJsonObject(content.replace(/```json\n?|```/g, "").trim()) ?? {};
      const recommendations = sanitizeAnalystRecommendations(analysis.recommendations);
      const buyRecommendations = recommendations.filter((rec) => rec.action === "BUY");

      this.log("Analyst", "analysis_complete", {
        recommendations: recommendations.length,
        buy_recommendations: buyRecommendations.length,
        buy_recommendations_above_threshold: buyRecommendations.filter(
          (rec) => rec.confidence >= this.state.config.min_analyst_confidence
        ).length,
        sell_recommendations: recommendations.filter((rec) => rec.action === "SELL").length,
        hold_recommendations: recommendations.filter((rec) => rec.action === "HOLD").length,
        min_confidence: this.state.config.min_analyst_confidence,
      });

      return {
        recommendations,
        market_summary: asString(analysis.market_summary)?.slice(0, 1_500) ?? "",
        high_conviction: sanitizeStringList(analysis.high_conviction_plays, 20, 40),
      };
    } catch (error) {
      this.log("Analyst", "error", { message: String(error) });
      return { recommendations: [], market_summary: `Analysis failed: ${error}`, high_conviction: [] };
    }
  }

  // ============================================================================
  // ANALYST & TRADING — uses strategy selectEntries/selectExits + PolicyBroker
  // ============================================================================

  private async refreshEntryPerformanceBlocks(ctx: StrategyContext): Promise<void> {
    if (!(this.state.config.adaptive_performance_block_enabled ?? true)) {
      ctx.state.set("entryPerformanceBlocks", {});
      ctx.state.set("entryFeaturePerformanceBlocks", {});
      return;
    }

    const minTrades = this.state.config.adaptive_performance_min_trades ?? 3;
    const minWinRate = this.state.config.adaptive_performance_min_win_rate ?? 0.35;
    const lookbackDays = this.state.config.adaptive_performance_lookback_days ?? 90;
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      const db = createD1Client(this.env.DB);
      const rows = await db.execute<{
        symbol: string;
        trades: number;
        wins: number;
        losses: number;
        total_pnl_usd: number;
      }>(
        `SELECT
          symbol,
          COUNT(*) AS trades,
          SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
          COALESCE(SUM(pnl_usd), 0) AS total_pnl_usd
        FROM trade_journal
        WHERE outcome IS NOT NULL
          AND COALESCE(exit_at, updated_at, created_at) >= ?
        GROUP BY symbol
        HAVING COUNT(*) >= ?`,
        [cutoff, minTrades]
      );

      const blocks: Record<string, unknown> = {};
      const blockedSymbols = new Set<string>();
      for (const row of rows) {
        const trades = Number(row.trades) || 0;
        const wins = Number(row.wins) || 0;
        const losses = Number(row.losses) || 0;
        const winRate = trades > 0 ? wins / trades : 0;
        const totalPnlUsd = Number(row.total_pnl_usd) || 0;
        if (trades >= minTrades && winRate < minWinRate && totalPnlUsd <= 0) {
          const symbol = String(row.symbol || "").toUpperCase();
          const block = {
            symbol,
            trades,
            wins,
            losses,
            winRate: Number(winRate.toFixed(4)),
            totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
            updatedAt: new Date().toISOString(),
          };
          blocks[symbol] = block;
          blocks[this.normalizeStateSymbol(symbol)] = block;
          blockedSymbols.add(symbol);
        }
      }

      const featureRows = await db.execute<{
        outcome: string | null;
        pnl_usd: number | null;
        signals_json: string | null;
      }>(
        "SELECT outcome, pnl_usd, signals_json " +
          "FROM trade_journal " +
          "WHERE outcome IS NOT NULL " +
          "AND signals_json IS NOT NULL " +
          "AND COALESCE(exit_at, updated_at, created_at) >= ?",
        [cutoff]
      );
      const featureStats = new Map<string, { trades: number; wins: number; losses: number; totalPnlUsd: number }>();
      for (const row of featureRows) {
        let metadata: Record<string, unknown> | null = null;
        try {
          metadata = row.signals_json ? (JSON.parse(row.signals_json) as Record<string, unknown>) : null;
        } catch {
          metadata = null;
        }
        const featureKeys = getEntryFeatureKeysFromMetadata(metadata ?? undefined);
        for (const featureKey of featureKeys.filter(isAdaptiveBlockableEntryFeature)) {
          const current = featureStats.get(featureKey) ?? { trades: 0, wins: 0, losses: 0, totalPnlUsd: 0 };
          current.trades += 1;
          if (row.outcome === "win") current.wins += 1;
          if (row.outcome === "loss") current.losses += 1;
          current.totalPnlUsd += Number(row.pnl_usd) || 0;
          featureStats.set(featureKey, current);
        }
      }
      const featureBlocks: Record<string, unknown> = {};
      for (const [feature, stats] of featureStats) {
        const winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
        if (stats.trades >= minTrades && winRate < minWinRate && stats.totalPnlUsd <= 0) {
          featureBlocks[feature] = {
            feature,
            trades: stats.trades,
            wins: stats.wins,
            losses: stats.losses,
            winRate: Number(winRate.toFixed(4)),
            totalPnlUsd: Number(stats.totalPnlUsd.toFixed(2)),
            updatedAt: new Date().toISOString(),
          };
        }
      }

      ctx.state.set("entryPerformanceBlocks", blocks);
      ctx.state.set("entryFeaturePerformanceBlocks", featureBlocks);
      ctx.state.set("entryPerformanceBlocksRefreshedAt", Date.now());
      this.log("System", "entry_performance_blocks_refreshed", {
        blocked_symbols: blockedSymbols.size,
        blocked_features: Object.keys(featureBlocks).length,
        lookback_days: lookbackDays,
        min_trades: minTrades,
        min_win_rate: minWinRate,
      });
    } catch (error) {
      this.log("System", "entry_performance_blocks_unavailable", { reason: String(error) });
    }
  }

  private async refreshEntryPerformanceBlocksIfStale(
    ctx: StrategyContext,
    now: number,
    intervalMs: number
  ): Promise<void> {
    const refreshedAt = ctx.state.get<number>("entryPerformanceBlocksRefreshedAt") ?? 0;
    if (now - refreshedAt < intervalMs) return;
    await this.refreshEntryPerformanceBlocks(ctx);
  }

  private checkEntryPerformanceBlock(ctx: StrategyContext, symbol: string, agent: string, action: string): boolean {
    const performanceBlock = getEntryPerformanceBlock(ctx, symbol);
    if (!performanceBlock) return true;

    this.log(agent, action, {
      symbol,
      trades: performanceBlock.trades,
      wins: performanceBlock.wins,
      losses: performanceBlock.losses,
      win_rate: performanceBlock.winRate,
      total_pnl_usd: performanceBlock.totalPnlUsd,
    });
    return false;
  }

  private checkEntryFeaturePerformanceBlock(
    ctx: StrategyContext,
    symbol: string,
    metadata: Record<string, unknown>,
    agent: string,
    action: string
  ): boolean {
    const featureBlock = getEntryFeaturePerformanceBlock(ctx, metadata);
    if (!featureBlock) return true;

    this.log(agent, action, {
      symbol,
      feature: featureBlock.feature,
      trades: featureBlock.trades,
      wins: featureBlock.wins,
      losses: featureBlock.losses,
      win_rate: featureBlock.winRate,
      total_pnl_usd: featureBlock.totalPnlUsd,
    });
    return false;
  }

  private checkRecommendationBuyQuality(
    ctx: StrategyContext,
    symbol: string,
    confidence: number,
    agent: string,
    action: string
  ): boolean {
    if (confidence < this.state.config.min_analyst_confidence) {
      this.log(agent, action, {
        symbol,
        reason: "low_recommendation_confidence",
        confidence,
        min_confidence: this.state.config.min_analyst_confidence,
      });
      return false;
    }

    const research = findEntryResearch(Object.values(this.state.signalResearch), symbol);
    if (!research) {
      const exceptionalConfidence = this.state.config.exceptional_entry_confidence ?? 0.9;
      if (
        (this.state.config.analyst_buy_requires_research_confirmation ?? true) ||
        confidence < exceptionalConfidence
      ) {
        this.log(agent, action, {
          symbol,
          reason: "missing_research_confirmation",
          confidence,
          exceptional_confidence: exceptionalConfidence,
        });
        return false;
      }
      const unresearchedGate = evaluateUnresearchedRecommendationBuy(ctx, symbol, confidence);
      if (!unresearchedGate.allowed) {
        this.log(agent, action, {
          symbol,
          reason: unresearchedGate.reason,
          source_count: unresearchedGate.sourceCount,
          min_sources: unresearchedGate.minSources,
          average_sentiment: unresearchedGate.averageSentiment,
          bullish_signals: unresearchedGate.bullishSignals,
          bearish_signals: unresearchedGate.bearishSignals,
          threshold: unresearchedGate.threshold,
          confidence: unresearchedGate.confidence,
          required_confidence: unresearchedGate.requiredConfidence,
        });
        return false;
      }
      return true;
    }

    const qualityGate = evaluateEntryResearch(ctx, research);
    if (!qualityGate.allowed) {
      this.log(agent, action, {
        symbol,
        reason: qualityGate.reason,
        confidence: research.confidence,
        quality: qualityGate.quality ?? research.entry_quality,
        red_flags: qualityGate.redFlags ?? research.red_flags?.length ?? 0,
        catalysts: qualityGate.catalysts ?? research.catalysts?.length ?? 0,
        source_count: qualityGate.sourceCount,
        average_sentiment: qualityGate.averageSentiment,
        bullish_signals: qualityGate.bullishSignals,
        bearish_signals: qualityGate.bearishSignals,
        age_minutes: qualityGate.ageMinutes,
      });
      return false;
    }

    const regimeGate = evaluateMarketRegimeEntry(ctx, research.confidence, research.entry_quality);
    if (!regimeGate.allowed) {
      this.log(agent, action, {
        symbol,
        reason: regimeGate.reason,
        average_sentiment: regimeGate.averageSentiment,
        threshold: regimeGate.threshold,
        confidence: regimeGate.confidence,
        required_confidence: regimeGate.requiredConfidence,
        quality: regimeGate.quality,
      });
      return false;
    }

    return true;
  }

  private buildRecommendationBuyMetadata(
    ctx: StrategyContext,
    symbol: string,
    confidence: number,
    entryPath: string
  ): Record<string, unknown> {
    const research = findEntryResearch(Object.values(this.state.signalResearch), symbol);
    if (research) {
      return buildEntryReviewMetadata(ctx, research, {
        entry_path: entryPath,
        entry_selection_score: getEntrySelectionScore(ctx, research),
        recommendation_confidence: confidence,
      });
    }

    const consensus = getEntrySignalConsensus(ctx, symbol);
    const sourceCount = consensus.sourceCount;
    return {
      entry_path: `${entryPath}_unresearched`,
      portfolio_bucket: inferPortfolioBucket(symbol, ctx.config.crypto_symbols || []),
      confidence,
      analyst_confidence: confidence,
      source_count: sourceCount,
      signal_sources: sourceCount,
      signal_consensus_average: consensus.averageSentiment,
      signal_consensus_bullish: consensus.bullishSignals,
      signal_consensus_bearish: consensus.bearishSignals,
      signal_consensus_state: getSignalConsensusState(ctx, consensus),
      research_confirmed: false,
    };
  }

  private checkPortfolioBucket(
    ctx: StrategyContext,
    symbol: string,
    positions: Position[],
    heldSymbols: Set<string>,
    pendingSymbols: string[],
    agent: string,
    action: string
  ): boolean {
    const activePositions = positions.filter(
      (position) => heldSymbols.has(position.symbol) || heldSymbols.has(this.normalizeStateSymbol(position.symbol))
    );
    const portfolioBucket = evaluatePortfolioBucket(ctx, symbol, activePositions, pendingSymbols);
    if (!portfolioBucket.blocked) return true;

    this.log(agent, action, {
      symbol,
      bucket: portfolioBucket.bucket,
      current_count: portfolioBucket.count,
      max_count: portfolioBucket.max,
    });
    return false;
  }

  private shouldBlockEquityEntryNearClose(clock: MarketClock, symbol: string, agent: string, action: string): boolean {
    const cutoffMinutes = this.state.config.equity_entry_cutoff_minutes_before_close ?? 15;
    if (cutoffMinutes <= 0 || !clock.is_open || isCryptoSymbol(symbol, this.state.config.crypto_symbols || [])) {
      return false;
    }

    const minutesToClose = getMarketClockMinutesToClose(clock);
    if (minutesToClose === null) return false;
    if (minutesToClose > cutoffMinutes) return false;

    this.log(agent, action, {
      symbol,
      reason: "near_market_close",
      minutes_to_close: Math.max(0, Math.round(minutesToClose)),
      cutoff_minutes: cutoffMinutes,
    });
    return true;
  }

  private shouldBlockEquityEntryAfterOpen(clock: MarketClock, symbol: string, agent: string, action: string): boolean {
    const cooldownMinutes = this.state.config.equity_entry_cooldown_minutes_after_open ?? 10;
    if (cooldownMinutes <= 0 || !clock.is_open || isCryptoSymbol(symbol, this.state.config.crypto_symbols || [])) {
      return false;
    }

    const minutesSinceOpen = getMarketClockMinutesSinceOpen(clock);
    if (minutesSinceOpen === null || minutesSinceOpen < 0) return false;
    if (minutesSinceOpen >= cooldownMinutes) return false;

    this.log(agent, action, {
      symbol,
      reason: "near_market_open",
      minutes_since_open: Math.max(0, Math.round(minutesSinceOpen)),
      cooldown_minutes: cooldownMinutes,
    });
    return true;
  }

  private calculateRsi(closes: number[], period = 14): number | null {
    if (closes.length <= period) return null;

    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i]! - closes[i - 1]!;
      if (change >= 0) gains += change;
      else losses += Math.abs(change);
    }

    const averageGain = gains / period;
    const averageLoss = losses / period;
    if (averageLoss === 0) return 100;

    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  }

  private async shouldBlockEntryTiming(symbol: string, agent: string, action: string): Promise<boolean> {
    if (!(this.state.config.entry_timing_enabled ?? true)) return false;
    if (isCryptoSymbol(symbol, this.state.config.crypto_symbols || [])) return false;

    try {
      const alpaca = createAlpacaProviders(this.env);
      const [bars, snapshot] = await Promise.all([
        alpaca.marketData.getBars(symbol, "1Day", { limit: 20 }).catch(() => []),
        alpaca.marketData.getSnapshot(symbol).catch(() => null),
      ]);
      const rangeGate = evaluateEntryIntradayRangePosition(
        snapshot,
        this.state.config.entry_max_intraday_range_position ?? 0.75
      );
      if (rangeGate.blocked) {
        this.log(agent, action, {
          symbol,
          reason: rangeGate.reason,
          intraday_range_position:
            rangeGate.rangePosition === null ? null : Number(rangeGate.rangePosition.toFixed(3)),
          max_intraday_range_position: this.state.config.entry_max_intraday_range_position ?? 0.75,
          current_price: rangeGate.currentPrice,
        });
        return true;
      }

      const closes = bars.map((bar) => Number(bar.c)).filter((close) => Number.isFinite(close) && close > 0);
      if (closes.length < 15) {
        this.log(agent, "entry_timing_unavailable", { symbol, reason: "insufficient_bars", bars: closes.length });
        return false;
      }

      const rsi = this.calculateRsi(closes);
      const rsiMin = this.state.config.entry_rsi_min ?? 40;
      const rsiMax = this.state.config.entry_rsi_max ?? 55;
      if (rsi !== null && (rsi < rsiMin || rsi > rsiMax)) {
        this.log(agent, action, {
          symbol,
          reason: "rsi_out_of_range",
          rsi: Number(rsi.toFixed(2)),
          rsi_min: rsiMin,
          rsi_max: rsiMax,
        });
        return true;
      }

      const window = closes.slice(-20);
      if (window.length >= 20) {
        const mean = window.reduce((sum, close) => sum + close, 0) / window.length;
        const variance = window.reduce((sum, close) => sum + (close - mean) ** 2, 0) / window.length;
        const stddev = Math.sqrt(variance);
        const lowerBand = mean - 2 * stddev;
        const upperBand = mean + 2 * stddev;
        const current = closes[closes.length - 1]!;
        const bandRange = upperBand - lowerBand;
        const lowerBandPosition = bandRange > 0 ? (current - lowerBand) / bandRange : 0.5;
        const threshold = this.state.config.entry_bb_lower_threshold ?? 0.2;

        if (lowerBandPosition > threshold) {
          this.log(agent, action, {
            symbol,
            reason: "not_near_lower_bollinger_band",
            lower_band_position: Number(lowerBandPosition.toFixed(3)),
            threshold,
          });
          return true;
        }
      }
    } catch (error) {
      this.log(agent, "entry_timing_unavailable", { symbol, reason: String(error) });
    }

    return false;
  }

  private async shouldBlockEntryTimingForResearch(
    ctx: StrategyContext,
    symbol: string,
    confidence: number,
    quality: ResearchResult["entry_quality"] | undefined,
    agent: string,
    action: string
  ): Promise<boolean> {
    const blocked = await this.shouldBlockEntryTiming(symbol, agent, action);
    if (!blocked) return false;

    const bypass = evaluateEntryTimingBypass(ctx, symbol, confidence, quality);
    if (!bypass.allowed) return true;

    this.log(agent, "entry_timing_bypassed", {
      symbol,
      reason: bypass.reason,
      confidence: bypass.confidence,
      required_confidence: bypass.requiredConfidence,
      quality: bypass.quality,
      signal_consensus_state: bypass.consensusState,
      average_sentiment: bypass.averageSentiment,
      bullish_signals: bypass.bullishSignals,
      bearish_signals: bypass.bearishSignals,
      original_blocker: action,
    });
    return false;
  }

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

    const heldSymbols = new Set(positions.flatMap((p) => [p.symbol, this.normalizeStateSymbol(p.symbol)]));
    let openPositionCount = positions.length;
    const socialSnapshot = this.getSocialSnapshotCache();
    await this.restoreMissingPositionEntriesFromJournal(positions);
    await this.refreshEntryPerformanceBlocks(ctx);
    await this.evaluateMissedEntryOpportunities();

    // Strategy exit decisions
    const exits = activeStrategy.selectExits(ctx, positions, account);
    for (const exit of exits) {
      const result = await ctx.broker.sell(exit.symbol, exit.reason);
      if (result) {
        heldSymbols.delete(exit.symbol);
        heldSymbols.delete(this.normalizeStateSymbol(exit.symbol));
        openPositionCount = Math.max(0, openPositionCount - 1);
      }
    }

    const hasEntryCapacity = openPositionCount < this.state.config.max_positions;
    const hasSignals = this.state.signalCache.length > 0;
    const maxResearchAgeMs = (this.state.config.max_entry_research_age_minutes ?? 30) * 60_000;
    this.state.signalResearch = pruneSignalResearchMap(this.state.signalResearch, Date.now(), maxResearchAgeMs);
    if (!hasEntryCapacity) {
      this.log("System", "entry_skipped_no_capacity", {
        open_positions: openPositionCount,
        max_positions: this.state.config.max_positions,
      });
    }
    if (!hasSignals) {
      this.log("System", "entry_skipped_no_signals", {
        signal_count: this.state.signalCache.length,
      });
    }
    const entries =
      hasEntryCapacity && hasSignals
        ? activeStrategy.selectEntries(ctx, Object.values(this.state.signalResearch), positions, account)
        : [];
    const researchRows = Object.values(this.state.signalResearch);
    const freshResearchRows = researchRows.filter((row) => Date.now() - row.timestamp <= maxResearchAgeMs);
    const researchedBuyRows = researchRows.filter((row) => row.verdict === "BUY");
    const freshResearchedBuyRows = freshResearchRows.filter((row) => row.verdict === "BUY");
    this.log("System", "entry_selection_summary", {
      signal_count: this.state.signalCache.length,
      research_total: researchRows.length,
      research_fresh: freshResearchRows.length,
      researched_buy_available: researchedBuyRows.length,
      researched_buy_fresh: freshResearchedBuyRows.length,
      strategy_entry_candidates: entries.length,
      has_entry_capacity: hasEntryCapacity,
      has_signals: hasSignals,
      open_positions: openPositionCount,
      max_positions: this.state.config.max_positions,
      cash: account.cash,
      min_confidence: this.state.config.min_analyst_confidence,
    });

    // LLM analyst for additional recommendations
    const analysis = await this.callAnalystLLM(ctx, this.state.signalCache, positions, account);
    const entrySymbols = new Set(entries.flatMap((e) => [e.symbol, this.normalizeStateSymbol(e.symbol)]));

    for (const rec of analysis.recommendations) {
      if (rec.confidence < this.state.config.min_analyst_confidence) {
        if (rec.action === "BUY") {
          this.log("Analyst", "llm_buy_skipped_low_confidence", {
            symbol: rec.symbol,
            confidence: rec.confidence,
            min_confidence: this.state.config.min_analyst_confidence,
          });
          await this.recordMissedEntryOpportunity(rec.symbol, "low_recommendation_confidence", {
            agent: "Analyst",
            action: "llm_buy_skipped_low_confidence",
            confidence: rec.confidence,
          });
        }
        continue;
      }

      if (
        rec.action === "SELL" &&
        (heldSymbols.has(rec.symbol) || heldSymbols.has(this.normalizeStateSymbol(rec.symbol)))
      ) {
        const posEntry = this.getPositionEntry(rec.symbol);
        const holdMinutes = posEntry ? (Date.now() - posEntry.entry_time) / (1000 * 60) : Number.POSITIVE_INFINITY;
        const minHold = this.state.config.llm_min_hold_minutes ?? 30;

        const position = positions.find(
          (p) =>
            p.symbol === rec.symbol || this.normalizeStateSymbol(p.symbol) === this.normalizeStateSymbol(rec.symbol)
        );
        const plPct =
          position && position.market_value - position.unrealized_pl !== 0
            ? (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100
            : 0;
        const forceSellLossPct = this.state.config.llm_force_sell_pnl_pct ?? 2;
        const forceSellMinConfidence = this.state.config.llm_force_sell_min_confidence ?? 0.65;
        const forceSellAllowed = plPct <= -forceSellLossPct && rec.confidence >= forceSellMinConfidence;

        if (posEntry && holdMinutes < minHold && !forceSellAllowed) {
          this.log("Analyst", "llm_sell_blocked", {
            symbol: rec.symbol,
            holdMinutes: Math.round(holdMinutes),
            minRequired: minHold,
            reason: "Position held less than minimum hold time",
          });
          continue;
        }

        if (!posEntry) {
          this.log("Analyst", "llm_sell_no_entry_metadata", {
            symbol: rec.symbol,
            reason: "Allowing risk-reducing sell because position entry metadata is missing",
          });
        }

        const result = await ctx.broker.sell(rec.symbol, `LLM recommendation: ${rec.reasoning}`);
        if (result) {
          heldSymbols.delete(rec.symbol);
          heldSymbols.delete(this.normalizeStateSymbol(rec.symbol));
          openPositionCount = Math.max(0, openPositionCount - 1);
          this.log("Analyst", "llm_sell_executed", {
            symbol: rec.symbol,
            confidence: rec.confidence,
            reasoning: rec.reasoning,
          });
        }
      }
    }

    if (!hasEntryCapacity || !hasSignals) return;

    const executedEntrySymbols: string[] = [];
    for (const entry of entries) {
      if (heldSymbols.has(entry.symbol) || heldSymbols.has(this.normalizeStateSymbol(entry.symbol))) continue;
      if (openPositionCount >= this.state.config.max_positions) break;
      if (
        !this.checkPortfolioBucket(
          ctx,
          entry.symbol,
          positions,
          heldSymbols,
          executedEntrySymbols,
          "System",
          "entry_skipped_portfolio_bucket"
        )
      ) {
        await this.recordMissedEntryOpportunity(entry.symbol, "portfolio_bucket", {
          agent: "System",
          action: "entry_skipped_portfolio_bucket",
          confidence: entry.confidence,
          entryQuality: entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }
      if (this.shouldBlockEquityEntryNearClose(clock, entry.symbol, "System", "entry_skipped_close_window")) {
        await this.recordMissedEntryOpportunity(entry.symbol, "close_window", {
          agent: "System",
          action: "entry_skipped_close_window",
          confidence: entry.confidence,
          entryQuality: entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }
      if (this.shouldBlockEquityEntryAfterOpen(clock, entry.symbol, "System", "entry_skipped_open_window")) {
        await this.recordMissedEntryOpportunity(entry.symbol, "open_window", {
          agent: "System",
          action: "entry_skipped_open_window",
          confidence: entry.confidence,
          entryQuality: entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }
      if (
        await this.shouldBlockEntryTimingForResearch(
          ctx,
          entry.symbol,
          entry.confidence,
          entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          "System",
          "entry_skipped_timing_gate"
        )
      ) {
        await this.recordMissedEntryOpportunity(entry.symbol, "timing_gate", {
          agent: "System",
          action: "entry_skipped_timing_gate",
          confidence: entry.confidence,
          entryQuality: entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }

      let finalConfidence = entry.confidence;

      // Twitter confirmation
      if (isTwitterEnabled(ctx)) {
        const originalSignal = this.findSignalForSymbol(entry.symbol);
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

      if (finalConfidence < this.state.config.min_analyst_confidence) {
        this.log("System", "entry_skipped_low_final_confidence", {
          symbol: entry.symbol,
          confidence: finalConfidence,
          min_confidence: this.state.config.min_analyst_confidence,
        });
        await this.recordMissedEntryOpportunity(entry.symbol, "low_final_confidence", {
          agent: "System",
          action: "entry_skipped_low_final_confidence",
          confidence: finalConfidence,
          entryQuality: entry.metadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }

      const entryMetadata = await this.enrichEntryExecutionMetadata(entry.symbol, entry.metadata);
      if (
        !this.checkEntryFeaturePerformanceBlock(
          ctx,
          entry.symbol,
          entryMetadata,
          "System",
          "entry_skipped_poor_feature_performance"
        )
      ) {
        await this.recordMissedEntryOpportunity(entry.symbol, "poor_feature_performance", {
          agent: "System",
          action: "entry_skipped_poor_feature_performance",
          confidence: finalConfidence,
          entryQuality: entryMetadata?.entry_quality as ResearchResult["entry_quality"] | undefined,
          notional: entry.notional,
        });
        continue;
      }

      // Options routing
      if (entry.useOptions) {
        const contract = await findBestOptionsContract(ctx, entry.symbol, "bullish", account.equity);
        if (!contract) {
          this.log("Options", "options_buy_skipped_no_contract", {
            symbol: entry.symbol,
            confidence: finalConfidence,
          });
          continue;
        }

        const optionsResult = await this.executeOptionsOrder(contract, 1, account.equity, finalConfidence);
        if (optionsResult) {
          heldSymbols.add(entry.symbol);
          heldSymbols.add(this.normalizeStateSymbol(entry.symbol));
          openPositionCount++;
          executedEntrySymbols.push(entry.symbol);
          continue;
        }

        this.log("Options", "options_buy_skipped_order_not_filled", {
          symbol: entry.symbol,
          contract: contract.symbol,
          confidence: finalConfidence,
        });
        continue;
      }

      // Execute buy via policy broker
      const result = await ctx.broker.buy(entry.symbol, entry.notional, entry.reason, entryMetadata);
      if (result) {
        const filledPosition = await this.getFilledPosition(ctx, entry.symbol);
        const entryPrice = this.getPositionEntryPrice(filledPosition);
        heldSymbols.add(entry.symbol);
        heldSymbols.add(this.normalizeStateSymbol(entry.symbol));
        openPositionCount++;
        executedEntrySymbols.push(entry.symbol);
        const originalSignal = this.findSignalForSymbol(entry.symbol);
        const aggregatedSocial = this.findSocialSnapshotForSymbol(socialSnapshot, entry.symbol);
        this.setPositionEntry(
          entry.symbol,
          this.enrichPositionEntryWithExecutionMetadata(
            {
              symbol: entry.symbol,
              entry_time: Date.now(),
              entry_price: entryPrice,
              entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? finalConfidence,
              entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
              entry_sources: aggregatedSocial
                ? aggregatedSocial.sources
                : originalSignal?.subreddits || [originalSignal?.source || "research"],
              entry_reason: entry.reason,
              peak_price: entryPrice,
              trough_price: entryPrice,
              peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? finalConfidence,
            },
            entryMetadata
          )
        );
      }
    }

    for (const rec of analysis.recommendations) {
      if (rec.action === "BUY") {
        if (openPositionCount >= this.state.config.max_positions) {
          await this.recordMissedEntryOpportunity(rec.symbol, "position_capacity", {
            agent: "Analyst",
            action: "llm_buy_skipped_no_capacity",
            confidence: rec.confidence,
          });
          continue;
        }
        if (heldSymbols.has(rec.symbol) || heldSymbols.has(this.normalizeStateSymbol(rec.symbol))) continue;
        if (entrySymbols.has(rec.symbol) || entrySymbols.has(this.normalizeStateSymbol(rec.symbol))) continue;
        if (!this.checkEntryPerformanceBlock(ctx, rec.symbol, "Analyst", "llm_buy_skipped_poor_recent_performance")) {
          await this.recordMissedEntryOpportunity(rec.symbol, "poor_recent_performance", {
            agent: "Analyst",
            action: "llm_buy_skipped_poor_recent_performance",
            confidence: rec.confidence,
          });
          continue;
        }
        if (
          !this.checkPortfolioBucket(
            ctx,
            rec.symbol,
            positions,
            heldSymbols,
            executedEntrySymbols,
            "Analyst",
            "llm_buy_skipped_portfolio_bucket"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "portfolio_bucket", {
            agent: "Analyst",
            action: "llm_buy_skipped_portfolio_bucket",
            confidence: rec.confidence,
          });
          continue;
        }
        if (this.shouldBlockEquityEntryNearClose(clock, rec.symbol, "Analyst", "llm_buy_skipped_close_window")) {
          await this.recordMissedEntryOpportunity(rec.symbol, "close_window", {
            agent: "Analyst",
            action: "llm_buy_skipped_close_window",
            confidence: rec.confidence,
          });
          continue;
        }
        if (this.shouldBlockEquityEntryAfterOpen(clock, rec.symbol, "Analyst", "llm_buy_skipped_open_window")) {
          await this.recordMissedEntryOpportunity(rec.symbol, "open_window", {
            agent: "Analyst",
            action: "llm_buy_skipped_open_window",
            confidence: rec.confidence,
          });
          continue;
        }
        if (
          !this.checkRecommendationBuyQuality(
            ctx,
            rec.symbol,
            rec.confidence,
            "Analyst",
            "llm_buy_skipped_quality_gate"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "quality_gate", {
            agent: "Analyst",
            action: "llm_buy_skipped_quality_gate",
            confidence: rec.confidence,
          });
          continue;
        }
        const recResearch = findEntryResearch(Object.values(this.state.signalResearch), rec.symbol);
        if (
          await this.shouldBlockEntryTimingForResearch(
            ctx,
            rec.symbol,
            recResearch?.confidence ?? rec.confidence,
            recResearch?.entry_quality,
            "Analyst",
            "llm_buy_skipped_timing_gate"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "timing_gate", {
            agent: "Analyst",
            action: "llm_buy_skipped_timing_gate",
            confidence: rec.confidence,
            entryQuality: recResearch?.entry_quality,
          });
          continue;
        }

        const cooldown = getRecentSellCooldown(ctx, rec.symbol);
        if (cooldown.blocked) {
          this.log("Analyst", "llm_buy_skipped_recent_sell_cooldown", {
            symbol: rec.symbol,
            symbol_key: cooldown.symbolKey,
            remaining_minutes: cooldown.remainingMinutes,
            sell_reason: cooldown.reason,
          });
          await this.recordMissedEntryOpportunity(rec.symbol, "recent_sell_cooldown", {
            agent: "Analyst",
            action: "llm_buy_skipped_recent_sell_cooldown",
            confidence: rec.confidence,
          });
          continue;
        }

        const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
        const sizeMultiplier = getEntrySizeMultiplier(ctx, rec.confidence);
        const notional = Math.min(
          account.cash * (sizePct / 100) * rec.confidence * sizeMultiplier,
          this.state.config.max_position_value
        );
        if (notional < 100) {
          this.log("Analyst", "llm_buy_skipped_notional_too_small", {
            symbol: rec.symbol,
            confidence: rec.confidence,
            notional,
            min_notional: 100,
            cash: account.cash,
            max_position_value: this.state.config.max_position_value,
          });
          await this.recordMissedEntryOpportunity(rec.symbol, "notional_too_small", {
            agent: "Analyst",
            action: "llm_buy_skipped_notional_too_small",
            confidence: rec.confidence,
            notional,
          });
          continue;
        }

        const metadata = await this.enrichEntryExecutionMetadata(
          rec.symbol,
          this.buildRecommendationBuyMetadata(ctx, rec.symbol, rec.confidence, "llm_recommendation")
        );
        if (
          !this.checkEntryFeaturePerformanceBlock(
            ctx,
            rec.symbol,
            metadata,
            "Analyst",
            "llm_buy_skipped_poor_feature_performance"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "poor_feature_performance", {
            agent: "Analyst",
            action: "llm_buy_skipped_poor_feature_performance",
            confidence: rec.confidence,
            notional,
          });
          continue;
        }

        const result = await ctx.broker.buy(rec.symbol, notional, rec.reasoning, metadata);
        if (result) {
          const filledPosition = await this.getFilledPosition(ctx, rec.symbol);
          const entryPrice = this.getPositionEntryPrice(filledPosition);
          const originalSignal = this.findSignalForSymbol(rec.symbol);
          const aggregatedSocial = this.findSocialSnapshotForSymbol(socialSnapshot, rec.symbol);
          heldSymbols.add(rec.symbol);
          heldSymbols.add(this.normalizeStateSymbol(rec.symbol));
          openPositionCount++;
          this.setPositionEntry(
            rec.symbol,
            this.enrichPositionEntryWithExecutionMetadata(
              {
                symbol: rec.symbol,
                entry_time: Date.now(),
                entry_price: entryPrice,
                entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? rec.confidence,
                entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
                entry_sources: aggregatedSocial
                  ? aggregatedSocial.sources
                  : originalSignal?.subreddits || [originalSignal?.source || "analyst"],
                entry_reason: rec.reasoning,
                peak_price: entryPrice,
                trough_price: entryPrice,
                peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? rec.confidence,
              },
              metadata
            )
          );
        }
      }
    }
  }

  private async executeOptionsOrder(
    contract: { symbol: string; mid_price: number; expiration: string; strike: number; delta?: number },
    quantity: number,
    equity: number,
    confidence?: number
  ): Promise<boolean> {
    if (!this.state.config.options_enabled) return false;

    const totalCost = contract.mid_price * quantity * 100;
    const maxAllowed = equity * this.state.config.options_max_pct_per_trade;
    let qty = quantity;

    if (totalCost > maxAllowed) {
      qty = Math.floor(maxAllowed / (contract.mid_price * 100));
      if (qty < 1) {
        this.log("Options", "skipped_size", { contract: contract.symbol, cost: totalCost, max: maxAllowed });
        return false;
      }
    }

    try {
      const alpaca = createAlpacaProviders(this.env);
      const [account, positions, clock] = await Promise.all([
        alpaca.trading.getAccount(),
        alpaca.trading.getPositions(),
        alpaca.trading.getClock(),
      ]);
      const db = createD1Client(this.env.DB);
      const policyConfig = getDefaultPolicyConfig(this.env);
      policyConfig.deny_symbols = this.state.config.ticker_blacklist ?? policyConfig.deny_symbols;
      policyConfig.options = {
        ...policyConfig.options,
        options_enabled: this.state.config.options_enabled,
        max_pct_per_option_trade: this.state.config.options_max_pct_per_trade,
        min_dte: this.state.config.options_min_dte,
        max_dte: this.state.config.options_max_dte,
        min_delta: this.state.config.options_min_delta,
        max_delta: this.state.config.options_max_delta,
        min_confidence_for_options: this.state.config.options_min_confidence,
      };
      policyConfig.open_position_loss_entry_guard_enabled =
        this.state.config.open_position_loss_entry_guard_enabled ?? policyConfig.open_position_loss_entry_guard_enabled;
      policyConfig.open_position_loss_entry_guard_pct =
        this.state.config.open_position_loss_entry_guard_pct ?? policyConfig.open_position_loss_entry_guard_pct;
      policyConfig.open_position_loss_guard_min_confidence =
        this.state.config.open_position_loss_guard_min_confidence ??
        policyConfig.open_position_loss_guard_min_confidence;
      const riskState = await getRiskState(db);
      const parsedOption = parseOccOptionSymbol(contract.symbol);
      const underlying = parsedOption?.underlying ?? contract.symbol.replace(/\d{6,}.+$/, "");
      const cooldownCtx = {
        config: this.state.config,
        state: {
          get: (key: string) => (this.state as unknown as Record<string, unknown>)[key],
          set: (key: string, value: unknown) => {
            (this.state as unknown as Record<string, unknown>)[key] = value;
          },
        },
        signals: this.state.signalCache,
        positionEntries: this.state.positionEntries,
      } as StrategyContext;
      const cooldown = getRecentSellCooldown(cooldownCtx, contract.symbol);
      if (cooldown.blocked) {
        this.log("Options", "options_buy_skipped_recent_sell_cooldown", {
          contract: contract.symbol,
          underlying,
          symbol_key: cooldown.symbolKey,
          remaining_minutes: cooldown.remainingMinutes,
          sell_reason: cooldown.reason,
        });
        return false;
      }
      const expiration = parsedOption?.expiration ?? contract.expiration;
      const strike = parsedOption?.strike ?? contract.strike;
      const optionType = parsedOption?.optionType ?? "call";
      const dte = Math.ceil((new Date(expiration).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const maxOptionSpreadPct = this.state.config.options_max_spread_pct ?? 8;
      const latestSnapshot = await alpaca.options.getSnapshot(contract.symbol).catch(() => null);
      const quoteCheck = evaluateOptionEntryQuote(latestSnapshot?.latest_quote, maxOptionSpreadPct);
      if (!quoteCheck.allowed || quoteCheck.midPrice === null) {
        this.log("Options", "options_buy_skipped_quote_check", {
          contract: contract.symbol,
          reason: quoteCheck.reason ?? "quote_unavailable",
          bid: quoteCheck.bid,
          ask: quoteCheck.ask,
          spread_pct: quoteCheck.spreadPct === null ? null : Number(quoteCheck.spreadPct.toFixed(4)),
          max_spread_pct: maxOptionSpreadPct,
        });
        return false;
      }
      const latestTotalCost = quoteCheck.midPrice * qty * 100;
      if (latestTotalCost > maxAllowed) {
        const adjustedQty = Math.floor(maxAllowed / (quoteCheck.midPrice * 100));
        if (adjustedQty < 1) {
          this.log("Options", "skipped_size", {
            contract: contract.symbol,
            cost: latestTotalCost,
            max: maxAllowed,
            reason: "latest_quote_exceeds_size_limit",
          });
          return false;
        }
        qty = adjustedQty;
      }
      const limitPrice = Math.round(quoteCheck.midPrice * 100) / 100;
      const optionsOrder = {
        contract_symbol: contract.symbol,
        underlying,
        side: "buy" as const,
        qty,
        order_type: "limit" as const,
        limit_price: limitPrice,
        time_in_force: "day" as const,
        expiration,
        strike,
        option_type: optionType,
        dte,
        delta: contract.delta,
        confidence,
        estimated_premium: limitPrice,
        estimated_cost: limitPrice * qty * 100,
        quote_bid: quoteCheck.bid,
        quote_ask: quoteCheck.ask,
        quote_spread_pct: Number((quoteCheck.spreadPct ?? 0).toFixed(4)),
      };
      const policyResult = new PolicyEngine(policyConfig).evaluateOptionsOrder({
        order: optionsOrder,
        account,
        positions,
        clock,
        riskState,
      });
      if (!policyResult.allowed) {
        const violationRules = policyResult.violations.map((violation) => violation.rule);
        this.log("Options", "options_buy_rejected", {
          contract: contract.symbol,
          reason: violationRules[0] ?? "policy_violation",
          violation_rules: violationRules,
          violations: policyResult.violations.map((violation) => violation.message),
        });
        return false;
      }

      let openOrders: Awaited<ReturnType<typeof alpaca.trading.listOrders>>;
      try {
        openOrders = await alpaca.trading.listOrders({ status: "open", symbols: [contract.symbol] });
      } catch (orderError) {
        this.log("Options", "options_buy_skipped_pending_order_check_unavailable", {
          contract: contract.symbol,
          reason: "pending_order_check_unavailable",
          error: String(orderError),
        });
        return false;
      }
      const pendingBuy = openOrders.find(
        (openOrder) =>
          openOrder.symbol === contract.symbol &&
          openOrder.side === "buy" &&
          !["filled", "canceled", "expired", "rejected"].includes(openOrder.status)
      );
      if (pendingBuy) {
        this.log("Options", "options_buy_skipped_pending_order", {
          contract: contract.symbol,
          order_id: pendingBuy.id,
          status: pendingBuy.status,
        });
        return false;
      }

      const order = await alpaca.trading.createOrder({
        symbol: contract.symbol,
        qty,
        side: "buy",
        type: "limit",
        limit_price: limitPrice,
        time_in_force: "day",
      });

      const orderFilled = order.status === "filled" || order.status === "partially_filled";

      this.log("Options", orderFilled ? "options_buy_executed" : "options_buy_submitted", {
        contract: contract.symbol,
        qty,
        status: order.status,
        order_id: order.id,
        filled_qty: order.filled_qty,
        filled_avg_price: order.filled_avg_price,
        estimated_cost: (contract.mid_price * qty * 100).toFixed(2),
      });
      if (["rejected", "canceled", "expired"].includes(order.status)) return false;

      try {
        const tradeId = await createTrade(db, {
          alpaca_order_id: order.id,
          symbol: contract.symbol,
          side: "buy",
          qty,
          order_type: "limit",
          limit_price: limitPrice,
          status: order.status,
          filled_qty: Number(order.filled_qty) || undefined,
          filled_avg_price: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        });
        if (orderFilled) {
          await createJournalEntry(db, {
            trade_id: tradeId,
            symbol: contract.symbol,
            side: "buy",
            entry_price: order.filled_avg_price ? Number(order.filled_avg_price) : limitPrice,
            qty: Number(order.filled_qty) || qty,
            signals: {
              underlying: optionsOrder.underlying,
              reason: "options_entry",
              policy: {
                warnings: policyResult.warnings.map((warning) => warning.message),
              },
            },
            technicals: {
              strike,
              expiration,
              option_type: optionType,
              delta: contract.delta,
              confidence,
              premium: limitPrice,
              parsed_option: parsedOption,
            },
            regime_tags: ["autonomous", "options", "policy_broker"],
            notes: "Options entry",
          });
        } else {
          this.log("Options", "options_outcome_deferred", {
            contract: contract.symbol,
            order_id: order.id,
            status: order.status,
            reason: "Options buy order not filled yet; deferring trade journal entry",
          });
        }
        await createR2Client(this.env.ARTIFACTS).putJson(R2Paths.tradeSnapshot(tradeId), {
          trade_id: tradeId,
          exported_from: "options_order",
          captured_at: new Date().toISOString(),
          contract,
          parsed_option: parsedOption,
          order: optionsOrder,
          alpaca_order: order,
          fill: buildOptionsOrderFillSnapshot(order, limitPrice),
          policy: {
            warnings: policyResult.warnings.map((warning) => warning.message),
          },
        });
      } catch (recordError) {
        this.log("Options", "options_trade_record_failed", { contract: contract.symbol, error: String(recordError) });
      }

      return orderFilled;
    } catch (error) {
      this.log("Options", "options_buy_failed", { contract: contract.symbol, error: String(error) });
      return false;
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

    const signalResearch = await this.researchTopSignals(ctx, this.state.config.signal_research_limit ?? 10);
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

    const heldSymbols = new Set(positions.flatMap((p) => [p.symbol, this.normalizeStateSymbol(p.symbol)]));
    let openPositionCount = positions.length;
    const socialSnapshot = this.getSocialSnapshotCache();
    await this.refreshEntryPerformanceBlocks(ctx);

    this.log("System", "executing_premarket_plan", {
      recommendations: this.state.premarketPlan.recommendations.length,
    });

    // Sells first
    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "SELL" && rec.confidence >= this.state.config.min_analyst_confidence) {
        const result = await ctx.broker.sell(rec.symbol, `Pre-market plan: ${rec.reasoning}`);
        if (result) {
          heldSymbols.delete(rec.symbol);
          heldSymbols.delete(this.normalizeStateSymbol(rec.symbol));
          openPositionCount = Math.max(0, openPositionCount - 1);
        }
      }
    }

    // Then buys
    const executedPremarketBuySymbols: string[] = [];
    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "BUY" && rec.confidence >= this.state.config.min_analyst_confidence) {
        if (heldSymbols.has(rec.symbol) || heldSymbols.has(this.normalizeStateSymbol(rec.symbol))) continue;
        if (openPositionCount >= this.state.config.max_positions) {
          await this.recordMissedEntryOpportunity(rec.symbol, "position_capacity", {
            agent: "System",
            action: "premarket_buy_skipped_no_capacity",
            confidence: rec.confidence,
          });
          break;
        }
        if (
          !this.checkEntryPerformanceBlock(ctx, rec.symbol, "System", "premarket_buy_skipped_poor_recent_performance")
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "poor_recent_performance", {
            agent: "System",
            action: "premarket_buy_skipped_poor_recent_performance",
            confidence: rec.confidence,
          });
          continue;
        }
        if (
          !this.checkPortfolioBucket(
            ctx,
            rec.symbol,
            positions,
            heldSymbols,
            executedPremarketBuySymbols,
            "System",
            "premarket_buy_skipped_portfolio_bucket"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "portfolio_bucket", {
            agent: "System",
            action: "premarket_buy_skipped_portfolio_bucket",
            confidence: rec.confidence,
          });
          continue;
        }
        const clock = await ctx.broker.getClock();
        if (this.shouldBlockEquityEntryNearClose(clock, rec.symbol, "System", "premarket_buy_skipped_close_window")) {
          await this.recordMissedEntryOpportunity(rec.symbol, "close_window", {
            agent: "System",
            action: "premarket_buy_skipped_close_window",
            confidence: rec.confidence,
          });
          continue;
        }
        if (this.shouldBlockEquityEntryAfterOpen(clock, rec.symbol, "System", "premarket_buy_skipped_open_window")) {
          await this.recordMissedEntryOpportunity(rec.symbol, "open_window", {
            agent: "System",
            action: "premarket_buy_skipped_open_window",
            confidence: rec.confidence,
          });
          continue;
        }
        if (
          !this.checkRecommendationBuyQuality(
            ctx,
            rec.symbol,
            rec.confidence,
            "System",
            "premarket_buy_skipped_quality_gate"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "quality_gate", {
            agent: "System",
            action: "premarket_buy_skipped_quality_gate",
            confidence: rec.confidence,
          });
          continue;
        }
        const recResearch = findEntryResearch(Object.values(this.state.signalResearch), rec.symbol);
        if (
          await this.shouldBlockEntryTimingForResearch(
            ctx,
            rec.symbol,
            recResearch?.confidence ?? rec.confidence,
            recResearch?.entry_quality,
            "System",
            "premarket_buy_skipped_timing_gate"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "timing_gate", {
            agent: "System",
            action: "premarket_buy_skipped_timing_gate",
            confidence: rec.confidence,
            entryQuality: recResearch?.entry_quality,
          });
          continue;
        }

        const cooldown = getRecentSellCooldown(ctx, rec.symbol);
        if (cooldown.blocked) {
          this.log("System", "premarket_buy_skipped_recent_sell_cooldown", {
            symbol: rec.symbol,
            symbol_key: cooldown.symbolKey,
            remaining_minutes: cooldown.remainingMinutes,
            sell_reason: cooldown.reason,
          });
          await this.recordMissedEntryOpportunity(rec.symbol, "recent_sell_cooldown", {
            agent: "System",
            action: "premarket_buy_skipped_recent_sell_cooldown",
            confidence: rec.confidence,
          });
          continue;
        }

        const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
        const sizeMultiplier = getEntrySizeMultiplier(ctx, rec.confidence);
        const notional = Math.min(
          account.cash * (sizePct / 100) * rec.confidence * sizeMultiplier,
          this.state.config.max_position_value
        );
        if (notional < 100) {
          await this.recordMissedEntryOpportunity(rec.symbol, "notional_too_small", {
            agent: "System",
            action: "premarket_buy_skipped_notional_too_small",
            confidence: rec.confidence,
            notional,
          });
          continue;
        }

        const metadata = await this.enrichEntryExecutionMetadata(
          rec.symbol,
          this.buildRecommendationBuyMetadata(ctx, rec.symbol, rec.confidence, "premarket_plan")
        );
        if (
          !this.checkEntryFeaturePerformanceBlock(
            ctx,
            rec.symbol,
            metadata,
            "System",
            "premarket_buy_skipped_poor_feature_performance"
          )
        ) {
          await this.recordMissedEntryOpportunity(rec.symbol, "poor_feature_performance", {
            agent: "System",
            action: "premarket_buy_skipped_poor_feature_performance",
            confidence: rec.confidence,
            notional,
          });
          continue;
        }

        const result = await ctx.broker.buy(rec.symbol, notional, "Pre-market plan: " + rec.reasoning, metadata);
        if (result) {
          const filledPosition = await this.getFilledPosition(ctx, rec.symbol);
          const entryPrice = this.getPositionEntryPrice(filledPosition);
          heldSymbols.add(rec.symbol);
          heldSymbols.add(this.normalizeStateSymbol(rec.symbol));
          openPositionCount++;
          executedPremarketBuySymbols.push(rec.symbol);
          const originalSignal = this.findSignalForSymbol(rec.symbol);
          const aggregatedSocial = this.findSocialSnapshotForSymbol(socialSnapshot, rec.symbol);
          this.setPositionEntry(
            rec.symbol,
            this.enrichPositionEntryWithExecutionMetadata(
              {
                symbol: rec.symbol,
                entry_time: Date.now(),
                entry_price: entryPrice,
                entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? 0,
                entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
                entry_sources: aggregatedSocial
                  ? aggregatedSocial.sources
                  : originalSignal?.subreddits || [originalSignal?.source || "premarket"],
                entry_reason: rec.reasoning,
                peak_price: entryPrice,
                trough_price: entryPrice,
                peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? 0,
              },
              metadata
            )
          );
        }
      }
    }

    this.state.premarketPlan = null;
  }

  // ============================================================================
  // HTTP HANDLER
  // ============================================================================

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private isAuthorized(request: Request): boolean {
    const token = this.env.MAHORAGA_API_TOKEN;
    if (!token) {
      console.warn("[MahoragaHarness] MAHORAGA_API_TOKEN not set - denying request");
      return false;
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    return this.constantTimeCompare(authHeader.slice(7), token);
  }

  private isKillSwitchAuthorized(request: Request): boolean {
    const secret = this.env.KILL_SWITCH_SECRET;
    if (!secret) return false;
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    return this.constantTimeCompare(authHeader.slice(7), secret);
  }

  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <MAHORAGA_API_TOKEN>" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
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
      "trade-review",
      "costs",
      "signals",
      "history",
      "position-history",
      "discord/test",
      "twitter/test",
      "reddit/test",
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
        case "trade-review":
          return this.handleTradeReview(url);
        case "costs":
          return this.jsonResponse({ costs: this.state.costTracker });
        case "signals":
          return this.jsonResponse({ signals: this.state.signalCache });
        case "history":
          return this.handleGetHistory(url);
        case "position-history":
          return this.handleGetPositionHistory(url);
        case "discord/test":
          if (request.method !== "POST") {
            return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
              status: 405,
              headers: { "Content-Type": "application/json" },
            });
          }
          return this.handleTestDiscordNotification(request);
        case "twitter/test":
          if (request.method !== "POST") {
            return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
              status: 405,
              headers: { "Content-Type": "application/json" },
            });
          }
          return this.handleTestTwitterCookies(request);
        case "reddit/test":
          if (request.method !== "POST") {
            return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
              status: 405,
              headers: { "Content-Type": "application/json" },
            });
          }
          return this.handleTestRedditCookies(request);
        case "trigger":
          await this.alarm();
          return this.jsonResponse({ ok: true, message: "Alarm triggered" });
        case "kill":
          if (!this.isKillSwitchAuthorized(request)) {
            return new Response(
              JSON.stringify({ error: "Forbidden. Requires: Authorization: Bearer <KILL_SWITCH_SECRET>" }),
              { status: 403, headers: { "Content-Type": "application/json" } }
            );
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
    this.state.signalResearch = pruneSignalResearchMap(this.state.signalResearch);

    let account: Account | null = null;
    let positions: Position[] = [];
    let clock: MarketClock | null = null;

    try {
      [account, positions, clock] = await Promise.all([
        alpaca.trading.getAccount(),
        alpaca.trading.getPositions(),
        alpaca.trading.getClock(),
      ]);

      for (const pos of positions || []) {
        const entry = this.getPositionEntry(pos.symbol);
        if (entry && entry.entry_price === 0 && pos.avg_entry_price) {
          entry.entry_price = pos.avg_entry_price;
          entry.peak_price = Math.max(entry.peak_price, pos.current_price);
        }
      }
    } catch (_e) {
      // Ignore - will return null
    }

    return this.jsonResponse({
      ok: true,
      data: {
        runtimeSummary: {
          ...summarizeRuntimeLogs(this.state.logs.slice(-100)),
          adaptive_performance: summarizeAdaptivePerformanceBlocks(this.state),
        },
        enabled: this.state.enabled,
        strategy: activeStrategy.name,
        account,
        positions,
        clock,
        config: this.state.config,
        signals: this.state.signalCache,
        logs: this.state.logs.slice(-100),
        costs: this.state.costTracker,
        lastAnalystRun: this.state.lastAnalystRun,
        lastResearchRun: this.state.lastResearchRun,
        lastPositionResearchRun: this.state.lastPositionResearchRun,
        signalResearch: pruneSignalResearchMap(this.state.signalResearch),
        positionResearch: this.state.positionResearch,
        positionEntries: this.state.positionEntries,
        adaptivePerformance: summarizeAdaptivePerformanceBlocks(this.state),
        recentSells: this.state.recentSells,
        twitterConfirmations: this.state.twitterConfirmations,
        premarketPlan: this.state.premarketPlan,
        stalenessAnalysis: this.state.stalenessAnalysis,
        lastDiscordDailyReportDay: this.state.lastDiscordDailyReportDay,
      },
    });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<AgentConfig>;
    const merged = mergeAgentConfigWithDefaults({ ...this.state.config, ...body });

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
    return this.jsonResponse({ ok: true, config: this.state.config });
  }

  private async handleTestDiscordNotification(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { webhook_url?: unknown };
    const webhookUrlOverride = typeof body.webhook_url === "string" ? body.webhook_url.trim() : "";
    if (webhookUrlOverride && !this.isValidWebhookUrl(webhookUrlOverride)) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid Discord webhook URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sent = await this.postDiscordEmbeds(
      "test_notification",
      [
        {
          title: "MAHORAGA Discord Test",
          color: 0x38bdf8,
          description: "Sentinel webhook configuration is working.",
          fields: [
            { name: "Agent", value: "MAHORAGA", inline: true },
            { name: "Time", value: new Date().toISOString(), inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "MAHORAGA SENTINEL" },
        },
      ],
      undefined,
      webhookUrlOverride || undefined
    );

    if (!sent) {
      return new Response(JSON.stringify({ ok: false, error: "Discord test notification failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return this.jsonResponse({ ok: true, message: "Discord test notification sent" });
  }

  private async handleTestTwitterCookies(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      cookies?: unknown;
      accounts?: unknown;
      prefer_env?: unknown;
    };
    const cookiesOverride = typeof body.cookies === "string" ? body.cookies.trim() : "";
    const accountOverrides = Array.isArray(body.accounts)
      ? body.accounts
          .map((account) => {
            if (typeof account === "string") return { cookies: account.trim(), source: "override" };
            if (account && typeof account === "object" && "cookies" in account && typeof account.cookies === "string") {
              return { cookies: account.cookies.trim(), source: "override" };
            }
            return null;
          })
          .filter((account): account is { cookies: string; source: string } => !!account?.cookies)
      : [];
    const preferEnv = body.prefer_env === true;
    const configAccounts = preferEnv
      ? []
      : (this.state.config.twitter_cookie_accounts || [])
          .map((account, index) => ({
            cookies: account.cookies.trim(),
            source: "config_account",
            account_index: index,
          }))
          .filter((account) => account.cookies);
    const configCookies = preferEnv ? "" : this.state.config.twitter_cookies?.trim() || "";
    const envCookies = this.env.TWITTER_COOKIES?.trim() || "";
    const accounts =
      accountOverrides.length > 0
        ? accountOverrides
        : cookiesOverride
          ? [{ cookies: cookiesOverride, source: "override" }]
          : configAccounts.length > 0
            ? configAccounts
            : configCookies
              ? [{ cookies: configCookies, source: "config" }]
              : envCookies
                ? [{ cookies: envCookies, source: "env" }]
                : [];

    if (accounts.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Twitter/X cookies are not configured", source: "none" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = await Promise.all(
      accounts.map(async (account, index) => {
        const result = await testTwitterCookieConnection(account.cookies);
        return {
          ok: result.ok,
          authenticated: result.authenticated,
          source: account.source,
          account_index: "account_index" in account && typeof account.account_index === "number" ? account.account_index : index,
          cookie_count: result.cookie_count,
          error: result.error,
        };
      })
    );
    const passed = results.filter((result) => result.ok).length;
    this.log("Twitter", "cookie_connection_tested", {
      ok: passed > 0,
      account_count: results.length,
      passed,
    });

    if (passed === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: results[0]?.error || "Twitter/X cookie authentication failed",
          data: {
            account_count: results.length,
            passed,
            results,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return this.jsonResponse({
      ok: true,
      message: `Twitter/X cookie authentication succeeded (${passed}/${results.length})`,
      data: {
        account_count: results.length,
        passed,
        results,
      },
    });
  }

  private async handleTestRedditCookies(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      cookies?: unknown;
      accounts?: unknown;
      user_agent?: unknown;
      subreddit?: unknown;
      prefer_env?: unknown;
    };
    const userAgent =
      (typeof body.user_agent === "string" ? body.user_agent.trim() : "") ||
      this.state.config.reddit_user_agent?.trim() ||
      this.env.REDDIT_USER_AGENT?.trim() ||
      "";
    const subreddit = typeof body.subreddit === "string" && body.subreddit.trim() ? body.subreddit.trim() : "wallstreetbets";
    const cookiesOverride = typeof body.cookies === "string" ? body.cookies.trim() : "";
    const accountOverrides = Array.isArray(body.accounts)
      ? body.accounts
          .map((account) => {
            if (typeof account === "string") return { cookies: account.trim(), source: "override" };
            if (account && typeof account === "object" && "cookies" in account && typeof account.cookies === "string") {
              return { cookies: account.cookies.trim(), source: "override" };
            }
            return null;
          })
          .filter((account): account is { cookies: string; source: string } => !!account?.cookies)
      : [];
    const preferEnv = body.prefer_env === true;
    const configAccounts = preferEnv
      ? []
      : (this.state.config.reddit_cookie_accounts || [])
          .map((account, index) => ({
            cookies: account.cookies.trim(),
            source: "config_account",
            account_index: index,
          }))
          .filter((account) => account.cookies);
    const configCookies = preferEnv ? "" : this.state.config.reddit_cookies?.trim() || "";
    const envCookies = this.env.REDDIT_COOKIES?.trim() || "";
    const accounts =
      accountOverrides.length > 0
        ? accountOverrides
        : cookiesOverride
          ? [{ cookies: cookiesOverride, source: "override" }]
          : configAccounts.length > 0
            ? configAccounts
            : configCookies
              ? [{ cookies: configCookies, source: "config" }]
              : envCookies
                ? [{ cookies: envCookies, source: "env" }]
                : [];

    if (accounts.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Reddit cookies are not configured", source: "none" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = await Promise.all(
      accounts.map(async (account, index) => {
        const result = await testRedditCookieConnection(account.cookies, userAgent, subreddit);
        return {
          ok: result.ok,
          source: account.source,
          account_index: "account_index" in account && typeof account.account_index === "number" ? account.account_index : index,
          cookie_count: result.cookie_count,
          post_count: result.post_count,
          status: result.status,
          error: result.error,
        };
      })
    );
    const passed = results.filter((result) => result.ok).length;
    this.log("Reddit", "cookie_connection_tested", {
      ok: passed > 0,
      account_count: results.length,
      passed,
      subreddit,
    });

    if (passed === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: results[0]?.error || "Reddit cookie connection failed",
          data: {
            account_count: results.length,
            passed,
            subreddit,
            results,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return this.jsonResponse({
      ok: true,
      message: `Reddit cookie connection succeeded (${passed}/${results.length})`,
      data: {
        account_count: results.length,
        passed,
        subreddit,
        results,
      },
    });
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

  private async handleTradeReview(url: URL): Promise<Response> {
    const days = this.parseBoundedInt(url.searchParams.get("days"), 90, 1, 3650);
    const limit = this.parseBoundedInt(url.searchParams.get("limit"), 500, 1, 1000);
    const includeSnapshots = url.searchParams.get("include_snapshots") === "true";
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const db = createD1Client(this.env.DB);

    const rows = await db.execute<Record<string, unknown>>(
      `SELECT
        tj.id AS journal_id,
        tj.trade_id,
        tj.symbol,
        tj.side,
        tj.entry_price,
        tj.entry_at,
        tj.exit_price,
        tj.exit_at,
        tj.qty,
        tj.pnl_usd,
        tj.pnl_pct,
        tj.hold_duration_mins,
        tj.signals_json,
        tj.technicals_json,
        tj.regime_tags,
        tj.event_ids,
        tj.outcome,
        tj.notes,
        tj.lessons_learned,
        tj.created_at AS journal_created_at,
        tj.updated_at AS journal_updated_at,
        t.alpaca_order_id,
        t.order_type,
        t.limit_price,
        t.stop_price,
        t.status AS trade_status,
        t.filled_qty,
        t.filled_avg_price,
        t.created_at AS trade_created_at,
        t.updated_at AS trade_updated_at
      FROM trade_journal tj
      LEFT JOIN trades t ON t.id = tj.trade_id
      WHERE COALESCE(tj.updated_at, tj.created_at, t.updated_at, t.created_at) >= ?
      ORDER BY COALESCE(tj.updated_at, tj.created_at, t.updated_at, t.created_at) DESC
      LIMIT ?`,
      [cutoff, limit]
    );

    const snapshots: Record<string, unknown> = {};
    if (includeSnapshots) {
      const r2 = createR2Client(this.env.ARTIFACTS);
      await Promise.all(
        rows.slice(0, 100).map(async (row) => {
          const snapshotId = String(row.trade_id || row.journal_id || "");
          if (!snapshotId) return;
          try {
            const snapshot = await r2.getJson(R2Paths.tradeSnapshot(snapshotId));
            if (snapshot !== null) snapshots[snapshotId] = snapshot;
          } catch (error) {
            snapshots[snapshotId] = { error: String(error) };
          }
        })
      );
    }

    const runtimeLogs = this.state.logs.slice(-Math.min(limit, 500));
    const summary = buildTradeReviewSummary(rows, snapshots);
    const runtimeSummary = {
      ...summarizeRuntimeLogs(runtimeLogs),
      adaptive_performance: summarizeAdaptivePerformanceBlocks(this.state),
    };

    return this.jsonResponse({
      ok: true,
      exported_at: new Date().toISOString(),
      days,
      limit,
      include_snapshots: includeSnapshots,
      count: rows.length,
      summary,
      runtime_summary: runtimeSummary,
      tuning_suggestions: buildTradeReviewTuningSuggestions(summary, runtimeSummary, this.state.config),
      rows,
      snapshots,
      runtime_logs: runtimeLogs,
    });
  }

  private parseBoundedInt(raw: string | null, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(raw || "", 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);
    const period = url.searchParams.get("period") || "1M";
    const timeframe = url.searchParams.get("timeframe") || "1D";
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

  private getPeriodStartMs(period: string, nowMs = Date.now()): number {
    const normalized = period.toUpperCase();
    if (normalized === "5MIN" || normalized === "5M") return nowMs - 5 * 60 * 1000;
    if (normalized === "1H") return nowMs - 60 * 60 * 1000;
    if (normalized === "6H") return nowMs - 6 * 60 * 60 * 1000;
    if (normalized === "1D") return nowMs - 24 * 60 * 60 * 1000;
    if (normalized === "7D") return nowMs - 7 * 24 * 60 * 60 * 1000;
    if (normalized === "1M" || normalized === "30D") return nowMs - 30 * 24 * 60 * 60 * 1000;
    return nowMs - 7 * 24 * 60 * 60 * 1000;
  }

  private buildTimelinePoint(timestamp: number, price: number, entryPrice: number): PositionTimelinePoint {
    return {
      timestamp,
      price,
      change_pct: entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 : 0,
    };
  }

  private getPositionHistoryLimit(period: string): number {
    const normalized = period.toUpperCase();
    if (normalized === "5MIN" || normalized === "5M") return 10;
    if (normalized === "1H") return 90;
    if (normalized === "6H") return 120;
    if (normalized === "1D") return 120;
    if (normalized === "30D" || normalized === "1M") return 60;
    return 120;
  }

  private async buildOpenPositionTimeline(
    symbol: string,
    entryTime: number,
    entryPrice: number,
    currentPrice: number,
    period: string,
    timeframe: string,
    cutoffMs: number,
    nowMs: number
  ): Promise<PositionTimelinePoint[]> {
    const points = new Map<number, PositionTimelinePoint>();
    points.set(entryTime, this.buildTimelinePoint(entryTime, entryPrice, entryPrice));

    try {
      const alpaca = createAlpacaProviders(this.env);
      const bars = await alpaca.marketData
        .getBars(symbol, timeframe, {
          start: new Date(Math.min(entryTime, cutoffMs)).toISOString(),
          end: new Date(nowMs).toISOString(),
          limit: this.getPositionHistoryLimit(period),
        })
        .catch(() => []);

      for (const bar of bars) {
        const timestamp = new Date(bar.t).getTime();
        const price = Number(bar.c);
        if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) continue;
        if (timestamp < Math.min(entryTime, cutoffMs) || timestamp > nowMs) continue;
        points.set(timestamp, this.buildTimelinePoint(timestamp, price, entryPrice));
      }
    } catch (error) {
      this.log("System", "position_history_bars_unavailable", { symbol, error: String(error) });
    }

    points.set(nowMs, this.buildTimelinePoint(nowMs, currentPrice, entryPrice));

    return [...points.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((point, index, items) => index === 0 || items[index - 1]!.timestamp !== point.timestamp);
  }

  private async handleGetPositionHistory(url: URL): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);
    const db = createD1Client(this.env.DB);
    const period = url.searchParams.get("period") || "7D";
    const timeframe = url.searchParams.get("timeframe") || "1Hour";
    const nowMs = Date.now();
    const cutoffMs = this.getPeriodStartMs(period, nowMs);
    const cutoffIso = new Date(cutoffMs).toISOString();
    const histories: Record<string, unknown> = {};

    try {
      const positions = await alpaca.trading.getPositions();
      for (const position of positions) {
        const entry = this.getPositionEntry(position.symbol);
        const entryTime = entry?.entry_time ?? nowMs;

        const entryPrice = entry?.entry_price && entry.entry_price > 0 ? entry.entry_price : position.avg_entry_price;
        const currentPrice = position.current_price || position.lastday_price || entryPrice;
        const points = await this.buildOpenPositionTimeline(
          position.symbol,
          entryTime,
          entryPrice,
          currentPrice,
          period,
          timeframe,
          cutoffMs,
          nowMs
        );
        histories[position.symbol] = {
          symbol: position.symbol,
          entry_time: entryTime,
          entry_price: entryPrice,
          current_price: currentPrice,
          status: "OPEN",
          points,
        };
      }

      const rows = await db.execute<{
        journal_id: string;
        symbol: string;
        entry_price: number | null;
        entry_at: string | null;
        exit_price: number | null;
        exit_at: string | null;
      }>(
        `SELECT id AS journal_id, symbol, entry_price, entry_at, exit_price, exit_at
         FROM trade_journal
         WHERE exit_at IS NOT NULL
           AND COALESCE(exit_at, updated_at, created_at) >= ?
         ORDER BY COALESCE(exit_at, updated_at, created_at) DESC
         LIMIT 20`,
        [cutoffIso]
      );

      for (const row of rows) {
        if (histories[row.symbol]) continue;
        const entryPrice = Number(row.entry_price) || 0;
        const exitPrice = Number(row.exit_price) || entryPrice;
        const entryTime = row.entry_at ? new Date(row.entry_at).getTime() : cutoffMs;
        const exitTime = row.exit_at ? new Date(row.exit_at).getTime() : nowMs;
        if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime) || entryPrice <= 0) continue;

        histories[row.symbol] = {
          symbol: row.symbol,
          entry_time: entryTime,
          entry_price: entryPrice,
          current_price: exitPrice,
          exit_time: exitTime,
          exit_price: exitPrice,
          status: "SOLD",
          points: [
            this.buildTimelinePoint(entryTime, entryPrice, entryPrice),
            this.buildTimelinePoint(exitTime, exitPrice, entryPrice),
          ],
        };
      }

      return this.jsonResponse({ ok: true, data: { histories } });
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
    const entry: LogEntry = { timestamp: new Date().toISOString(), agent, action, ...details };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) {
      this.state.logs = this.state.logs.slice(-500);
    }
    console.log(`[${entry.timestamp}] [${agent}] ${action}`, JSON.stringify(details));
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

  private truncateDiscordValue(value: string, maxLength = 1024): string {
    return value.length > maxLength ? value.slice(0, maxLength - 3) + "..." : value;
  }

  private getZonedDayAndMinute(epochMs: number, timeZone: string): { day: string; minute: string } {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(new Date(epochMs));
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      const year = part("year");
      const month = part("month");
      const day = part("day");
      const hour = part("hour");
      const minute = part("minute");
      if (year && month && day && hour && minute) {
        return { day: year + "-" + month + "-" + day, minute: hour + ":" + minute };
      }
    } catch {
      // Fall back to UTC below.
    }

    const iso = new Date(epochMs).toISOString();
    return { day: iso.slice(0, 10), minute: iso.slice(11, 16) };
  }

  private getDailyReportDueKey(nowMs: number): string | null {
    if (!this.state.config.discord_daily_report_enabled) return null;

    const reportTime = this.state.config.discord_daily_report_time || "21:00";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reportTime)) {
      this.log("Discord", "daily_report_skipped", { reason: "Invalid report time", report_time: reportTime });
      return null;
    }

    const timeZone = this.state.config.discord_daily_report_timezone || "UTC";
    const zoned = this.getZonedDayAndMinute(nowMs, timeZone);
    const key = timeZone + ":" + zoned.day;
    if (this.state.lastDiscordDailyReportDay === key) return null;
    if (zoned.minute < reportTime) return null;
    return key;
  }

  private async maybeSendDiscordDailyReport(ctx: StrategyContext, positions: Position[], nowMs: number): Promise<void> {
    const dueKey = this.getDailyReportDueKey(nowMs);
    if (!dueKey) return;

    const account = await ctx.broker.getAccount().catch(() => null);
    const unrealizedPl = positions.reduce((sum, pos) => sum + (Number(pos.unrealized_pl) || 0), 0);
    const costBasis = positions.reduce((sum, pos) => {
      const basis = Number(pos.market_value) - Number(pos.unrealized_pl);
      return sum + (Number.isFinite(basis) ? basis : 0);
    }, 0);
    const unrealizedPct = costBasis > 0 ? (unrealizedPl / costBasis) * 100 : 0;
    const recentResearch = Object.values(this.state.signalResearch).filter(
      (r) => nowMs - r.timestamp < 24 * 60 * 60 * 1000
    );
    const buyResearch = recentResearch.filter((r) => r.verdict === "BUY");
    const positionLines = positions
      .slice()
      .sort((a, b) => Math.abs(b.unrealized_pl) - Math.abs(a.unrealized_pl))
      .slice(0, 10)
      .map((pos) => {
        const pct = Number.isFinite(pos.unrealized_plpc) ? pos.unrealized_plpc * 100 : 0;
        const prefix = pct >= 0 ? "+" : "";
        return pos.symbol + ": " + prefix + pct.toFixed(1) + "% ($" + pos.unrealized_pl.toFixed(2) + ")";
      });

    const plPrefix = unrealizedPl >= 0 ? "+" : "";
    const pctPrefix = unrealizedPct >= 0 ? "+" : "";
    const fields = [
      {
        name: "Portfolio",
        value: this.truncateDiscordValue(
          "Equity: $" +
            (account?.equity ?? 0).toFixed(2) +
            "\nCash: $" +
            (account?.cash ?? 0).toFixed(2) +
            "\nOpen P/L: " +
            plPrefix +
            "$" +
            unrealizedPl.toFixed(2) +
            " (" +
            pctPrefix +
            unrealizedPct.toFixed(2) +
            "%)"
        ),
        inline: false,
      },
      {
        name: "Activity",
        value:
          "Signals: " +
          this.state.signalCache.length +
          "\nResearch 24h: " +
          recentResearch.length +
          "\nBUY research 24h: " +
          buyResearch.length,
        inline: true,
      },
      {
        name: "Costs",
        value:
          "LLM calls: " + this.state.costTracker.calls + "\nLLM cost: $" + this.state.costTracker.total_usd.toFixed(4),
        inline: true,
      },
    ];

    if (positionLines.length > 0) {
      fields.push({
        name: "Open Positions",
        value: this.truncateDiscordValue(positionLines.join("\n")),
        inline: false,
      });
    }

    const sent = await this.postDiscordEmbeds("daily_report", [
      {
        title: "MAHORAGA Daily Report",
        color: unrealizedPl >= 0 ? 0x22c55e : 0xef4444,
        description: "Strategy: " + activeStrategy.name,
        fields,
        timestamp: new Date(nowMs).toISOString(),
        footer: { text: "MAHORAGA - Not financial advice - DYOR" },
      },
    ]);

    if (sent) {
      this.state.lastDiscordDailyReportDay = dueKey;
    }
  }

  private async postDiscordEmbeds(
    action: string,
    embeds: Array<{
      title: string;
      color: number;
      fields: Array<{ name: string; value: string; inline: boolean }>;
      description?: string;
      timestamp: string;
      footer: { text: string };
    }>,
    cacheKey?: string,
    webhookUrlOverride?: string
  ): Promise<boolean> {
    const configWebhookUrl = this.state.config.discord_webhook_url?.trim();
    const webhookUrl = webhookUrlOverride?.trim() || configWebhookUrl || this.env.DISCORD_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      this.log("Discord", "notification_skipped", { action, reason: "Discord webhook URL not configured" });
      return false;
    }

    if (cacheKey) {
      const lastNotification = this.discordCooldowns.get(cacheKey);
      if (lastNotification && Date.now() - lastNotification < this.DISCORD_COOLDOWN_MS) return false;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.log("Discord", "notification_failed", { action, status: response.status, body: body.slice(0, 300) });
        return false;
      }

      if (cacheKey) this.discordCooldowns.set(cacheKey, Date.now());
      this.log("Discord", "notification_sent", {
        action,
        source: webhookUrlOverride?.trim() ? "override" : configWebhookUrl ? "config" : "env",
      });
      return true;
    } catch (err) {
      this.log("Discord", "notification_failed", { action, error: String(err) });
      return false;
    }
  }

  private isValidWebhookUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  private async sendTradeExecutionNotification(
    side: "buy" | "sell",
    symbol: string,
    data: { notional?: number; reason: string }
  ): Promise<void> {
    const isBuy = side === "buy";
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: "Symbol", value: symbol, inline: true },
      { name: "Side", value: side.toUpperCase(), inline: true },
    ];

    if (typeof data.notional === "number") {
      fields.push({ name: "Notional", value: "$" + data.notional.toFixed(2), inline: true });
    }

    fields.push({ name: "Reason", value: this.truncateDiscordValue(data.reason, 900), inline: false });

    await this.postDiscordEmbeds("trade_" + side, [
      {
        title: "Trade " + (isBuy ? "BUY" : "SELL") + " Executed: $" + symbol,
        color: isBuy ? 0x22c55e : 0xef4444,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: "MAHORAGA - Not financial advice - DYOR" },
      },
    ]);
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
