function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AnalystBuyGuardResearch {
  verdict: "BUY" | "SKIP" | "WAIT";
  entry_quality: "excellent" | "good" | "fair" | "poor";
  timestamp: number;
}

export interface AnalystBuyGuardMomentum {
  price_change_1h?: number;
  price_change_24h?: number;
}

export interface AnalystBuyGuardResult {
  allowed: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export function shouldBypassLlmMinHold(params: {
  holdMinutes: number;
  minHoldMinutes: number;
  pnlPct: number | null | undefined;
  confidence: number;
  forceSellPnlPct: number;
  forceSellMinConfidence: number;
}): boolean {
  const { holdMinutes, minHoldMinutes, pnlPct, confidence, forceSellPnlPct, forceSellMinConfidence } = params;

  if (holdMinutes >= minHoldMinutes) return true;
  if (pnlPct === null || pnlPct === undefined || !Number.isFinite(pnlPct)) return false;

  return pnlPct <= -Math.abs(forceSellPnlPct) && confidence >= forceSellMinConfidence;
}

export function evaluateAnalystBuyGuard(params: {
  research?: AnalystBuyGuardResearch | null;
  momentum?: AnalystBuyGuardMomentum | null;
  cooldownUntil?: number | null;
  now: number;
  maxResearchAgeMs: number;
  maxAbsPriceChange24hPct: number;
  maxAbsPriceChange1hPct: number;
}): AnalystBuyGuardResult {
  const { research, momentum, cooldownUntil, now, maxResearchAgeMs, maxAbsPriceChange24hPct, maxAbsPriceChange1hPct } =
    params;

  if (cooldownUntil && cooldownUntil > now) {
    return {
      allowed: false,
      reason: "recent_sell_cooldown",
      metadata: { cooldown_until: cooldownUntil, remaining_ms: cooldownUntil - now },
    };
  }

  if (!research) {
    return { allowed: false, reason: "missing_signal_research" };
  }

  const researchAgeMs = now - research.timestamp;
  if (!Number.isFinite(researchAgeMs) || researchAgeMs < 0 || researchAgeMs > maxResearchAgeMs) {
    return {
      allowed: false,
      reason: "stale_signal_research",
      metadata: { research_age_ms: researchAgeMs, max_research_age_ms: maxResearchAgeMs },
    };
  }

  if (research.verdict !== "BUY") {
    return {
      allowed: false,
      reason: "signal_research_not_buy",
      metadata: { signal_research_verdict: research.verdict },
    };
  }

  if (research.entry_quality === "poor") {
    return {
      allowed: false,
      reason: "poor_entry_quality",
      metadata: { entry_quality: research.entry_quality },
    };
  }

  const priceChange24h = momentum?.price_change_24h;
  if (
    priceChange24h !== undefined &&
    Number.isFinite(priceChange24h) &&
    Math.abs(priceChange24h) > maxAbsPriceChange24hPct
  ) {
    return {
      allowed: false,
      reason: "extreme_24h_price_change",
      metadata: { price_change_24h: priceChange24h, max_abs_price_change_24h_pct: maxAbsPriceChange24hPct },
    };
  }

  const priceChange1h = momentum?.price_change_1h;
  if (
    priceChange1h !== undefined &&
    Number.isFinite(priceChange1h) &&
    Math.abs(priceChange1h) > maxAbsPriceChange1hPct
  ) {
    return {
      allowed: false,
      reason: "extreme_1h_price_change",
      metadata: { price_change_1h: priceChange1h, max_abs_price_change_1h_pct: maxAbsPriceChange1hPct },
    };
  }

  return { allowed: true };
}

export function computeAnalystRecommendationNotional(params: {
  cash: number;
  basePositionSizePct: number;
  confidence: number;
  maxPositionValue: number;
  suggestedSizePct?: number;
  convictionScalingEnabled: boolean;
  lowConfidenceMultiplier: number;
  mediumConfidenceMultiplier: number;
}): number {
  const {
    cash,
    basePositionSizePct,
    confidence,
    maxPositionValue,
    suggestedSizePct,
    convictionScalingEnabled,
    lowConfidenceMultiplier,
    mediumConfidenceMultiplier,
  } = params;

  const confidenceClamped = clamp(confidence, 0, 1);
  const configuredPct = Math.max(basePositionSizePct, 0);
  const llmSuggestedPct =
    suggestedSizePct !== undefined && Number.isFinite(suggestedSizePct) && suggestedSizePct > 0
      ? Math.min(configuredPct, suggestedSizePct)
      : configuredPct;

  let convictionMultiplier = 1;
  if (convictionScalingEnabled) {
    if (confidenceClamped < 0.65) {
      convictionMultiplier = clamp(lowConfidenceMultiplier, 0.1, 1);
    } else if (confidenceClamped < 0.75) {
      convictionMultiplier = clamp(mediumConfidenceMultiplier, 0.1, 1);
    }
  }

  const rawNotional = cash * (llmSuggestedPct / 100) * confidenceClamped * convictionMultiplier;
  return Math.min(rawNotional, maxPositionValue);
}
