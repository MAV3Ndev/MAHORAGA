import { describe, expect, it } from "vitest";
import { getDefaultPolicyConfig, getDefaultOptionsPolicyConfig } from "./config";

describe("getDefaultPolicyConfig", () => {
  it("allows runtime overrides for max_open_positions", () => {
    const config = getDefaultPolicyConfig({} as never, {
      max_open_positions: 3,
    });

    expect(config.max_open_positions).toBe(3);
  });

  it("merges nested options overrides without dropping defaults", () => {
    const config = getDefaultPolicyConfig({} as never, {
      options: {
        ...getDefaultOptionsPolicyConfig(),
        max_option_positions: 2,
      },
    });

    expect(config.options.max_option_positions).toBe(2);
    expect(config.options.allowed_strategies).toEqual(["long_call", "long_put"]);
  });
});
