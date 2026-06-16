/**
 * Entry rules - decide which signals to buy.
 *
 * Core handles PolicyEngine checks and actual order execution.
 * Core ALWAYS enforces stop-loss from config as a safety floor.
 */

import type { Account, Position, RecentSellEntry, ResearchResult } from "../../../core/types";
import type { BuyCandidate, StrategyContext } from "../../types";
import { normalizeCryptoSymbol } from "../helpers/crypto";
import { getSignedSignalSentiment } from "../helpers/sentiment";
import { parseOccOptionSymbol } from "./options";

const MS_PER_HOUR = 60 * 60 * 1000;
const MIN_MARKET_REGIME_SYMBOLS = 3;

const ENTRY_QUALITY_RANK: Record<ResearchResult["entry_quality"], number> = {
  poor: 0,
  fair: 1,
  good: 2,
  excellent: 3,
};

const SYMBOL_PORTFOLIO_BUCKETS: Record<string, string> = {
  AAPL: "technology",
  MSFT: "technology",
  NVDA: "technology",
  AMD: "technology",
  AVGO: "technology",
  QCOM: "technology",
  ORCL: "technology",
  CRM: "technology",
  ADBE: "technology",
  NOW: "technology",
  PLTR: "technology",
  SNOW: "technology",
  INTC: "technology",
  TSM: "technology",
  ASML: "technology",
  SMH: "technology",
  SOXX: "technology",
  XLK: "technology",
  GOOGL: "communication_services",
  GOOG: "communication_services",
  META: "communication_services",
  NFLX: "communication_services",
  DIS: "communication_services",
  T: "communication_services",
  VZ: "communication_services",
  XLC: "communication_services",
  AMZN: "consumer_discretionary",
  TSLA: "consumer_discretionary",
  HD: "consumer_discretionary",
  LOW: "consumer_discretionary",
  NKE: "consumer_discretionary",
  SBUX: "consumer_discretionary",
  MCD: "consumer_discretionary",
  XLY: "consumer_discretionary",
  WMT: "consumer_staples",
  COST: "consumer_staples",
  PG: "consumer_staples",
  KO: "consumer_staples",
  PEP: "consumer_staples",
  XLP: "consumer_staples",
  JPM: "financials",
  BAC: "financials",
  WFC: "financials",
  C: "financials",
  GS: "financials",
  MS: "financials",
  V: "financials",
  MA: "financials",
  PYPL: "financials",
  XLF: "financials",
  KRE: "financials",
  UNH: "healthcare",
  JNJ: "healthcare",
  LLY: "healthcare",
  PFE: "healthcare",
  MRK: "healthcare",
  ABBV: "healthcare",
  TMO: "healthcare",
  XLV: "healthcare",
  IBB: "healthcare",
  XOM: "energy",
  CVX: "energy",
  COP: "energy",
  SLB: "energy",
  XLE: "energy",
  CAT: "industrials",
  BA: "industrials",
  GE: "industrials",
  HON: "industrials",
  UPS: "industrials",
  RTX: "industrials",
  XLI: "industrials",
  LIN: "materials",
  APD: "materials",
  FCX: "materials",
  NEM: "materials",
  XLB: "materials",
  NEE: "utilities",
  DUK: "utilities",
  SO: "utilities",
  XLU: "utilities",
  PLD: "real_estate",
  AMT: "real_estate",
  O: "real_estate",
  VNQ: "real_estate",
  XLRE: "real_estate",
  SPY: "broad_market",
  VOO: "broad_market",
  IVV: "broad_market",
  QQQ: "broad_market",
  QQQM: "broad_market",
  IWM: "broad_market",
  DIA: "broad_market",
  VTI: "broad_market",
};

export interface EntryQualityGateResult {
  allowed: boolean;
  reason?: string;
  quality?: ResearchResult["entry_quality"];
  redFlags?: number;
  catalysts?: number;
  sourceCount?: number;
  minSingleSourceConfidence?: number;
  minSignalConsensus?: number;
  averageSentiment?: number;
  bullishSignals?: number;
  bearishSignals?: number;
  ageMinutes?: number;
}

export interface PortfolioBucketResult {
  blocked: boolean;
  bucket: string;
  count: number;
  max: number;
}

export interface EntryPerformanceBlock {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  updatedAt: string;
}

export interface EntryFeaturePerformanceBlock {
  feature: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  updatedAt: string;
}

export interface MarketRegimeEntryGateResult {
  allowed: boolean;
  reason?: string;
  averageSentiment?: number;
  threshold?: number;
  requiredConfidence?: number;
  confidence?: number;
  quality?: ResearchResult["entry_quality"];
}

export interface UnresearchedRecommendationBuyGateResult extends MarketRegimeEntryGateResult {
  sourceCount?: number;
  minSources?: number;
  minSignalConsensus?: number;
  averageSentiment?: number;
  bullishSignals?: number;
  bearishSignals?: number;
}

export interface EntrySignalConsensus {
  totalSignals: number;
  bullishSignals: number;
  bearishSignals: number;
  averageSentiment: number | null;
  sourceCount: number;
  sourceDetailCount: number;
}

export interface EntryTimingBypassResult {
  allowed: boolean;
  reason?: string;
  confidence?: number;
  requiredConfidence?: number;
  quality?: ResearchResult["entry_quality"];
  consensusState?: string;
  bullishSignals?: number;
  bearishSignals?: number;
  averageSentiment?: number | null;
}

export function inferPortfolioBucket(symbol: string, cryptoSymbols: string[] = []): string {
  const normalized = normalizeCryptoSymbol(symbol);
  if (normalized.includes("/") || cryptoSymbols.map((s) => normalizeCryptoSymbol(s)).includes(normalized)) {
    return "crypto";
  }

  const raw = symbol
    .trim()
    .toUpperCase()
    .replace(/[^A-Z.]/g, "");
  if (!raw) return "unknown";
  return SYMBOL_PORTFOLIO_BUCKETS[raw] ?? `individual:${raw}`;
}

export function evaluatePortfolioBucket(
  ctx: StrategyContext,
  symbol: string,
  positions: Position[],
  pendingSymbols: string[] = []
): PortfolioBucketResult {
  const max = ctx.config.max_positions_per_sector ?? 2;
  const bucket = inferPortfolioBucket(symbol, ctx.config.crypto_symbols || []);
  if (!(ctx.config.portfolio_risk_enabled ?? true) || max <= 0) {
    return { blocked: false, bucket, count: 0, max };
  }

  const targetSymbol = normalizeCryptoSymbol(symbol);
  const openSymbols = positions
    .map((position) => position.symbol)
    .filter((positionSymbol) => normalizeCryptoSymbol(positionSymbol) !== targetSymbol);
  const count = [...openSymbols, ...pendingSymbols].filter(
    (positionSymbol) => inferPortfolioBucket(positionSymbol, ctx.config.crypto_symbols || []) === bucket
  ).length;

  return {
    blocked: count >= max,
    bucket,
    count,
    max,
  };
}

export function getRecentSellCooldown(
  ctx: StrategyContext,
  symbol: string,
  now = Date.now()
): { blocked: boolean; symbolKey: string; remainingMinutes: number; soldAt?: number; reason?: string } {
  const symbolKey = normalizeCryptoSymbol(symbol);
  const baseCooldownHours = ctx.config.recent_sell_cooldown_hours ?? 0;
  const defensiveCooldownHours = ctx.config.defensive_sell_cooldown_hours ?? baseCooldownHours;
  const getCooldownHours = (reason?: string) => {
    const normalizedReason = (reason ?? "").toLowerCase();
    const defensive =
      normalizedReason.includes("stop loss") ||
      normalizedReason.includes("bad fill") ||
      normalizedReason.includes("timed loss") ||
      normalizedReason.includes("sentiment reversal loss") ||
      normalizedReason.includes("stale") ||
      normalizedReason.includes("loss exit");
    return defensive ? Math.max(baseCooldownHours, defensiveCooldownHours) : baseCooldownHours;
  };

  const recentSells = ctx.state.get<Record<string, RecentSellEntry>>("recentSells") ?? {};
  const rawKey = symbol.trim().toUpperCase();
  const parsedOption = parseOccOptionSymbol(symbol);
  const recentSellKeys = [
    symbolKey,
    rawKey,
    parsedOption?.underlying,
    parsedOption ? normalizeCryptoSymbol(parsedOption.underlying) : undefined,
  ].filter((key): key is string => !!key);
  const matchedKey = recentSellKeys.find((key) => recentSells[key]);
  const recentSell = matchedKey ? recentSells[matchedKey] : undefined;
  if (!recentSell) return { blocked: false, symbolKey, remainingMinutes: 0 };

  const cooldownHours = getCooldownHours(recentSell.reason);
  if (cooldownHours <= 0) return { blocked: false, symbolKey, remainingMinutes: 0 };

  const remainingMs = recentSell.sold_at + cooldownHours * MS_PER_HOUR - now;
  if (remainingMs <= 0) return { blocked: false, symbolKey, remainingMinutes: 0 };

  return {
    blocked: true,
    symbolKey,
    remainingMinutes: Math.ceil(remainingMs / (60 * 1000)),
    soldAt: recentSell.sold_at,
    reason: recentSell.reason,
  };
}

export function getEntryPerformanceBlock(ctx: StrategyContext, symbol: string): EntryPerformanceBlock | null {
  if (!(ctx.config.adaptive_performance_block_enabled ?? true)) return null;

  const blocks = ctx.state.get<Record<string, EntryPerformanceBlock>>("entryPerformanceBlocks") ?? {};
  const symbolKey = normalizeCryptoSymbol(symbol);
  const rawKey = symbol.trim().toUpperCase();
  return blocks[symbolKey] ?? blocks[rawKey] ?? null;
}

function confidenceBucketFromValue(confidence: unknown): string | null {
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 0.9) return "0.90+";
  if (numeric >= 0.8) return "0.80-0.89";
  if (numeric >= 0.7) return "0.70-0.79";
  if (numeric >= 0.6) return "0.60-0.69";
  return "<0.60";
}

function researchAgeBucketFromValue(ageMinutes: unknown): string | null {
  const numeric = Number(ageMinutes);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 10) return "<=10m";
  if (numeric <= 30) return "10-30m";
  if (numeric <= 60) return "30-60m";
  return ">60m";
}

function entrySelectionScoreBucketFromValue(score: unknown): string | null {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 1.15) return "1.15+";
  if (numeric >= 1.05) return "1.05-1.14";
  if (numeric >= 0.95) return "0.95-1.04";
  if (numeric >= 0.85) return "0.85-0.94";
  return "<0.85";
}

function entryPriceChangeBucketFromValue(changePct: unknown): string | null {
  const numeric = Number(changePct);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0) return "<=0%";
  if (numeric <= 2) return "0%..2%";
  if (numeric <= 5) return "2%..5%";
  return "5%+";
}

function entrySpreadBucketFromValue(spreadPct: unknown): string | null {
  const numeric = Number(spreadPct);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0.25) return "<=0.25%";
  if (numeric <= 0.8) return "0.25%..0.80%";
  if (numeric <= 2) return "0.80%..2%";
  return "2%+";
}

function getEtTimeParts(date: Date): { hour: number; minute: number; weekday: string } | null {
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

export function getEntrySessionMetadata(now = Date.now()): Record<string, unknown> {
  const date = new Date(now);
  const parts = getEtTimeParts(date);
  if (!parts) {
    return {
      entry_timestamp: date.toISOString(),
      entry_session: "unknown",
      entry_weekday: "unknown",
    };
  }

  const minutes = parts.hour * 60 + parts.minute;
  const entrySession =
    minutes < 9 * 60 + 30
      ? "premarket"
      : minutes < 10 * 60
        ? "open_30m"
        : minutes < 12 * 60
          ? "morning"
          : minutes < 14 * 60
            ? "midday"
            : minutes < 15 * 60 + 30
              ? "afternoon"
              : minutes < 16 * 60
                ? "close_30m"
                : "after_hours";

  return {
    entry_timestamp: date.toISOString(),
    entry_session: entrySession,
    entry_weekday: parts.weekday,
    entry_hour_et: parts.hour,
    entry_minute_et: parts.minute,
  };
}

export function getEntryFeatureKeysFromMetadata(metadata?: Record<string, unknown>): string[] {
  if (!metadata) return [];

  const keys: string[] = [];
  const entryPath = typeof metadata.entry_path === "string" ? metadata.entry_path.trim() : "";
  if (entryPath) keys.push("entry_path:" + entryPath);

  const portfolioBucket = typeof metadata.portfolio_bucket === "string" ? metadata.portfolio_bucket.trim() : "";
  if (portfolioBucket) keys.push("portfolio_bucket:" + portfolioBucket);

  const confidenceBucket = confidenceBucketFromValue(metadata.confidence ?? metadata.research_confidence);
  if (confidenceBucket) keys.push("confidence:" + confidenceBucket);

  const entryQuality = typeof metadata.entry_quality === "string" ? metadata.entry_quality.trim().toLowerCase() : "";
  if (entryQuality) keys.push("entry_quality:" + entryQuality);

  const redFlagCount = Number(metadata.red_flag_count);
  if (Number.isFinite(redFlagCount)) keys.push("red_flags:" + Math.max(0, Math.floor(redFlagCount)));

  const catalystCount = Number(metadata.catalyst_count);
  if (Number.isFinite(catalystCount)) keys.push("catalysts:" + Math.max(0, Math.floor(catalystCount)));

  const sourceCount = Number(metadata.source_count ?? metadata.signal_sources);
  if (Number.isFinite(sourceCount)) keys.push("source_count:" + Math.max(0, Math.floor(sourceCount)));

  const consensusState =
    typeof metadata.signal_consensus_state === "string" ? metadata.signal_consensus_state.trim() : "";
  if (consensusState) keys.push("signal_consensus:" + consensusState);

  const ageBucket = researchAgeBucketFromValue(metadata.research_age_minutes);
  if (ageBucket) keys.push("research_age:" + ageBucket);

  const entrySelectionScoreBucket = entrySelectionScoreBucketFromValue(metadata.entry_selection_score);
  if (entrySelectionScoreBucket) keys.push("entry_selection_score:" + entrySelectionScoreBucket);

  const entryPriceChangeBucket = entryPriceChangeBucketFromValue(metadata.entry_price_change_pct);
  if (entryPriceChangeBucket) keys.push("entry_price_change:" + entryPriceChangeBucket);

  const entrySpreadBucket = entrySpreadBucketFromValue(
    metadata.entry_spread_pct ?? metadata.quote_spread_pct ?? metadata.bid_ask_spread_pct
  );
  if (entrySpreadBucket) keys.push("entry_spread:" + entrySpreadBucket);

  if (metadata.research_confirmed === false) {
    keys.push("research_confirmation:unconfirmed");
  } else if (metadata.research_confirmed === true) {
    keys.push("research_confirmation:confirmed");
  }

  const entrySession = typeof metadata.entry_session === "string" ? metadata.entry_session.trim().toLowerCase() : "";
  if (entrySession) keys.push("entry_session:" + entrySession);

  const entryWeekday = typeof metadata.entry_weekday === "string" ? metadata.entry_weekday.trim() : "";
  if (entryWeekday) keys.push("entry_weekday:" + entryWeekday);

  if (metadata.market_regime_allowed === false) {
    keys.push("market_regime:blocked");
  } else if (
    metadata.market_regime_average_sentiment !== null &&
    metadata.market_regime_average_sentiment !== undefined
  ) {
    const averageSentiment = Number(metadata.market_regime_average_sentiment);
    const threshold = Number(metadata.market_regime_threshold ?? 0.5);
    if (Number.isFinite(averageSentiment) && Number.isFinite(threshold) && averageSentiment < threshold) {
      keys.push("market_regime:weak_exceptional");
    }
  }

  return [...new Set(keys)];
}

export function isAdaptiveBlockableEntryFeature(featureKey: string): boolean {
  if (featureKey === "entry_quality:excellent" || featureKey === "entry_quality:good") return false;
  if (featureKey.startsWith("entry_path:")) {
    const path = featureKey.slice("entry_path:".length);
    return path !== "strategy_select_entries" && path !== "unknown";
  }
  if (featureKey.startsWith("entry_weekday:")) return false;
  if (featureKey.startsWith("portfolio_bucket:")) {
    const bucket = featureKey.slice("portfolio_bucket:".length);
    return bucket !== "unknown" && !bucket.startsWith("individual:");
  }
  if (featureKey.startsWith("entry_session:")) {
    return featureKey === "entry_session:open_30m" || featureKey === "entry_session:close_30m";
  }
  if (featureKey.startsWith("entry_price_change:")) {
    return featureKey === "entry_price_change:2%..5%" || featureKey === "entry_price_change:5%+";
  }
  if (featureKey.startsWith("entry_spread:")) {
    return featureKey === "entry_spread:0.80%..2%" || featureKey === "entry_spread:2%+";
  }
  if (featureKey.startsWith("red_flags:")) {
    const count = Number(featureKey.slice("red_flags:".length));
    return Number.isFinite(count) && count > 0;
  }
  if (featureKey.startsWith("catalysts:")) {
    const count = Number(featureKey.slice("catalysts:".length));
    return Number.isFinite(count) && count === 0;
  }
  return true;
}

export function getEntryFeaturePerformanceBlock(
  ctx: StrategyContext,
  metadata?: Record<string, unknown>
): EntryFeaturePerformanceBlock | null {
  if (!(ctx.config.adaptive_performance_block_enabled ?? true)) return null;

  const blocks = ctx.state.get<Record<string, EntryFeaturePerformanceBlock>>("entryFeaturePerformanceBlocks") ?? {};
  const featureKeys = getEntryFeatureKeysFromMetadata(metadata);
  for (const featureKey of featureKeys) {
    if (!isAdaptiveBlockableEntryFeature(featureKey)) continue;
    const block = blocks[featureKey];
    if (block) return block;
  }
  return null;
}

export function findEntryResearch(research: ResearchResult[], symbol: string): ResearchResult | undefined {
  const symbolKey = normalizeCryptoSymbol(symbol);
  const rawKey = symbol.trim().toUpperCase();
  return research.find(
    (r) => r.symbol === symbol || normalizeCryptoSymbol(r.symbol) === symbolKey || r.symbol.toUpperCase() === rawKey
  );
}

function getMaxEntrySignalAgeMinutes(ctx: StrategyContext): number {
  return ctx.config.max_entry_research_age_minutes ?? 30;
}

function isFreshEntrySignal(ctx: StrategyContext, timestamp: number, now = Date.now()): boolean {
  const maxAgeMinutes = getMaxEntrySignalAgeMinutes(ctx);
  if (maxAgeMinutes <= 0) return true;

  const ageMs = now - timestamp;
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;

  return ageMs <= maxAgeMinutes * 60 * 1000;
}

function hasBroadMarketSignal(symbol: string): boolean {
  return inferPortfolioBucket(symbol) === "broad_market";
}

function getMarketRegimeSentiments(ctx: StrategyContext): number[] {
  const minRawSentiment = ctx.config.min_sentiment_score ?? 0;
  const regimeSignals = ctx.signals
    .filter((signal) => isFreshEntrySignal(ctx, signal.timestamp))
    .map((signal) => ({ signal, sentiment: getSignedSignalSentiment(signal) }))
    .filter(
      (entry): entry is { signal: typeof entry.signal; sentiment: number } =>
        entry.sentiment !== null && Number.isFinite(entry.sentiment) && Math.abs(entry.sentiment) >= minRawSentiment
    );

  const symbols = new Set(regimeSignals.map(({ signal }) => normalizeCryptoSymbol(signal.symbol)));
  const hasBroadMarket = regimeSignals.some(({ signal }) => hasBroadMarketSignal(signal.symbol));
  if (!hasBroadMarket && symbols.size < MIN_MARKET_REGIME_SYMBOLS) return [];

  return regimeSignals.map((entry) => entry.sentiment);
}

export function getEntrySignalSourceCount(ctx: StrategyContext, symbol: string): number {
  return getEntrySignalConsensus(ctx, symbol).sourceCount;
}

export function getEntrySignalConsensus(ctx: StrategyContext, symbol: string): EntrySignalConsensus {
  const symbolKey = normalizeCryptoSymbol(symbol);
  const minSentiment = ctx.config.min_sentiment_score ?? 0;
  const signals = ctx.signals
    .filter((s) => s.symbol === symbol || normalizeCryptoSymbol(s.symbol) === symbolKey)
    .filter((s) => isFreshEntrySignal(ctx, s.timestamp))
    .filter((s) => getSignedSignalSentiment(s) !== null);

  const confirmingSignals = signals.filter((s) => {
    const sentiment = getSignedSignalSentiment(s);
    return sentiment !== null && sentiment >= minSentiment;
  });
  const signalSources = new Set(confirmingSignals.map((s) => s.source).filter(Boolean));
  const signalSourceDetails = new Set(
    confirmingSignals.map((s) => `${s.source || "unknown"}:${s.source_detail || s.source || "unknown"}`).filter(Boolean)
  );

  const averageSentiment =
    signals.length > 0
      ? signals.reduce((sum, signal) => sum + (getSignedSignalSentiment(signal) ?? 0), 0) / signals.length
      : null;

  return {
    totalSignals: signals.length,
    bullishSignals: signals.filter((signal) => (getSignedSignalSentiment(signal) ?? 0) > 0).length,
    bearishSignals: signals.filter((signal) => (getSignedSignalSentiment(signal) ?? 0) < 0).length,
    averageSentiment: averageSentiment === null ? null : Number(averageSentiment.toFixed(4)),
    sourceCount: signalSources.size,
    sourceDetailCount: signalSourceDetails.size,
  };
}

function hasWeakSymbolConsensus(ctx: StrategyContext, consensus: EntrySignalConsensus): boolean {
  if (consensus.totalSignals < 2 || consensus.averageSentiment === null) return false;
  const minSentiment = ctx.config.min_sentiment_score ?? 0;
  return consensus.averageSentiment < minSentiment && consensus.bearishSignals >= consensus.bullishSignals;
}

function isBelowMinEntrySignalConsensus(ctx: StrategyContext, consensus: EntrySignalConsensus): boolean {
  const minConsensus = ctx.config.min_entry_signal_consensus ?? 0.15;
  if (minConsensus <= 0 || consensus.averageSentiment === null) return false;
  return consensus.averageSentiment < minConsensus;
}

export function getSignalConsensusState(ctx: StrategyContext, consensus: EntrySignalConsensus): string {
  if (consensus.totalSignals === 0 || consensus.averageSentiment === null) return "unknown";
  if (hasWeakSymbolConsensus(ctx, consensus)) return "weak_mixed";
  if (consensus.bearishSignals > 0 && consensus.bullishSignals > consensus.bearishSignals) return "mixed_positive";
  if (consensus.bearishSignals > 0) return "mixed";
  if (consensus.bullishSignals > 0) return "aligned";
  return "neutral";
}

export function getEntrySelectionScore(ctx: StrategyContext, research: ResearchResult, now = Date.now()): number {
  const confidence = Number.isFinite(research.confidence) ? research.confidence : 0;
  const qualityRank = ENTRY_QUALITY_RANK[research.entry_quality] ?? 0;
  const catalysts = (research.catalysts ?? []).filter((catalyst) => catalyst.trim().length > 0).length;
  const redFlags = (research.red_flags ?? []).filter((flag) => flag.trim().length > 0).length;
  const consensus = getEntrySignalConsensus(ctx, research.symbol);
  const consensusState = getSignalConsensusState(ctx, consensus);
  const ageMs = now - research.timestamp;
  const ageMinutes = Number.isFinite(ageMs) ? Math.max(0, ageMs / (60 * 1000)) : getMaxEntrySignalAgeMinutes(ctx);
  const maxAgeMinutes = Math.max(1, getMaxEntrySignalAgeMinutes(ctx));
  const agePenalty = Math.min(0.05, (ageMinutes / maxAgeMinutes) * 0.05);
  const sentimentBonus =
    consensus.averageSentiment === null ? 0 : Math.max(-0.04, Math.min(0.04, consensus.averageSentiment * 0.04));

  return Number(
    (
      confidence +
      qualityRank * 0.04 +
      Math.min(catalysts, 3) * 0.015 +
      Math.min(consensus.sourceCount, 3) * 0.02 +
      (consensusState === "aligned" ? 0.03 : consensusState === "mixed_positive" ? 0.015 : 0) +
      sentimentBonus -
      redFlags * 0.05 -
      agePenalty
    ).toFixed(4)
  );
}

export function evaluateEntryResearch(ctx: StrategyContext, research: ResearchResult): EntryQualityGateResult {
  if (research.verdict !== "BUY") return { allowed: false, reason: `verdict_${research.verdict}` };
  if (research.confidence < ctx.config.min_analyst_confidence) {
    return { allowed: false, reason: "low_confidence" };
  }

  const maxAgeMinutes = ctx.config.max_entry_research_age_minutes ?? 30;
  if (maxAgeMinutes > 0) {
    const ageMs = Date.now() - research.timestamp;
    const ageMinutes = Number.isFinite(ageMs) ? ageMs / (60 * 1000) : Number.POSITIVE_INFINITY;
    if (ageMinutes > maxAgeMinutes) {
      return { allowed: false, reason: "stale_research", ageMinutes: Math.round(ageMinutes) };
    }
  }

  const minQuality = ctx.config.min_entry_quality ?? "good";
  const qualityRank = ENTRY_QUALITY_RANK[research.entry_quality] ?? -1;
  const minQualityRank = ENTRY_QUALITY_RANK[minQuality] ?? ENTRY_QUALITY_RANK.good;
  if (qualityRank < minQualityRank) {
    return { allowed: false, reason: "low_entry_quality", quality: research.entry_quality };
  }

  const redFlags = (research.red_flags ?? []).filter((flag) => flag.trim().length > 0).length;
  const maxRedFlags = ctx.config.max_entry_red_flags ?? 0;
  if (redFlags > maxRedFlags) {
    return { allowed: false, reason: "too_many_red_flags", redFlags };
  }

  const catalysts = (research.catalysts ?? []).filter((catalyst) => catalyst.trim().length > 0).length;
  const minCatalysts = ctx.config.min_entry_catalysts ?? 1;
  if (catalysts < minCatalysts) {
    return { allowed: false, reason: "insufficient_catalysts", catalysts };
  }

  const consensus = getEntrySignalConsensus(ctx, research.symbol);
  const sourceCount = consensus.sourceCount;
  const minSources = ctx.config.min_entry_signal_sources ?? 1;
  if (sourceCount < minSources) {
    return { allowed: false, reason: "insufficient_signal_sources", sourceCount };
  }
  const minSingleSourceConfidence = ctx.config.single_source_entry_min_confidence ?? 0.82;
  if (sourceCount === 1 && minSources <= 1 && research.confidence < minSingleSourceConfidence) {
    return {
      allowed: false,
      reason: "single_source_low_confidence",
      sourceCount,
      minSingleSourceConfidence,
    };
  }
  if (hasWeakSymbolConsensus(ctx, consensus)) {
    return {
      allowed: false,
      reason: "weak_signal_consensus",
      sourceCount,
      averageSentiment: consensus.averageSentiment ?? undefined,
      bullishSignals: consensus.bullishSignals,
      bearishSignals: consensus.bearishSignals,
    };
  }
  if (isBelowMinEntrySignalConsensus(ctx, consensus)) {
    return {
      allowed: false,
      reason: "low_signal_consensus",
      sourceCount,
      minSignalConsensus: ctx.config.min_entry_signal_consensus ?? 0.15,
      averageSentiment: consensus.averageSentiment ?? undefined,
      bullishSignals: consensus.bullishSignals,
      bearishSignals: consensus.bearishSignals,
    };
  }

  return { allowed: true, quality: research.entry_quality, redFlags, catalysts, sourceCount };
}

export function getConvictionSizeMultiplier(ctx: StrategyContext, confidence: number): number {
  if (!(ctx.config.llm_size_conviction_scaling ?? true)) return 1;
  if (confidence < 0.65) return ctx.config.llm_size_low_confidence_multiplier ?? 0.4;
  if (confidence < 0.75) return ctx.config.llm_size_medium_confidence_multiplier ?? 0.7;
  return 1;
}

export function getMarketRegimeSizeMultiplier(ctx: StrategyContext): number {
  if (!(ctx.config.market_regime_enabled ?? true)) return 1;

  const sentiments = getMarketRegimeSentiments(ctx);
  if (sentiments.length === 0) return 1;

  const averageSentiment = sentiments.reduce((sum, sentiment) => sum + sentiment, 0) / sentiments.length;
  const lowRegimeThreshold = ctx.config.regime_low_threshold ?? 0.5;
  if (averageSentiment >= lowRegimeThreshold) return 1;

  return ctx.config.regime_position_size_reduction ?? 0.45;
}

export function evaluateMarketRegimeEntry(
  ctx: StrategyContext,
  confidence: number,
  quality?: ResearchResult["entry_quality"]
): MarketRegimeEntryGateResult {
  if (!(ctx.config.market_regime_enabled ?? true)) return { allowed: true };

  const sentiments = getMarketRegimeSentiments(ctx);
  if (sentiments.length === 0) return { allowed: true };

  const averageSentiment = sentiments.reduce((sum, sentiment) => sum + sentiment, 0) / sentiments.length;
  const threshold = ctx.config.regime_low_threshold ?? 0.5;
  if (averageSentiment >= threshold) return { allowed: true, averageSentiment, threshold };

  const requiredConfidence = ctx.config.exceptional_entry_confidence ?? 0.9;
  const exceptional = confidence >= requiredConfidence && (!quality || quality === "excellent");
  if (exceptional) {
    return { allowed: true, averageSentiment, threshold, requiredConfidence, confidence, quality };
  }

  return {
    allowed: false,
    reason: "weak_market_regime",
    averageSentiment: Number(averageSentiment.toFixed(4)),
    threshold,
    requiredConfidence,
    confidence,
    quality,
  };
}

export function evaluateEntryTimingBypass(
  ctx: StrategyContext,
  symbol: string,
  confidence: number,
  quality?: ResearchResult["entry_quality"]
): EntryTimingBypassResult {
  const requiredConfidence = ctx.config.exceptional_entry_confidence ?? 0.9;
  const consensus = getEntrySignalConsensus(ctx, symbol);
  const consensusState = getSignalConsensusState(ctx, consensus);
  const sentimentAligned =
    consensusState === "aligned" ||
    consensusState === "mixed_positive" ||
    (consensus.averageSentiment !== null &&
      consensus.averageSentiment >= (ctx.config.regime_low_threshold ?? ctx.config.min_sentiment_score ?? 0.3) &&
      consensus.bullishSignals > consensus.bearishSignals);

  if (confidence >= requiredConfidence && quality === "excellent" && sentimentAligned) {
    return {
      allowed: true,
      reason: "exceptional_research_with_aligned_signals",
      confidence,
      requiredConfidence,
      quality,
      consensusState,
      bullishSignals: consensus.bullishSignals,
      bearishSignals: consensus.bearishSignals,
      averageSentiment: consensus.averageSentiment,
    };
  }

  return {
    allowed: false,
    confidence,
    requiredConfidence,
    quality,
    consensusState,
    bullishSignals: consensus.bullishSignals,
    bearishSignals: consensus.bearishSignals,
    averageSentiment: consensus.averageSentiment,
  };
}

export function evaluateUnresearchedRecommendationBuy(
  ctx: StrategyContext,
  symbol: string,
  confidence: number
): UnresearchedRecommendationBuyGateResult {
  const consensus = getEntrySignalConsensus(ctx, symbol);
  const sourceCount = consensus.sourceCount;
  const minSources = ctx.config.min_entry_signal_sources ?? 1;
  if (sourceCount < minSources) {
    return {
      allowed: false,
      reason: "insufficient_signal_sources",
      sourceCount,
      minSources,
      confidence,
    };
  }
  if (hasWeakSymbolConsensus(ctx, consensus)) {
    return {
      allowed: false,
      reason: "weak_signal_consensus",
      sourceCount,
      minSources,
      confidence,
      averageSentiment: consensus.averageSentiment ?? undefined,
      bullishSignals: consensus.bullishSignals,
      bearishSignals: consensus.bearishSignals,
    };
  }
  if (isBelowMinEntrySignalConsensus(ctx, consensus)) {
    return {
      allowed: false,
      reason: "low_signal_consensus",
      sourceCount,
      minSources,
      confidence,
      minSignalConsensus: ctx.config.min_entry_signal_consensus ?? 0.15,
      averageSentiment: consensus.averageSentiment ?? undefined,
      bullishSignals: consensus.bullishSignals,
      bearishSignals: consensus.bearishSignals,
    };
  }
  const minSingleSourceConfidence = ctx.config.single_source_entry_min_confidence ?? 0.82;
  if (sourceCount === 1 && minSources <= 1 && confidence < minSingleSourceConfidence) {
    return {
      allowed: false,
      reason: "single_source_low_confidence",
      sourceCount,
      minSources,
      confidence,
      requiredConfidence: minSingleSourceConfidence,
    };
  }

  return evaluateMarketRegimeEntry(ctx, confidence);
}

export function buildEntryReviewMetadata(
  ctx: StrategyContext,
  research: ResearchResult,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const ageMs = Date.now() - research.timestamp;
  const redFlags = (research.red_flags ?? []).filter((flag) => flag.trim().length > 0);
  const catalysts = (research.catalysts ?? []).filter((catalyst) => catalyst.trim().length > 0);
  const consensus = getEntrySignalConsensus(ctx, research.symbol);
  const sourceCount = consensus.sourceCount;
  const regimeGate = evaluateMarketRegimeEntry(ctx, research.confidence, research.entry_quality);

  return {
    confidence: research.confidence,
    research_confidence: research.confidence,
    research_confirmed: true,
    portfolio_bucket: inferPortfolioBucket(research.symbol, ctx.config.crypto_symbols || []),
    entry_quality: research.entry_quality,
    verdict: research.verdict,
    red_flags: redFlags,
    red_flag_count: redFlags.length,
    catalysts,
    catalyst_count: catalysts.length,
    source_count: sourceCount,
    signal_sources: sourceCount,
    signal_source_details: consensus.sourceDetailCount,
    signal_consensus_average: consensus.averageSentiment,
    signal_consensus_bullish: consensus.bullishSignals,
    signal_consensus_bearish: consensus.bearishSignals,
    signal_consensus_state: getSignalConsensusState(ctx, consensus),
    research_age_minutes: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / (60 * 1000))) : null,
    market_regime_allowed: regimeGate.allowed,
    market_regime_average_sentiment: regimeGate.averageSentiment ?? null,
    market_regime_threshold: regimeGate.threshold ?? null,
    ...getEntrySessionMetadata(),
    ...extra,
  };
}

export function getEntrySizeMultiplier(ctx: StrategyContext, confidence: number): number {
  return getConvictionSizeMultiplier(ctx, confidence) * getMarketRegimeSizeMultiplier(ctx);
}

/**
 * Select entry candidates from LLM-researched signals.
 *
 * Filters for BUY verdicts above min confidence threshold,
 * skips already-held symbols, applies entry-quality gates, and ranks by conviction plus setup quality.
 */
export function selectEntries(
  ctx: StrategyContext,
  research: ResearchResult[],
  positions: Position[],
  account: Account
): BuyCandidate[] {
  const heldSymbols = new Set(positions.flatMap((p) => [p.symbol, normalizeCryptoSymbol(p.symbol)]));
  const now = Date.now();
  const candidates: BuyCandidate[] = [];
  const verdictCounts = research.reduce<Record<string, number>>((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] || 0) + 1;
    return acc;
  }, {});

  if (positions.length >= ctx.config.max_positions) {
    ctx.log("Entries", "skipped_max_positions", { max_positions: ctx.config.max_positions });
    return [];
  }

  const buyResearch = research
    .filter((r) => !heldSymbols.has(r.symbol) && !heldSymbols.has(normalizeCryptoSymbol(r.symbol)))
    .sort((a, b) => {
      const scoreDiff = getEntrySelectionScore(ctx, b, now) - getEntrySelectionScore(ctx, a, now);
      if (scoreDiff !== 0) return scoreDiff;
      return b.confidence - a.confidence;
    });

  const candidateLimit = ctx.config.entry_candidate_limit ?? 3;
  for (const r of buyResearch) {
    if (candidates.length >= candidateLimit) break;

    const qualityGate = evaluateEntryResearch(ctx, r);
    if (!qualityGate.allowed) {
      ctx.log("System", "entry_skipped_quality_gate", {
        symbol: r.symbol,
        reason: qualityGate.reason,
        confidence: r.confidence,
        quality: qualityGate.quality ?? r.entry_quality,
        red_flags: qualityGate.redFlags ?? r.red_flags?.length ?? 0,
        catalysts: qualityGate.catalysts ?? r.catalysts?.length ?? 0,
        source_count: qualityGate.sourceCount,
        min_single_source_confidence: qualityGate.minSingleSourceConfidence,
        min_signal_consensus: qualityGate.minSignalConsensus,
        average_sentiment: qualityGate.averageSentiment,
        bullish_signals: qualityGate.bullishSignals,
        bearish_signals: qualityGate.bearishSignals,
        age_minutes: qualityGate.ageMinutes,
      });
      continue;
    }

    const performanceBlock = getEntryPerformanceBlock(ctx, r.symbol);
    if (performanceBlock) {
      ctx.log("System", "entry_skipped_poor_recent_performance", {
        symbol: r.symbol,
        trades: performanceBlock.trades,
        wins: performanceBlock.wins,
        losses: performanceBlock.losses,
        win_rate: performanceBlock.winRate,
        total_pnl_usd: performanceBlock.totalPnlUsd,
      });
      continue;
    }

    const regimeGate = evaluateMarketRegimeEntry(ctx, r.confidence, r.entry_quality);
    if (!regimeGate.allowed) {
      ctx.log("System", "entry_skipped_market_regime", {
        symbol: r.symbol,
        reason: regimeGate.reason,
        average_sentiment: regimeGate.averageSentiment,
        threshold: regimeGate.threshold,
        confidence: regimeGate.confidence,
        required_confidence: regimeGate.requiredConfidence,
        quality: regimeGate.quality,
      });
      continue;
    }

    const portfolioBucket = evaluatePortfolioBucket(
      ctx,
      r.symbol,
      positions,
      candidates.map((candidate) => candidate.symbol)
    );
    if (portfolioBucket.blocked) {
      ctx.log("System", "entry_skipped_portfolio_bucket", {
        symbol: r.symbol,
        bucket: portfolioBucket.bucket,
        current_count: portfolioBucket.count,
        max_count: portfolioBucket.max,
      });
      continue;
    }

    const cooldown = getRecentSellCooldown(ctx, r.symbol, now);
    if (cooldown.blocked) {
      ctx.log("System", "entry_skipped_recent_sell_cooldown", {
        symbol: r.symbol,
        symbol_key: cooldown.symbolKey,
        remaining_minutes: cooldown.remainingMinutes,
        sell_reason: cooldown.reason,
      });
      continue;
    }

    if (positions.length + candidates.length >= ctx.config.max_positions) break;

    const sizePct = Math.min(20, ctx.config.position_size_pct_of_cash);
    const sizeMultiplier = getEntrySizeMultiplier(ctx, r.confidence);
    const entrySelectionScore = getEntrySelectionScore(ctx, r, now);
    const minEntrySelectionScore = ctx.config.min_entry_selection_score ?? 0.85;
    if (minEntrySelectionScore > 0 && entrySelectionScore < minEntrySelectionScore) {
      ctx.log("System", "entry_skipped_low_selection_score", {
        symbol: r.symbol,
        entry_selection_score: entrySelectionScore,
        min_entry_selection_score: minEntrySelectionScore,
        confidence: r.confidence,
        quality: r.entry_quality,
      });
      continue;
    }
    const notional = Math.min(
      account.cash * (sizePct / 100) * r.confidence * sizeMultiplier,
      ctx.config.max_position_value
    );

    if (notional < 100) {
      ctx.log("System", "entry_skipped_notional_too_small", {
        symbol: r.symbol,
        confidence: r.confidence,
        notional,
        min_notional: 100,
        cash: account.cash,
        position_size_pct_of_cash: ctx.config.position_size_pct_of_cash,
        size_multiplier: sizeMultiplier,
        max_position_value: ctx.config.max_position_value,
      });
      continue;
    }

    const shouldUseOptions =
      ctx.config.options_enabled &&
      compositeScore >= ctx.config.options_min_confidence &&
      r.entry_quality === "excellent";

    const metadata = buildEntryReviewMetadata(ctx, r, {
      entry_path: "strategy_select_entries",
      entry_selection_score: entrySelectionScore,
      size_multiplier: sizeMultiplier,
      use_options: shouldUseOptions,
    });
    const featurePerformanceBlock = getEntryFeaturePerformanceBlock(ctx, metadata);
    if (featurePerformanceBlock) {
      ctx.log("System", "entry_skipped_poor_feature_performance", {
        symbol: r.symbol,
        feature: featurePerformanceBlock.feature,
        trades: featurePerformanceBlock.trades,
        wins: featurePerformanceBlock.wins,
        losses: featurePerformanceBlock.losses,
        win_rate: featurePerformanceBlock.winRate,
        total_pnl_usd: featurePerformanceBlock.totalPnlUsd,
      });
      continue;
    }

    candidates.push({
      symbol: r.symbol,
      confidence: compositeScore,
      reason: r.verdict === "WAIT" ? `Promoted WAIT: ${r.reasoning}` : r.reasoning,
      notional,
      metadata,
      useOptions: shouldUseOptions,
    });
  }

  return candidates;
}

/**
 * Build momentum data from signals for scoring.
 * Note: Signal type doesn't have metadata, so we use known optional fields.
 */
function buildMomentumData(
  signals: StrategyContext["signals"],
  ctx: StrategyContext
): Record<string, { priceChange1h?: number; priceChange24h?: number; volumeChange?: number }> {
  interface MomentumCacheEntry {
    price_change_1h?: number;
    price_change_24h?: number;
    volume_change?: number;
  }

  const cached = ctx.state.get<Record<string, MomentumCacheEntry>>("momentumDataCache") ?? {};
  const data: Record<string, { priceChange1h?: number; priceChange24h?: number; volumeChange?: number }> = {};

  for (const [symbol, momentum] of Object.entries(cached)) {
    data[symbol] = {
      priceChange1h: momentum.price_change_1h,
      priceChange24h: momentum.price_change_24h,
      volumeChange: momentum.volume_change,
    };
  }

  for (const signal of signals) {
    if (!data[signal.symbol] && signal.momentum !== undefined) {
      data[signal.symbol] = {
        priceChange24h: signal.momentum,
      };
    }
  }

  return data;
}

/**
 * Get market regime data from context.
 * In production, this would fetch VIX and SPY data.
 */
function getMarketRegimeData(ctx: StrategyContext): MarketRegimeData {
  // Try to get from state cache first
  const cachedRegime = ctx.state.get<MarketRegimeData>("marketRegimeCache");
  if (cachedRegime) {
    return cachedRegime;
  }

  // Default values if not available
  return {
    vix: 20, // neutral VIX
    spyPrice: undefined,
    spySma20: undefined,
    spySma50: undefined,
  };
}

/**
 * Get technical data for a symbol.
 * In production, this would fetch real technical indicators.
 */
function getTechnicalData(_symbol: string, _ctx: StrategyContext): TechnicalData {
  interface TechnicalDataCacheEntry {
    current_price?: number;
    rsi?: number;
    bb_lower?: number;
    bb_middle?: number;
    sma_20?: number;
    sma_50?: number;
    atr?: number;
  }

  const techCache = _ctx.state.get<Record<string, TechnicalDataCacheEntry>>("technicalDataCache");
  const cached = techCache?.[_symbol];
  const signal = _ctx.signals.find((item) => item.symbol === _symbol);

  if (cached) {
    return {
      current_price: cached.current_price ?? signal?.price ?? 0,
      rsi: cached.rsi,
      bb_lower: cached.bb_lower,
      bb_middle: cached.bb_middle,
      sma_20: cached.sma_20,
      sma_50: cached.sma_50,
      atr: cached.atr,
    };
  }

  return {
    current_price: signal?.price ?? 0,
  };
}

/**
 * Get sector mapping for symbols.
 * In production, this would be from a fundamental data provider.
 */
function getSectorMap(_ctx: StrategyContext): Record<string, string> {
  return _ctx.state.get<Record<string, string>>("sectorMap") ?? {};
}

function isPromotableWait(result: ResearchResult, _ctx: StrategyContext): boolean {
  if (result.verdict !== "WAIT") return false;
  return false;
}

function getRequiredEntryScore(result: ResearchResult, ctx: StrategyContext): number {
  if (isPromotableWait(result, ctx)) {
    return Math.max(0.55, ctx.config.min_analyst_confidence - 0.05);
  }
  return ctx.config.min_analyst_confidence;
}
