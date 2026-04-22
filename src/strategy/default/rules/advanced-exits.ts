/**
 * Advanced Exit Rules — trailing stop and dynamic take profit.
 *
 * - Trailing stop: Activates after gain exceeds threshold, follows price
 * - Dynamic TP: ATR-based take profit for volatility-adjusted exits
 */

import type { Position, PositionEntry } from "../../../core/types";

export interface TrailingStopState {
  active: boolean;
  highPrice: number;
  stopPrice: number;
}

export interface AdvancedExitResult {
  shouldExit: boolean;
  reason: string;
  exitType?: "trailing_stop" | "dynamic_tp" | "stop_loss";
  currentStopPct?: number;
  dynamicTpPct?: number;
}

/**
 * Check trailing stop and dynamic TP for a position.
 *
 * @param pos Position to check
 * @param entry Position entry data
 * @param atr ATR value for the symbol (optional)
 * @param config Trailing stop and dynamic TP config
 * @param trailingState Current trailing stop state (from position metadata)
 */
export function checkAdvancedExits(
  pos: Position,
  entry: PositionEntry | undefined,
  atr: number | undefined,
  config: {
    trailing_stop_enabled: boolean;
    trailing_stop_pct: number;
    trailing_stop_activation_pct: number;
    dynamic_tp_enabled: boolean;
    tp_atr_multiplier: number;
    tp_min_pct: number;
    tp_max_pct: number;
    stop_loss_pct: number;
  },
  trailingState: TrailingStopState | undefined
): AdvancedExitResult {
  const entryPrice = entry?.entry_price ?? pos.avg_entry_price ?? pos.current_price;
  if (entryPrice <= 0) {
    return { shouldExit: false, reason: "No entry price" };
  }

  const pnlPct = ((pos.current_price - entryPrice) / entryPrice) * 100;
  const currentHigh = Math.max(trailingState?.highPrice ?? 0, entry?.peak_price ?? 0, pos.current_price);

  // Dynamic TP calculation
  let dynamicTpPct = config.tp_max_pct; // default max
  if (config.dynamic_tp_enabled && atr && atr > 0 && pos.current_price > 0) {
    // TP = ATR * multiplier, converted to % of price
    const atrPercent = (atr / pos.current_price) * 100;
    dynamicTpPct = Math.min(config.tp_max_pct, Math.max(config.tp_min_pct, atrPercent * config.tp_atr_multiplier));
  }

  // Trailing stop logic
  if (config.trailing_stop_enabled) {
    const activationThreshold = config.trailing_stop_activation_pct;
    const trailPct = config.trailing_stop_pct;

    // Check if we should activate trailing stop
    if (!trailingState?.active && pnlPct >= activationThreshold) {
      // Activate trailing stop - set stop at (high - trail%)
      return {
        shouldExit: false,
        reason: `Trailing stop activated at ${trailPct}% below ${pos.current_price.toFixed(2)} (TP ${dynamicTpPct.toFixed(1)}%)`,
        exitType: undefined,
        currentStopPct: trailPct,
        dynamicTpPct,
      };
    }

    // If trailing stop is active, update high and check
    if (trailingState?.active) {
      const newHigh = Math.max(currentHigh, pos.current_price);
      const newStopPrice = newHigh * (1 - trailPct / 100);

      // Check if price fell below trailing stop
      if (pos.current_price <= newStopPrice) {
        const actualLossPct = ((pos.current_price - entryPrice) / entryPrice) * 100;
        return {
          shouldExit: true,
          reason: `Trailing stop hit at ${pos.current_price.toFixed(2)} (entry ${entryPrice.toFixed(2)}, loss ${actualLossPct.toFixed(1)}%)`,
          exitType: "trailing_stop",
          currentStopPct: trailPct,
          dynamicTpPct,
        };
      }

      // Update trailing state for next cycle
      return {
        shouldExit: false,
        reason: `Trailing stop active: high ${newHigh.toFixed(2)}, stop ${newStopPrice.toFixed(2)}`,
        exitType: undefined,
        currentStopPct: trailPct,
        dynamicTpPct,
      };
    }
  }

  // Check dynamic take profit
  if (config.dynamic_tp_enabled && pnlPct >= dynamicTpPct) {
    return {
      shouldExit: true,
      reason: `Dynamic TP hit at +${pnlPct.toFixed(1)}% (ATR-based TP: ${dynamicTpPct.toFixed(1)}%)`,
      exitType: "dynamic_tp",
      dynamicTpPct,
    };
  }

  // Standard stop loss check (as fallback)
  if (pnlPct <= -config.stop_loss_pct) {
    return {
      shouldExit: true,
      reason: `Stop loss at ${pnlPct.toFixed(1)}%`,
      exitType: "stop_loss",
      dynamicTpPct,
    };
  }

  return {
    shouldExit: false,
    reason: `No exit signals (P&L: ${pnlPct.toFixed(1)}%, TP: ${dynamicTpPct.toFixed(1)}%)`,
    dynamicTpPct,
  };
}

/**
 * Get or initialize trailing stop state for a position.
 */
export function getTrailingStopState(
  pos: Position,
  entry: PositionEntry | undefined,
  config: {
    trailing_stop_enabled: boolean;
    trailing_stop_pct: number;
    trailing_stop_activation_pct: number;
  },
  trailingState?: TrailingStopState
): TrailingStopState {
  const entryPrice = entry?.entry_price ?? pos.avg_entry_price ?? pos.current_price;
  const pnlPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

  if (!config.trailing_stop_enabled) {
    return { active: false, highPrice: pos.current_price, stopPrice: 0 };
  }

  const isActive = pnlPct >= config.trailing_stop_activation_pct;
  const highPrice = Math.max(trailingState?.highPrice ?? 0, entry?.peak_price ?? 0, pos.current_price);

  return {
    active: isActive || trailingState?.active === true,
    highPrice,
    stopPrice: isActive || trailingState?.active === true ? highPrice * (1 - config.trailing_stop_pct / 100) : 0,
  };
}
