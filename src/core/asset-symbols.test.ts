import { describe, expect, it } from "vitest";
import {
  areEquivalentAssetSymbols,
  compactCryptoSymbol,
  getCryptoSymbolAliases,
  isCryptoSymbol,
  normalizeCryptoSymbol,
} from "./asset-symbols";

describe("asset symbol helpers", () => {
  it("normalizes compact crypto symbols", () => {
    expect(normalizeCryptoSymbol("btcusd")).toBe("BTC/USD");
    expect(normalizeCryptoSymbol("ETH/USDC")).toBe("ETH/USDC");
    expect(normalizeCryptoSymbol("AAPL")).toBe("AAPL");
  });

  it("compacts normalized crypto symbols", () => {
    expect(compactCryptoSymbol("BTC/USD")).toBe("BTCUSD");
    expect(compactCryptoSymbol("solusd")).toBe("SOLUSD");
  });

  it("matches crypto aliases as equivalent assets", () => {
    expect(areEquivalentAssetSymbols("BTC/USD", "BTCUSD")).toBe(true);
    expect(areEquivalentAssetSymbols("AAPL", "aapl")).toBe(true);
    expect(areEquivalentAssetSymbols("BTC/USD", "ETH/USD")).toBe(false);
  });

  it("returns stable aliases for crypto symbols", () => {
    expect(getCryptoSymbolAliases("btc/usd")).toEqual(["BTC/USD", "BTCUSD"]);
    expect(getCryptoSymbolAliases("BTCUSD")).toEqual(["BTCUSD", "BTC/USD"]);
  });

  it("detects configured and syntactically valid crypto symbols", () => {
    expect(isCryptoSymbol("SOLUSD", ["BTC/USD", "ETH/USD"])).toBe(true);
    expect(isCryptoSymbol("BTCUSD", ["BTC/USD"])).toBe(true);
    expect(isCryptoSymbol("AAPL", ["BTC/USD"])).toBe(false);
  });
});
