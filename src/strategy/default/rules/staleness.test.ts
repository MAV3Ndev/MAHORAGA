import { describe, expect, it } from "vitest";
import { analyzeStaleness } from "./staleness";

describe("staleness", () => {
  it("explains stale exits in terms of hold time and missed gain target", () => {
    const result = analyzeStaleness(
      "ETHUSD",
      104,
      5,
      {
        symbol: "ETHUSD",
        entry_time: Date.now() - 8 * 24 * 60 * 60 * 1000,
        entry_price: 100,
        entry_sentiment: 0.7,
        entry_social_volume: 20,
        entry_sources: ["crypto_momentum"],
        entry_reason: "momentum",
        peak_price: 110,
        peak_sentiment: 0.7,
      },
      {
        stale_min_hold_hours: 12,
        stale_max_hold_days: 3,
        stale_min_gain_pct: 5,
        stale_mid_hold_days: 2,
        stale_mid_min_gain_pct: 3,
        stale_social_volume_decay: 0.3,
      } as never
    );

    expect(result.isStale).toBe(true);
    expect(result.reason).toContain("Held 8.0 days");
    expect(result.reason).toContain("below stale target 5.0%");
  });
});
