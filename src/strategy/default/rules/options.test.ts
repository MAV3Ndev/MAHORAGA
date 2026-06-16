import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { findBestOptionsContract, parseOccOptionSymbol } from "./options";

const alpaca = {
  options: {
    getExpirations: vi.fn(),
    getChain: vi.fn(),
    getSnapshot: vi.fn(),
  },
  marketData: {
    getSnapshot: vi.fn(),
  },
};

vi.mock("../../../providers/alpaca", () => ({
  createAlpacaProviders: () => alpaca,
}));

describe("parseOccOptionSymbol", () => {
  it("parses compact OCC call symbols", () => {
    expect(parseOccOptionSymbol("AAPL260619C00195000")).toEqual({
      underlying: "AAPL",
      expiration: "2026-06-19",
      optionType: "call",
      strike: 195,
    });
  });

  it("parses compact OCC put symbols with whitespace and lowercase input", () => {
    expect(parseOccOptionSymbol(" msft 260717p00425000 ")).toEqual({
      underlying: "MSFT",
      expiration: "2026-07-17",
      optionType: "put",
      strike: 425,
    });
  });

  it("returns null for unsupported or malformed symbols", () => {
    expect(parseOccOptionSymbol("AAPL")).toBeNull();
    expect(parseOccOptionSymbol("AAPL260619X00195000")).toBeNull();
    expect(parseOccOptionSymbol("AAPL260619C00000000")).toBeNull();
  });
});

describe("findBestOptionsContract", () => {
  it("rejects option contracts wider than the configured max spread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T14:30:00.000Z"));
    alpaca.options.getExpirations.mockResolvedValue(["2026-07-17"]);
    alpaca.options.getChain.mockResolvedValue({
      calls: [{ symbol: "AAPL260717C00195000", strike: 195 }],
      puts: [],
    });
    alpaca.marketData.getSnapshot.mockResolvedValue({
      latest_trade: { price: 195 },
      latest_quote: { bid_price: 194.5, ask_price: 195.5 },
    });
    alpaca.options.getSnapshot.mockResolvedValue({
      greeks: { delta: 0.45 },
      latest_quote: { bid_price: 1.0, ask_price: 1.1 },
    });
    const ctx = {
      config: {
        ...DEFAULT_CONFIG,
        options_enabled: true,
        options_min_dte: 14,
        options_max_dte: 90,
        options_min_delta: 0.3,
        options_max_delta: 0.7,
        options_target_delta: 0.45,
        options_max_pct_per_trade: 0.02,
        options_max_spread_pct: 5,
      },
      env: {},
      log: vi.fn(),
    } as never;

    await expect(findBestOptionsContract(ctx, "AAPL", "bullish", 10_000)).resolves.toBeNull();
    vi.useRealTimers();
  });
});
