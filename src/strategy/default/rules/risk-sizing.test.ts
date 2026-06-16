import { describe, expect, it } from "vitest";
import { computeRiskSizedNotional } from "./risk-sizing";

describe("risk sizing", () => {
  it("caps notional by risk budget and stop distance", () => {
    const result = computeRiskSizedNotional({
      cash: 10_000,
      maxPositionValue: 5_000,
      confidence: 1,
      positionSizePctOfCash: 50,
      riskPerTradePct: 1,
      stopLossPct: 5,
      entryPrice: 100,
      atr: 10,
    });

    expect(result.stopDistancePct).toBe(10);
    expect(result.notional).toBe(1_000);
  });

  it("applies regime multiplier after risk and cash caps", () => {
    const result = computeRiskSizedNotional({
      cash: 10_000,
      maxPositionValue: 5_000,
      confidence: 1,
      positionSizePctOfCash: 20,
      riskPerTradePct: 1,
      stopLossPct: 5,
      regimeMultiplier: 0.5,
    });

    expect(result.notional).toBe(1_000);
  });
});
