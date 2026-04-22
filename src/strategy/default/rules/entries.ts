/**
 * Entry rules — decide which signals to buy.
 *
 * Core handles PolicyEngine checks and actual order execution.
 * Core ALWAYS enforces stop-loss from config as a safety floor.
 */

import type { Account, Position, ResearchResult } from "../../../core/types";
import type { BuyCandidate, StrategyContext } from "../../types";
import { applyCompositeScoring, type ScoredSignal } from "./scoring";
import { checkEntryTiming, type TechnicalData } from "./entry-timing";
import { analyzeMarketRegime, type MarketRegimeData } from "./market-regime";
import { checkPortfolioRisk } from "./portfolio-risk";

/**
 * Select entry candidates from LLM-researched signals.
 *
 * Filters for BUY verdicts above min confidence threshold,
 * skips already-held symbols, and ranks by composite score.
 */
export function selectEntries(
  ctx: StrategyContext,
  research: ResearchResult[],
  positions: Position[],
  account: Account
): BuyCandidate[] {
  const heldSymbols = new Set(positions.map((p) => p.symbol));
  const candidates: BuyCandidate[] = [];
  const verdictCounts = research.reduce<Record<string, number>>((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] || 0) + 1;
    return acc;
  }, {});

  if (positions.length >= ctx.config.max_positions) {
    ctx.log("Entries", "skipped_max_positions", { max_positions: ctx.config.max_positions });
    return [];
  }

  const buyResearch = research.filter((r) => r.verdict === "BUY");
  const promotableWaits = research.filter((r) => isPromotableWait(r, ctx));
  const entryResearch = [...buyResearch, ...promotableWaits];

  // Build composite score map if scoring enabled
  let compositeScoreMap: Record<string, number> = {};
  let scoredSignals: ScoredSignal[] = [];

  if (ctx.config.scoring_enabled) {
    const momentumData = buildMomentumData(ctx.signals, ctx);
    scoredSignals = applyCompositeScoring(
      entryResearch,
      ctx.signals,
      momentumData,
      {
        sentiment: ctx.config.scoring_sentiment_weight,
        technical: ctx.config.scoring_technical_weight,
        catalyst: ctx.config.scoring_catalyst_weight,
        momentum: ctx.config.scoring_momentum_weight,
      }
    );

    // Build score map for quick lookup
    for (const s of scoredSignals) {
      compositeScoreMap[s.symbol] = s.compositeScore;
    }

    ctx.log("Entries", "scoring_applied", {
      original_count: entryResearch.length,
      scored_count: scoredSignals.length,
    });
  }

  // Filter and sort by composite score (or original confidence if scoring disabled)
  const aboveConfidence = entryResearch.filter((r) => {
    const score = compositeScoreMap[r.symbol] ?? r.confidence;
    return score >= getRequiredEntryScore(r, ctx);
  });

  const notHeld = aboveConfidence.filter((r) => !heldSymbols.has(r.symbol));
  const sorted = notHeld.sort((a, b) => {
    const scoreA = compositeScoreMap[a.symbol] ?? a.confidence;
    const scoreB = compositeScoreMap[b.symbol] ?? b.confidence;
    return scoreB - scoreA;
  });

  // Get market regime for position sizing
  const regimeData = getMarketRegimeData(ctx);
  const regimeResult = analyzeMarketRegime(regimeData, {
    market_regime_enabled: ctx.config.market_regime_enabled,
    regime_low_threshold: ctx.config.regime_low_threshold,
    regime_position_size_reduction: ctx.config.regime_position_size_reduction,
  });

  ctx.log("Entries", "selecting", {
    total_research: research.length,
    buy_verdicts: buyResearch.length,
    promotable_waits: promotableWaits.length,
    wait_verdicts: verdictCounts.WAIT ?? 0,
    skip_verdicts: verdictCounts.SKIP ?? 0,
    above_confidence_threshold: aboveConfidence.length,
    not_held: notHeld.length,
    min_confidence: ctx.config.min_analyst_confidence,
    market_regime: regimeResult.regime,
    regime_score: regimeResult.regimeScore.toFixed(2),
    position_size_mult: regimeResult.positionSizeMultiplier.toFixed(2),
  });

  if (buyResearch.length === 0 && (verdictCounts.WAIT ?? 0) > 0) {
    ctx.log("Entries", "no_buy_verdicts", {
      top_waits: research
        .filter((item) => item.verdict === "WAIT")
        .slice(0, 3)
        .map((item) => ({
          symbol: item.symbol,
          confidence: item.confidence,
          quality: item.entry_quality,
          promotable: isPromotableWait(item, ctx),
        })),
    });
  }

  // Get sector map for portfolio risk (in real impl, this would come from a data provider)
  const sectorMap = getSectorMap(ctx);

  const maxCandidates = Math.max(1, ctx.config.entry_candidate_limit ?? 3);

  for (const r of sorted.slice(0, maxCandidates)) {
    if (positions.length + candidates.length >= ctx.config.max_positions) break;

    // Check entry timing if enabled
    if (ctx.config.entry_timing_enabled) {
      const techData = getTechnicalData(r.symbol, ctx);
      const timingResult = checkEntryTiming(r.symbol, techData, {
        entry_timing_enabled: ctx.config.entry_timing_enabled,
        entry_rsi_min: ctx.config.entry_rsi_min,
        entry_rsi_max: ctx.config.entry_rsi_max,
        entry_bb_lower_threshold: ctx.config.entry_bb_lower_threshold,
      });

      if (!timingResult.passes) {
        ctx.log("Entries", "timing_filtered", { symbol: r.symbol, reason: timingResult.reason });
        continue;
      }

      if (timingResult.signals.length > 0) {
        ctx.log("Entries", "timing_signals", { symbol: r.symbol, signals: timingResult.signals });
      }
    }

    // Check portfolio risk (sector concentration)
    if (ctx.config.portfolio_risk_enabled) {
      const riskResult = checkPortfolioRisk(r.symbol, sectorMap, positions, {
        portfolio_risk_enabled: ctx.config.portfolio_risk_enabled,
        max_positions_per_sector: ctx.config.max_positions_per_sector,
      });

      if (!riskResult.allowed) {
        ctx.log("Entries", "sector_filtered", { symbol: r.symbol, reason: riskResult.reason });
        continue;
      }
    }

    // Calculate position size with regime adjustment
    const compositeScore = compositeScoreMap[r.symbol] ?? r.confidence;
    const sizePct = ctx.config.position_size_pct_of_cash;
    let notional = account.cash * (sizePct / 100) * compositeScore;

    // Apply market regime reduction
    notional *= regimeResult.positionSizeMultiplier;

    notional = Math.min(notional, ctx.config.max_position_value);

    if (notional < 100) {
      ctx.log("Entries", "skipped_too_small", { symbol: r.symbol, notional, min_notional: 100 });
      continue;
    }

    const shouldUseOptions =
      ctx.config.options_enabled &&
      compositeScore >= ctx.config.options_min_confidence &&
      r.entry_quality === "excellent";

    candidates.push({
      symbol: r.symbol,
      confidence: compositeScore,
      reason: r.verdict === "WAIT" ? `Promoted WAIT: ${r.reasoning}` : r.reasoning,
      notional,
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

function isPromotableWait(result: ResearchResult, ctx: StrategyContext): boolean {
  if (result.verdict !== "WAIT") return false;
  if (!["excellent", "good", "fair"].includes(result.entry_quality)) return false;
  if (result.red_flags.length > 1) return false;

  const minimumWaitConfidence = Math.max(0.55, ctx.config.min_analyst_confidence - 0.05);
  return result.confidence >= minimumWaitConfidence;
}

function getRequiredEntryScore(result: ResearchResult, ctx: StrategyContext): number {
  if (isPromotableWait(result, ctx)) {
    return Math.max(0.55, ctx.config.min_analyst_confidence - 0.05);
  }
  return ctx.config.min_analyst_confidence;
}
