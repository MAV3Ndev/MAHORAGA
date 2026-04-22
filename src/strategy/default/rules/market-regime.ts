/**
 * Market Regime Detection — evaluate market environment using VIX plus broad index trend.
 *
 * High volatility or downtrend = reduce position sizes.
 */

export interface MarketRegimeData {
  vix?: number;
  spyPrice?: number;
  spySma20?: number;
  spySma50?: number;
  qqqPrice?: number;
  qqqSma20?: number;
  qqqSma50?: number;
}

export interface MarketRegimeResult {
  regimeScore: number; // 0-1, lower = more dangerous
  regime: "high_volatility" | "downtrend" | "bullish" | "neutral";
  positionSizeMultiplier: number;
  reason: string;
}

/**
 * Analyze market regime and return position size adjustment.
 *
 * @param vix VIX value (typically 15-30, higher = more volatile)
 * @param spyPrice Current SPY price
 * @param spySma20 20-day SMA of SPY
 * @param spySma50 50-day SMA of SPY
 * @param qqqPrice Current QQQ price
 * @param qqqSma20 20-day SMA of QQQ
 * @param qqqSma50 50-day SMA of QQQ
 */
export function analyzeMarketRegime(
  data: MarketRegimeData,
  config: {
    market_regime_enabled: boolean;
    regime_low_threshold: number;
    regime_position_size_reduction: number;
  }
): MarketRegimeResult {
  // Default to full size if disabled
  if (!config.market_regime_enabled) {
    return {
      regimeScore: 1.0,
      regime: "bullish",
      positionSizeMultiplier: 1.0,
      reason: "Market regime disabled",
    };
  }

  const { vix, spyPrice, spySma20, spySma50, qqqPrice, qqqSma20, qqqSma50 } = data;

  // Calculate VIX score (normalized 0-1, higher is calmer)
  let vixScore = 0.65;
  if (vix !== undefined) {
    vixScore = Math.max(0, Math.min(1, 1 - (vix - 12) / 20));
  }

  const trendComponents: number[] = [];
  const addTrendComponents = (price?: number, sma20?: number, sma50?: number, weight = 1) => {
    if (price !== undefined && sma20 !== undefined && sma20 > 0) {
      const ratio = (price - sma20) / sma20;
      trendComponents.push(Math.max(0, Math.min(1, (0.5 + ratio * 12) * weight)));
    }
    if (price !== undefined && sma50 !== undefined && sma50 > 0) {
      const ratio = (price - sma50) / sma50;
      trendComponents.push(Math.max(0, Math.min(1, (0.5 + ratio * 10) * weight)));
    }
    if (sma20 !== undefined && sma50 !== undefined && sma50 > 0) {
      const ratio = (sma20 - sma50) / sma50;
      trendComponents.push(Math.max(0, Math.min(1, (0.5 + ratio * 18) * weight)));
    }
  };

  addTrendComponents(spyPrice, spySma20, spySma50, 1);
  addTrendComponents(qqqPrice, qqqSma20, qqqSma50, 1.05);

  const trendScore =
    trendComponents.length > 0
      ? trendComponents.reduce((sum, value) => sum + value, 0) / trendComponents.length
      : 0.55;

  // Combine scores without letting missing VIX data force a permanent 1.0
  const regimeScore = vix !== undefined ? vixScore * 0.45 + trendScore * 0.55 : trendScore;

  // Determine regime type
  let regime: MarketRegimeResult["regime"];
  let positionSizeMultiplier = 1.0;

  if (regimeScore < config.regime_low_threshold) {
    // Dangerous market - reduce exposure
    positionSizeMultiplier = config.regime_position_size_reduction;
    if (vix !== undefined && vix > 25) {
      regime = "high_volatility";
    } else {
      regime = "downtrend";
    }
  } else if (regimeScore >= 0.7) {
    regime = "bullish";
  } else {
    regime = "neutral";
  }

  return {
    regimeScore,
    regime,
    positionSizeMultiplier,
    reason: `VIX=${vix?.toFixed(1) ?? "N/A"}, SPY=${spyPrice?.toFixed(2) ?? "N/A"}, QQQ=${qqqPrice?.toFixed(2) ?? "N/A"}, trendScore=${trendScore.toFixed(2)}, combined=${regimeScore.toFixed(2)}`,
  };
}
