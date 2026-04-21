/**
 * Entry Timing Rules — filter entries using technical indicators.
 *
 * Checks RSI pullbacks, Bollinger Band lower band approach,
 * and trend confirmation (SMA crossover).
 */

export interface TechnicalData {
  rsi?: number;
  bb_lower?: number;
  bb_middle?: number;
  sma_20?: number;
  sma_50?: number;
  current_price: number;
  atr?: number;
}

export interface EntryTimingResult {
  passes: boolean;
  reason: string;
  signals: string[];
  atr?: number;
}

/**
 * Check if entry timing conditions are met.
 */
export function checkEntryTiming(
  _symbol: string,
  tech: TechnicalData,
  config: {
    entry_timing_enabled: boolean;
    entry_rsi_min: number;
    entry_rsi_max: number;
    entry_bb_lower_threshold: number;
  }
): EntryTimingResult {
  const signals: string[] = [];

  // If disabled, pass all entries
  if (!config.entry_timing_enabled) {
    return { passes: true, reason: "Entry timing disabled", signals: [] };
  }

  // RSI pullback check (40-55 range = healthy pullback)
  if (tech.rsi !== undefined) {
    if (tech.rsi >= config.entry_rsi_min && tech.rsi <= config.entry_rsi_max) {
      signals.push(`RSI pullback ${tech.rsi.toFixed(1)}`);
    } else if (tech.rsi < config.entry_rsi_min) {
      return {
        passes: false,
        reason: `RSI oversold ${tech.rsi.toFixed(1)} (min ${config.entry_rsi_min})`,
        signals: [],
      };
    } else {
      return {
        passes: false,
        reason: `RSI overbought ${tech.rsi.toFixed(1)} (max ${config.entry_rsi_max})`,
        signals: [],
      };
    }
  }

  // Bollinger Band lower band approach
  if (tech.bb_lower !== undefined && tech.current_price > 0) {
    const bandProximity = (tech.current_price - tech.bb_lower) / tech.bb_lower;
    if (bandProximity <= config.entry_bb_lower_threshold) {
      signals.push(`BB lower band proximity ${(bandProximity * 100).toFixed(1)}%`);
    }
  }

  // Trend confirmation (20 SMA > 50 SMA = uptrend)
  if (tech.sma_20 !== undefined && tech.sma_50 !== undefined) {
    if (tech.sma_20 > tech.sma_50) {
      signals.push("20SMA > 50SMA uptrend confirmed");
    } else {
      return {
        passes: false,
        reason: `Downtrend: 20SMA (${tech.sma_20.toFixed(2)}) < 50SMA (${tech.sma_50.toFixed(2)})`,
        signals: [],
      };
    }
  }

  if (signals.length === 0) {
    return { passes: true, reason: "No timing filters triggered", signals: [], atr: tech.atr };
  }

  return {
    passes: true,
    reason: `Timing OK: ${signals.join(", ")}`,
    signals,
    atr: tech.atr,
  };
}
