import { describe, expect, it } from "vitest";
import { analyzeMarketRegime } from "./market-regime";

describe("market regime", () => {
  it("does not default to a perfect bullish score when VIX data is missing", () => {
    const result = analyzeMarketRegime(
      {
        spyPrice: 510,
        spySma20: 505,
        spySma50: 498,
      },
      {
        market_regime_enabled: true,
        regime_low_threshold: 0.5,
        regime_position_size_reduction: 0.45,
      }
    );

    expect(result.regimeScore).toBeLessThan(1);
    expect(result.regimeScore).toBeGreaterThan(0.5);
    expect(result.positionSizeMultiplier).toBe(1);
  });

  it("reduces size in a downtrend even without VIX", () => {
    const result = analyzeMarketRegime(
      {
        spyPrice: 485,
        spySma20: 492,
        spySma50: 500,
      },
      {
        market_regime_enabled: true,
        regime_low_threshold: 0.5,
        regime_position_size_reduction: 0.45,
      }
    );

    expect(result.regime).toBe("downtrend");
    expect(result.positionSizeMultiplier).toBe(0.45);
  });

  it("uses QQQ trend data to avoid overrating a mixed market", () => {
    const result = analyzeMarketRegime(
      {
        spyPrice: 510,
        spySma20: 506,
        spySma50: 500,
        qqqPrice: 420,
        qqqSma20: 430,
        qqqSma50: 438,
      },
      {
        market_regime_enabled: true,
        regime_low_threshold: 0.5,
        regime_position_size_reduction: 0.45,
      }
    );

    expect(result.regimeScore).toBeLessThan(0.7);
    expect(result.reason).toContain("QQQ=");
  });
});
