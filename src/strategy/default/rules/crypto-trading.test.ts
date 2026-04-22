import { describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../../../core/types";
import { runCryptoTrading } from "./crypto-trading";

describe("crypto trading", () => {
  it("treats compact crypto position symbols as already held", async () => {
    const buy = vi.fn(async () => true);

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["BTC/USD", "ETH/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 10,
        crypto_max_position_value: 1000,
      },
      signals: [
        {
          symbol: "BTC/USD",
          isCrypto: true,
          sentiment: 0.4,
          momentum: 3,
        },
      ],
      llm: null,
      log: () => {},
      trackLLMCost: () => 0,
      sleep: async () => {},
      broker: {
        buy,
        sell: vi.fn(async () => true),
        getAccount: vi.fn(async () => ({ cash: 10000 })),
      },
      state: {
        get: () => undefined,
        set: () => {},
      },
    } as never;

    await runCryptoTrading(
      ctx,
      [
        {
          symbol: "BTCUSD",
          asset_class: "crypto",
          avg_entry_price: 100,
          current_price: 100,
          market_value: 1000,
          unrealized_pl: 0,
        },
      ] as never
    );

    expect(buy).not.toHaveBeenCalled();
  });

  it("promotes cached WAIT crypto research when confidence is actionable", async () => {
    const buy = vi.fn(async () => true);
    const cachedResearch: ResearchResult = {
      symbol: "BTC/USD",
      verdict: "WAIT",
      confidence: 0.6,
      entry_quality: "fair",
      reasoning: "Momentum is constructive and pullbacks are shallow.",
      red_flags: [],
      catalysts: ["Strong trend"],
      timestamp: Date.now(),
    };

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["BTC/USD", "ETH/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 25,
        crypto_max_position_value: 5000,
      },
      signals: [
        {
          symbol: "BTC/USD",
          isCrypto: true,
          sentiment: 0.4,
          momentum: 3,
        },
      ],
      llm: null,
      log: () => {},
      trackLLMCost: () => 0,
      sleep: async () => {},
      broker: {
        buy,
        sell: vi.fn(async () => true),
        getAccount: vi.fn(async () => ({ cash: 10000 })),
      },
      state: {
        get: (key: string) => (key === "cryptoResearch_BTC/USD" ? cachedResearch : undefined),
        set: () => {},
      },
    } as never;

    await runCryptoTrading(ctx, [] as never);

    expect(buy).toHaveBeenCalledWith(
      "BTC/USD",
      1500,
      "Crypto momentum (promoted WAIT): Momentum is constructive and pullbacks are shallow."
    );
  });
});
