import { describe, expect, it } from "vitest";
import { isConfiguredCryptoSymbol, isCryptoSymbol, isStockTwitsCryptoSymbol, normalizeCryptoSymbol } from "./crypto";

describe("crypto symbol helpers", () => {
  it("normalizes StockTwits crypto tickers to Alpaca crypto pairs", () => {
    expect(normalizeCryptoSymbol("BTC.X")).toBe("BTC/USD");
    expect(normalizeCryptoSymbol("eth.x")).toBe("ETH/USD");
  });

  it("detects StockTwits crypto tickers", () => {
    expect(isStockTwitsCryptoSymbol("BTC.X")).toBe(true);
    expect(isStockTwitsCryptoSymbol("MULN.X")).toBe(true);
    expect(isStockTwitsCryptoSymbol("AAPL")).toBe(false);
  });

  it("only treats configured StockTwits crypto tickers as configured", () => {
    const configured = ["BTC/USD", "ETH/USD", "SOL/USD"];

    expect(isConfiguredCryptoSymbol("BTC.X", configured)).toBe(true);
    expect(isConfiguredCryptoSymbol("BTC/USD", configured)).toBe(true);
    expect(isConfiguredCryptoSymbol("MULN.X", configured)).toBe(false);
  });

  it("preserves broad crypto pair detection for existing order paths", () => {
    expect(isCryptoSymbol("DOGE/USD", [])).toBe(true);
    expect(isCryptoSymbol("DOGE.X", [])).toBe(true);
    expect(isCryptoSymbol("AAPL", [])).toBe(false);
  });
});
