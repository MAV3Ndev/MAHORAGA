import { describe, expect, it } from "vitest";
import { computeAnalystRecommendationNotional, shouldBypassLlmMinHold } from "./analyst-guardrails";

describe("analyst guardrails", () => {
  it("bypasses min hold when loss breach and confidence are both high enough", () => {
    expect(
      shouldBypassLlmMinHold({
        holdMinutes: 9,
        minHoldMinutes: 15,
        pnlPct: -3.2,
        confidence: 0.7,
        forceSellPnlPct: 2,
        forceSellMinConfidence: 0.65,
      })
    ).toBe(true);
  });

  it("keeps min hold when confidence is too low despite the drawdown", () => {
    expect(
      shouldBypassLlmMinHold({
        holdMinutes: 9,
        minHoldMinutes: 15,
        pnlPct: -3.2,
        confidence: 0.55,
        forceSellPnlPct: 2,
        forceSellMinConfidence: 0.65,
      })
    ).toBe(false);
  });

  it("scales low-confidence analyst buys down before the max notional cap", () => {
    expect(
      computeAnalystRecommendationNotional({
        cash: 75000,
        basePositionSizePct: 25,
        confidence: 0.55,
        maxPositionValue: 10000,
        convictionScalingEnabled: true,
        lowConfidenceMultiplier: 0.4,
        mediumConfidenceMultiplier: 0.7,
      })
    ).toBe(4125);
  });

  it("respects the llm suggested size percentage when it is lower than the config", () => {
    expect(
      computeAnalystRecommendationNotional({
        cash: 80000,
        basePositionSizePct: 25,
        confidence: 0.8,
        maxPositionValue: 10000,
        suggestedSizePct: 10,
        convictionScalingEnabled: true,
        lowConfidenceMultiplier: 0.4,
        mediumConfidenceMultiplier: 0.7,
      })
    ).toBe(6400);
  });
});
