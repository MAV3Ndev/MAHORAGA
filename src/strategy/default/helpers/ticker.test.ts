import { describe, expect, it } from "vitest";
import {
  isBroadMarketProxyTicker,
  isBuiltInTickerBlacklisted,
  isTickerBlacklisted,
  shouldRescueBuiltInBlacklistedTicker,
} from "./ticker";

describe("ticker helpers", () => {
  it("flags broad market proxy symbols as noise", () => {
    expect(isBroadMarketProxyTicker("SPY")).toBe(true);
    expect(isBroadMarketProxyTicker("QQQ")).toBe(true);
    expect(isBroadMarketProxyTicker("AAPL")).toBe(false);
  });

  it("checks built-in and custom blacklists", () => {
    expect(isTickerBlacklisted("ETF")).toBe(true);
    expect(isTickerBlacklisted("AAPL", ["AAPL"])).toBe(true);
    expect(isTickerBlacklisted("MSFT", ["AAPL"])).toBe(false);
  });

  it("can rescue legitimate symbols from the built-in blacklist", () => {
    expect(isBuiltInTickerBlacklisted("NOW")).toBe(true);
    expect(shouldRescueBuiltInBlacklistedTicker("NOW", { knownSecTicker: true })).toBe(true);
    expect(shouldRescueBuiltInBlacklistedTicker("NOW", { alpacaValid: true })).toBe(true);
    expect(shouldRescueBuiltInBlacklistedTicker("NOW", { customBlacklist: ["NOW"], knownSecTicker: true })).toBe(false);
  });
});
