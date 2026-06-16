/**
 * Exit rules — decide which positions to sell.
 *
 * Core ALWAYS enforces stop-loss/take-profit on top of strategy exits.
 * This function handles: TP, SL, staleness, trailing stop, and options exits.
 */

import type { Account, Position } from "../../../core/types";
import type { SellCandidate, StrategyContext } from "../../types";
import { getCryptoSymbolAliases, isCryptoSymbol } from "../helpers/crypto";
import { checkAdvancedExits, getTrailingStopState, type TrailingStopState } from "./advanced-exits";
import { analyzeStaleness } from "./staleness";

/**
 * Evaluate all positions and return sell candidates.
 * Core handles the actual order execution.
 */
export function selectExits(ctx: StrategyContext, positions: Position[], _account: Account): SellCandidate[] {
  const exits: SellCandidate[] = [];

  for (const pos of positions) {
    // Options are handled separately
    if (pos.asset_class === "us_option") {
      const optionExit = checkOptionsExit(pos, ctx);
      if (optionExit) exits.push(optionExit);
      continue;
    }

    const entry = getPositionEntry(pos.symbol, ctx);
    const effectiveStopLossPct = getEffectiveStopLossPct(entry?.recommended_stop_loss_pct, ctx.config.stop_loss_pct);
    const effectiveTakeProfitPct = entry?.recommended_take_profit_pct ?? ctx.config.take_profit_pct;

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

    // Staleness check
    if (ctx.config.stale_position_enabled) {
      // Get current social volume from strategy state
      const socialSnapshot = ctx.state.get<Record<string, { volume: number }>>("socialSnapshotCache") ?? {};
      const currentSocialVolume = getSnapshotValue(pos.symbol, socialSnapshot, ctx)?.volume ?? 0;

      const stalenessResult = analyzeStaleness(pos.symbol, pos.current_price, currentSocialVolume, entry, ctx.config);

      // Store for status dashboard visibility
      const stalenessState = ctx.state.get<Record<string, unknown>>("stalenessAnalysis") ?? {};
      stalenessState[pos.symbol] = stalenessResult;
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

function checkOptionsExit(pos: Position, ctx: StrategyContext): SellCandidate | null {
  if (!ctx.config.options_enabled) return null;

  const entryPrice = pos.avg_entry_price || pos.current_price;
  const plPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

  if (plPct <= -ctx.config.options_stop_loss_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options stop loss at ${plPct.toFixed(1)}%`,
    };
  }

  if (plPct >= ctx.config.options_take_profit_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options take profit at +${plPct.toFixed(1)}%`,
    };
  }

  return null;
}

/**
 * Get ATR for a symbol from cache or return undefined.
 */
function getATR(symbol: string, ctx: StrategyContext): number | undefined {
  const atrCache = ctx.state.get<Record<string, number>>("atrCache");
  const directMatch = atrCache?.[symbol];
  if (directMatch !== undefined) return directMatch;

  if (!isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
    return undefined;
  }

  for (const alias of getCryptoSymbolAliases(symbol)) {
    const candidate = atrCache?.[alias];
    if (candidate !== undefined) return candidate;
  }

  return undefined;
}

function getPositionEntry(symbol: string, ctx: StrategyContext) {
  const directMatch = ctx.positionEntries[symbol];
  if (directMatch) return directMatch;

  if (!isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
    return undefined;
  }

  for (const alias of getCryptoSymbolAliases(symbol)) {
    const candidate = ctx.positionEntries[alias];
    if (candidate) return candidate;
  }

  return undefined;
}

function getEffectiveStopLossPct(recommendedStopLossPct: number | undefined, configuredStopLossPct: number): number {
  if (recommendedStopLossPct === undefined || !Number.isFinite(recommendedStopLossPct) || recommendedStopLossPct <= 0) {
    return configuredStopLossPct;
  }
  return Math.min(recommendedStopLossPct, configuredStopLossPct);
}

function getPositionResearch(
  symbol: string,
  ctx: StrategyContext
):
  | {
      recommendation?: "HOLD" | "SELL" | "ADD";
      reasoning?: string;
    }
  | undefined {
  const research =
    ctx.state.get<Record<string, { recommendation?: "HOLD" | "SELL" | "ADD"; reasoning?: string }>>("positionResearch");
  const directMatch = research?.[symbol];
  if (directMatch) return directMatch;

  if (!isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
    return undefined;
  }

  for (const alias of getCryptoSymbolAliases(symbol)) {
    const candidate = research?.[alias];
    if (candidate) return candidate;
  }

  return undefined;
}

function getSnapshotValue<T>(symbol: string, snapshot: Record<string, T>, ctx: StrategyContext): T | undefined {
  const directMatch = snapshot[symbol];
  if (directMatch) return directMatch;

  if (!isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
    return undefined;
  }

  for (const alias of getCryptoSymbolAliases(symbol)) {
    const candidate = snapshot[alias];
    if (candidate) return candidate;
  }

  return undefined;
}
