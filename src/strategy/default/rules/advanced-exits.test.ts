import { describe, expect, it } from "vitest";
import { checkAdvancedExits, getTrailingStopState, type TrailingStopState } from "./advanced-exits";

describe("advanced exits", () => {
  const baseConfig = {
    trailing_stop_enabled: true,
    trailing_stop_pct: 5,
    trailing_stop_activation_pct: 5,
    dynamic_tp_enabled: false,
    tp_atr_multiplier: 3,
    tp_min_pct: 5,
    tp_max_pct: 25,
    dynamic_tp_fallback_pct: 12,
    stop_loss_pct: 5,
  };

  it("ratchets the trailing stop from the highest seen price", () => {
    const nextState = getTrailingStopState(
      {
        current_price: 108,
        avg_entry_price: 100,
      } as never,
      {
        symbol: "AAPL",
        entry_time: Date.now(),
        entry_price: 100,
        entry_sentiment: 0.8,
        entry_social_volume: 12,
        entry_sources: ["stocktwits"],
        entry_reason: "momentum",
        peak_price: 109,
        peak_sentiment: 0.8,
      },
      {
        trailing_stop_enabled: true,
        trailing_stop_pct: 5,
        trailing_stop_activation_pct: 5,
      },
      {
        active: true,
        highPrice: 110,
        stopPrice: 104.5,
      }
    );

    expect(nextState.active).toBe(true);
    expect(nextState.highPrice).toBe(110);
    expect(nextState.stopPrice).toBe(104.5);
  });

  it("exits when price falls through the ratcheted stop", () => {
    const trailingState: TrailingStopState = {
      active: true,
      highPrice: 110,
      stopPrice: 104.5,
    };

    const result = checkAdvancedExits(
      {
        symbol: "AAPL",
        current_price: 104,
        avg_entry_price: 100,
      } as never,
      {
        symbol: "AAPL",
        entry_time: Date.now(),
        entry_price: 100,
        entry_sentiment: 0.8,
        entry_social_volume: 12,
        entry_sources: ["stocktwits"],
        entry_reason: "momentum",
        peak_price: 110,
        peak_sentiment: 0.8,
      },
      undefined,
      baseConfig,
      trailingState
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe("trailing_stop");
  });

  it("uses configured dynamic TP fallback when ATR is unavailable", () => {
    const result = checkAdvancedExits(
      {
        symbol: "AAPL",
        current_price: 113,
        avg_entry_price: 100,
      } as never,
      undefined,
      undefined,
      {
        ...baseConfig,
        trailing_stop_enabled: false,
        dynamic_tp_enabled: true,
        dynamic_tp_fallback_pct: 12,
      },
      undefined
    );

    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe("dynamic_tp");
    expect(result.dynamicTpPct).toBe(12);
  });
});
