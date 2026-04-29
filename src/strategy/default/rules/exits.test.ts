import { describe, expect, it } from "vitest";
import type { PositionEntry } from "../../../core/types";
import { selectExits } from "./exits";

describe("exit rules", () => {
  it("resolves crypto entry metadata across slash and compact symbols", () => {
    const stateStore = new Map<string, unknown>();
    stateStore.set("socialSnapshotCache", {
      "BTC/USD": { volume: 10 },
    });

    const ctx = {
      config: {
        options_enabled: false,
        trailing_stop_enabled: false,
        trailing_stop_pct: 5,
        trailing_stop_activation_pct: 5,
        dynamic_tp_enabled: false,
        tp_atr_multiplier: 3,
        tp_min_pct: 5,
        tp_max_pct: 25,
        take_profit_pct: 50,
        stop_loss_pct: 20,
        stale_position_enabled: true,
        stale_min_hold_hours: 12,
        stale_max_hold_days: 3,
        stale_min_gain_pct: 5,
        stale_mid_hold_days: 2,
        stale_mid_min_gain_pct: 3,
        stale_social_volume_decay: 0.3,
        crypto_symbols: ["BTC/USD"],
      },
      positionEntries: {
        "BTC/USD": {
          symbol: "BTC/USD",
          entry_time: Date.now() - 13 * 60 * 60 * 1000,
          entry_price: 100,
          entry_sentiment: 0.7,
          entry_social_volume: 10,
          entry_sources: ["crypto_momentum"],
          entry_reason: "momentum",
          peak_price: 105,
          peak_sentiment: 0.7,
        } satisfies PositionEntry,
      },
      state: {
        get<T>(key: string): T | undefined {
          return stateStore.get(key) as T | undefined;
        },
        set<T>(key: string, value: T): void {
          stateStore.set(key, value);
        },
      },
    } as never;

    const exits = selectExits(
      ctx,
      [
        {
          symbol: "BTCUSD",
          asset_class: "crypto",
          avg_entry_price: 100,
          current_price: 104,
          market_value: 1040,
          unrealized_pl: 40,
        },
      ] as never,
      {} as never
    );

    const staleness = (stateStore.get("stalenessAnalysis") as Record<string, { reason: string }> | undefined)?.BTCUSD;

    expect(exits).toEqual([]);
    expect(staleness?.reason).toContain("OK");
  });

  it("turns position research SELL into an exit candidate for crypto aliases", () => {
    const stateStore = new Map<string, unknown>();
    stateStore.set("positionResearch", {
      "BTC/USD": {
        recommendation: "SELL",
        reasoning: "Momentum failed and downside risk is increasing.",
      },
    });

    const ctx = {
      config: {
        options_enabled: false,
        trailing_stop_enabled: false,
        trailing_stop_pct: 5,
        trailing_stop_activation_pct: 5,
        dynamic_tp_enabled: false,
        tp_atr_multiplier: 3,
        tp_min_pct: 5,
        tp_max_pct: 25,
        take_profit_pct: 50,
        stop_loss_pct: 20,
        stale_position_enabled: false,
        stale_min_hold_hours: 12,
        stale_max_hold_days: 3,
        stale_min_gain_pct: 5,
        stale_mid_hold_days: 2,
        stale_mid_min_gain_pct: 3,
        stale_social_volume_decay: 0.3,
        crypto_symbols: ["BTC/USD"],
      },
      positionEntries: {},
      state: {
        get<T>(key: string): T | undefined {
          return stateStore.get(key) as T | undefined;
        },
        set<T>(key: string, value: T): void {
          stateStore.set(key, value);
        },
      },
    } as never;

    const exits = selectExits(
      ctx,
      [
        {
          symbol: "BTCUSD",
          asset_class: "crypto",
          avg_entry_price: 100,
          current_price: 90,
          market_value: 900,
          unrealized_pl: -100,
        },
      ] as never,
      {} as never
    );

    expect(exits).toEqual([
      {
        symbol: "BTCUSD",
        reason: "Position research SELL: Momentum failed and downside risk is increasing.",
      },
    ]);
  });

  it("does not let research widen the configured stop loss", () => {
    const stateStore = new Map<string, unknown>();
    const ctx = {
      config: {
        options_enabled: false,
        trailing_stop_enabled: false,
        trailing_stop_pct: 5,
        trailing_stop_activation_pct: 5,
        dynamic_tp_enabled: false,
        tp_atr_multiplier: 3,
        tp_min_pct: 5,
        tp_max_pct: 25,
        take_profit_pct: 50,
        stop_loss_pct: 5,
        stale_position_enabled: false,
        stale_min_hold_hours: 12,
        stale_max_hold_days: 3,
        stale_min_gain_pct: 5,
        stale_mid_hold_days: 2,
        stale_mid_min_gain_pct: 3,
        stale_social_volume_decay: 0.3,
        crypto_symbols: [],
      },
      positionEntries: {
        AAPL: {
          symbol: "AAPL",
          entry_time: Date.now(),
          entry_price: 100,
          entry_sentiment: 0.7,
          entry_social_volume: 10,
          entry_sources: ["stocktwits"],
          entry_reason: "momentum",
          peak_price: 100,
          peak_sentiment: 0.7,
          recommended_stop_loss_pct: 15,
        } satisfies PositionEntry,
      },
      state: {
        get<T>(key: string): T | undefined {
          return stateStore.get(key) as T | undefined;
        },
        set<T>(key: string, value: T): void {
          stateStore.set(key, value);
        },
      },
    } as never;

    const exits = selectExits(
      ctx,
      [
        {
          symbol: "AAPL",
          asset_class: "us_equity",
          avg_entry_price: 100,
          current_price: 94,
          market_value: 940,
          unrealized_pl: -60,
        },
      ] as never,
      {} as never
    );

    expect(exits).toEqual([
      {
        symbol: "AAPL",
        reason: "Stop loss at -6.0%",
      },
    ]);
  });
});
