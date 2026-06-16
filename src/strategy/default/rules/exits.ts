/**
 * Exit rules — decide which positions to sell.
 *
 * Core ALWAYS enforces stop-loss/take-profit on top of strategy exits.
 * This function handles: TP, SL, staleness, trailing stop, and options exits.
 */

import type { Account, Position, PositionEntry, Signal } from "../../../core/types";
import type { SellCandidate, StrategyContext } from "../../types";
import { normalizeCryptoSymbol } from "../helpers/crypto";
import { getSignedSignalSentiment } from "../helpers/sentiment";
import { analyzeStaleness } from "./staleness";

function getFreshSignalReversal(
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
  sourceDetailCount: number;
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
    sourceDetails.add(`${signal.source}:${signal.source_detail}`);
    sentimentSum += sentiment;
    signalCount += 1;
    if (sentiment > 0) bullishSignals += 1;
    if (sentiment < 0) bearishSignals += 1;
  }

  const averageSentiment = signalCount > 0 ? sentimentSum / signalCount : null;
  const sourceCount = sources.size;
  const sourceDetailCount = sourceDetails.size;
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
    sourceDetailCount,
  };
}

/**
 * Evaluate all positions and return sell candidates.
 * Core handles the actual order execution.
 */
export function selectExits(ctx: StrategyContext, positions: Position[], _account: Account): SellCandidate[] {
  const exits: SellCandidate[] = [];

  for (const pos of positions) {
    // Options are handled by the harness every tick to avoid duplicate sell attempts.
    if (pos.asset_class === "us_option") {
      continue;
    }

    const costBasis = pos.market_value - pos.unrealized_pl;
    const plPct = costBasis > 0 ? (pos.unrealized_pl / costBasis) * 100 : 0;
    const symbolKey = normalizeCryptoSymbol(pos.symbol);
    let entry = ctx.positionEntries[pos.symbol] ?? ctx.positionEntries[symbolKey];
    const entryPrice = entry?.entry_price && entry.entry_price > 0 ? entry.entry_price : pos.avg_entry_price;
    const currentPrice = pos.current_price;

    if (!entry && entryPrice > 0 && currentPrice > 0) {
      entry = {
        symbol: pos.symbol,
        entry_time: Date.now(),
        entry_price: entryPrice,
        entry_sentiment: 0,
        entry_social_volume: 0,
        entry_sources: ["broker_position_recovery"],
        entry_reason: "Recovered open position tracking from broker position",
        peak_price: Math.max(entryPrice, currentPrice),
        trough_price: Math.min(entryPrice, currentPrice),
        peak_sentiment: 0,
      } satisfies PositionEntry;
      ctx.positionEntries[pos.symbol] = entry;
      if (symbolKey !== pos.symbol) ctx.positionEntries[symbolKey] = entry;
    }

    if (entry && currentPrice > 0) {
      entry.peak_price = Math.max(entry.peak_price || 0, currentPrice);
      entry.trough_price = Math.min(entry.trough_price ?? entry.entry_price ?? currentPrice, currentPrice);
    }

    // Get or initialize trailing stop state
    const trailingStateKey = `trailingStop_${pos.symbol}`;
    let trailingState = ctx.state.get<TrailingStopState>(trailingStateKey);

    // Check advanced exits (trailing stop + dynamic TP)
    const atr = getATR(pos.symbol, ctx);
    const advancedResult = checkAdvancedExits(
      pos,
      entry,
      atr,
      {
        trailing_stop_enabled: ctx.config.trailing_stop_enabled,
        trailing_stop_pct: ctx.config.trailing_stop_pct,
        trailing_stop_activation_pct: ctx.config.trailing_stop_activation_pct,
        dynamic_tp_enabled: ctx.config.dynamic_tp_enabled,
        tp_atr_multiplier: ctx.config.tp_atr_multiplier,
        tp_min_pct: ctx.config.tp_min_pct,
        tp_max_pct: ctx.config.tp_max_pct,
        dynamic_tp_fallback_pct: ctx.config.dynamic_tp_fallback_pct,
        stop_loss_pct: effectiveStopLossPct,
      },
      trailingState
    );

    // Update trailing state if active
    if (ctx.config.trailing_stop_enabled && advancedResult.exitType !== "trailing_stop") {
      const newState = getTrailingStopState(
        pos,
        entry,
        {
          trailing_stop_enabled: ctx.config.trailing_stop_enabled,
          trailing_stop_pct: ctx.config.trailing_stop_pct,
          trailing_stop_activation_pct: ctx.config.trailing_stop_activation_pct,
        },
        trailingState
      );
      if (newState.active || trailingState?.active) {
        ctx.state.set(trailingStateKey, newState);
        trailingState = newState;
      }
    }

    // If advanced exit triggered, add to exits
    if (advancedResult.shouldExit) {
      exits.push({
        symbol: pos.symbol,
        reason: advancedResult.reason,
      });
      // Clear trailing state on exit
      ctx.state.set(trailingStateKey, { active: false, highPrice: 0, stopPrice: 0 });
      continue;
    }

    // Store advanced exit info for dashboard visibility
    if (ctx.config.trailing_stop_enabled || ctx.config.dynamic_tp_enabled) {
      const advancedState = ctx.state.get<Record<string, unknown>>("advancedExitState") ?? {};
      advancedState[pos.symbol] = {
        trailingActive: trailingState?.active ?? false,
        highPrice: trailingState?.highPrice ?? pos.current_price,
        dynamicTpPct: advancedResult.dynamicTpPct,
        currentStopPct: advancedResult.currentStopPct,
      };
      ctx.state.set("advancedExitState", advancedState);
    }

    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    // Take profit (only if dynamic TP not enabled, otherwise handled by advanced exits)
    if (!ctx.config.dynamic_tp_enabled && plPct >= effectiveTakeProfitPct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Take profit at +${plPct.toFixed(1)}% (target ${effectiveTakeProfitPct.toFixed(1)}%)`,
      });
      continue;
    }

    // Stop loss (only if not using advanced exits, otherwise handled there)
    if (!ctx.config.trailing_stop_enabled && plPct <= -effectiveStopLossPct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Stop loss at ${plPct.toFixed(1)}% (limit ${effectiveStopLossPct.toFixed(1)}%)`,
      });
      continue;
    }

    const positionResearch = getPositionResearch(pos.symbol, ctx);
    if (positionResearch?.recommendation === "SELL") {
      const reasoning = positionResearch.reasoning?.trim();
      exits.push({
        symbol: pos.symbol,
        reason: reasoning ? `Position research SELL: ${reasoning}` : "Position research SELL recommendation",
      });
      continue;
    }

    if (entry && entryPrice > 0 && currentPrice > 0) {
      const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
      const holdMinutes = holdHours * 60;
      if (
        (ctx.config.early_loss_exit_enabled ?? true) &&
        holdMinutes <= (ctx.config.early_loss_exit_max_hold_minutes ?? 90) &&
        plPct <= -(ctx.config.early_loss_exit_pct ?? 2.5)
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Early loss exit: ${plPct.toFixed(1)}% after ${holdMinutes.toFixed(0)}m`,
        });
        continue;
      }

      const adverseEntrySlippagePct =
        Number.isFinite(entry.entry_slippage_pct) && entry.entry_slippage_pct !== undefined
          ? entry.entry_slippage_pct
          : null;
      if (
        (ctx.config.bad_fill_exit_enabled ?? true) &&
        adverseEntrySlippagePct !== null &&
        adverseEntrySlippagePct >= (ctx.config.bad_fill_max_slippage_pct ?? 0.5) &&
        holdMinutes <= (ctx.config.bad_fill_max_hold_minutes ?? 30) &&
        plPct <= -(ctx.config.bad_fill_loss_pct ?? 0.5)
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Bad fill early exit: entry slippage ${adverseEntrySlippagePct.toFixed(2)}%, P/L ${plPct.toFixed(1)}% after ${holdMinutes.toFixed(0)}m`,
        });
        continue;
      }

      const staleLossExitPct = ctx.config.stale_loss_exit_pct ?? 2;
      if (
        (ctx.config.stale_position_enabled ?? true) &&
        staleLossExitPct > 0 &&
        holdHours >= (ctx.config.stale_min_hold_hours ?? 24) &&
        plPct <= -staleLossExitPct
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Timed loss exit: ${plPct.toFixed(1)}% after ${holdHours.toFixed(1)}h`,
        });
        continue;
      }

      if (
        (ctx.config.sentiment_reversal_exit_enabled ?? true) &&
        plPct <= -(ctx.config.sentiment_reversal_loss_pct ?? 1.5)
      ) {
        const minHoldMinutes = ctx.config.sentiment_reversal_min_hold_minutes ?? 60;
        if (holdMinutes >= minHoldMinutes) {
          const reversal = getFreshSignalReversal(
            ctx.signals,
            pos.symbol,
            ctx.config.max_entry_research_age_minutes ?? 30,
            ctx.config.sentiment_reversal_threshold ?? -0.25,
            ctx.config.sentiment_reversal_min_sources ?? 1
          );
          if (reversal.reversed) {
            exits.push({
              symbol: pos.symbol,
              reason: `Sentiment reversal loss exit: ${plPct.toFixed(1)}%, avg signal ${(
                reversal.averageSentiment ?? 0
              ).toFixed(2)}, ${reversal.bearishSignals}/${reversal.sourceCount} bearish`,
            });
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
        const reversal = getFreshSignalReversal(
          ctx.signals,
          pos.symbol,
          ctx.config.max_entry_research_age_minutes ?? 30,
          ctx.config.sentiment_reversal_threshold ?? -0.25,
          ctx.config.sentiment_reversal_min_sources ?? 1
        );
        if (reversal.reversed) {
          exits.push({
            symbol: pos.symbol,
            reason: `Sentiment reversal profit exit: +${plPct.toFixed(1)}%, avg signal ${(
              reversal.averageSentiment ?? 0
            ).toFixed(2)}, ${reversal.bearishSignals}/${reversal.sourceCount} bearish`,
          });
          continue;
        }
      }

      if (
        (ctx.config.profit_lock_stop_enabled ?? true) &&
        peakGainPct >= profitLockActivationPct &&
        currentPrice <= profitLockPrice
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Profit lock stop: peak +${peakGainPct.toFixed(1)}%, current near +${profitLockBufferPct.toFixed(2)}% floor`,
        });
        continue;
      }

      if (
        (ctx.config.trailing_stop_enabled ?? true) &&
        peakGainPct >= (ctx.config.trailing_stop_activation_pct ?? 6) &&
        drawdownFromPeakPct >= (ctx.config.trailing_stop_drawdown_pct ?? 3)
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Trailing stop: peak +${peakGainPct.toFixed(1)}%, gave back ${drawdownFromPeakPct.toFixed(1)}%`,
        });
        continue;
      }

      const breakevenPrice = entryPrice * (1 + breakevenBufferPct / 100);
      if (
        (ctx.config.breakeven_stop_enabled ?? true) &&
        peakGainPct >= breakevenActivationPct &&
        currentPrice <= breakevenPrice
      ) {
        exits.push({
          symbol: pos.symbol,
          reason: `Breakeven stop: peak +${peakGainPct.toFixed(1)}%, current near entry`,
        });
        continue;
      }
    }

    // Staleness check
    if (ctx.config.stale_position_enabled) {
      // Get current social volume from strategy state
      const socialSnapshot = ctx.state.get<Record<string, { volume: number }>>("socialSnapshotCache") ?? {};
      const currentSocialVolume = socialSnapshot[pos.symbol]?.volume ?? socialSnapshot[symbolKey]?.volume ?? null;

      const stalenessResult = analyzeStaleness(symbolKey, pos.current_price, currentSocialVolume, entry, ctx.config);

      // Store for status dashboard visibility
      const stalenessState = ctx.state.get<Record<string, unknown>>("stalenessAnalysis") ?? {};
      stalenessState[pos.symbol] = stalenessResult;
      stalenessState[symbolKey] = stalenessResult;
      ctx.state.set("stalenessAnalysis", stalenessState);

      if (stalenessResult.isStale) {
        exits.push({
          symbol: pos.symbol,
          reason: `STALE: ${stalenessResult.reason}`,
        });
      }
    }
  }

  return exits;
}
