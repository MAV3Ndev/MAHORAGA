import { describe, expect, it } from "vitest";
import { computeHaltLimitPrice, isTradingHaltMarketOrderError } from "./policy-broker";

describe("policy broker helpers", () => {
  it("detects Alpaca trading halt market order rejections", () => {
    const error =
      'MahoragaError: Alpaca validation error: market order rejected due to trading halt on symbol: "TMCR", please place a limit order instead';

    expect(isTradingHaltMarketOrderError(error)).toBe(true);
    expect(isTradingHaltMarketOrderError("some other broker error")).toBe(false);
  });

  it("computes a buffered limit price from the reference price", () => {
    expect(computeHaltLimitPrice(10)).toBe(10.2);
    expect(computeHaltLimitPrice(0)).toBeNull();
    expect(computeHaltLimitPrice(Number.NaN)).toBeNull();
  });
});
