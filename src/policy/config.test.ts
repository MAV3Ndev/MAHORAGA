import { describe, expect, it } from "vitest";
import { getDefaultPolicyConfig, validatePolicyConfig } from "./config";

describe("validatePolicyConfig", () => {
  it("accepts the default policy configuration", () => {
    expect(() => validatePolicyConfig(getDefaultPolicyConfig({} as never))).not.toThrow();
  });

  it("bounds daily entry frequency controls", () => {
    const config = getDefaultPolicyConfig({} as never);

    expect(() => validatePolicyConfig({ ...config, max_daily_entry_orders: -1 })).toThrow(/max_daily_entry_orders/);
    expect(() => validatePolicyConfig({ ...config, max_daily_entry_orders: 101 })).toThrow(/max_daily_entry_orders/);
    expect(() => validatePolicyConfig({ ...config, min_minutes_between_entries: -1 })).toThrow(
      /min_minutes_between_entries/
    );
    expect(() => validatePolicyConfig({ ...config, min_minutes_between_entries: 1441 })).toThrow(
      /min_minutes_between_entries/
    );
  });
});
