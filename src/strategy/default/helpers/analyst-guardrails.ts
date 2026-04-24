function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
