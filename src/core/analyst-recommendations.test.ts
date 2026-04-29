import { describe, expect, it } from "vitest";
import {
  computeAnalystRecommendationNotional,
  evaluateAnalystBuyGuard,
  shouldBypassLlmMinHold,
} from "./analyst-recommendations";

describe("analyst recommendation helpers", () => {
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

  it("blocks analyst buys when signal research is not a BUY", () => {
    expect(
      evaluateAnalystBuyGuard({
        research: {
          verdict: "SKIP",
          entry_quality: "poor",
          timestamp: 1_000,
        },
        now: 1_100,
        maxResearchAgeMs: 15 * 60 * 1000,
        maxAbsPriceChange24hPct: 30,
        maxAbsPriceChange1hPct: 15,
      })
    ).toMatchObject({ allowed: false, reason: "signal_research_not_buy" });
  });

  it("blocks analyst buys after extreme price moves", () => {
    expect(
      evaluateAnalystBuyGuard({
        research: {
          verdict: "BUY",
          entry_quality: "good",
          timestamp: 1_000,
        },
        momentum: { price_change_24h: -78 },
        now: 1_100,
        maxResearchAgeMs: 15 * 60 * 1000,
        maxAbsPriceChange24hPct: 30,
        maxAbsPriceChange1hPct: 15,
      })
    ).toMatchObject({ allowed: false, reason: "extreme_24h_price_change" });
  });

  it("blocks analyst buys during the post-sell cooldown", () => {
    expect(
      evaluateAnalystBuyGuard({
        research: {
          verdict: "BUY",
          entry_quality: "good",
          timestamp: 1_000,
        },
        cooldownUntil: 2_000,
        now: 1_100,
        maxResearchAgeMs: 15 * 60 * 1000,
        maxAbsPriceChange24hPct: 30,
        maxAbsPriceChange1hPct: 15,
      })
    ).toMatchObject({ allowed: false, reason: "recent_sell_cooldown" });
  });
});
