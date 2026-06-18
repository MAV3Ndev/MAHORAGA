import { describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import { researchCrypto, runCryptoTrading } from "./crypto-trading";

vi.mock("../../../providers/alpaca", () => ({
  createAlpacaProviders: vi.fn(),
}));

describe("crypto trading", () => {
  it("retries malformed crypto research JSON and requests json_object output", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => ({
          latest_trade: { price: 65000 },
          daily_bar: { c: 66000 },
          prev_daily_bar: { c: 64000 },
        })),
      },
    } as never);

    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"verdict":"WAIT","confidence":0.6,"entry_quality":"fair","reasoning":"Momentum',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content:
          '{"verdict":"BUY","confidence":0.72,"entry_quality":"good","reasoning":"Momentum is constructive.","red_flags":[],"catalysts":["Trend strength"]}',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "test-model",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: { complete } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toMatchObject({
      symbol: "BTC/USD",
      verdict: "BUY",
      confidence: 0.72,
      entry_quality: "good",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_object" },
    });
  });

  it("falls back to heuristic crypto research after repeated parse failures", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => null),
      },
    } as never);

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "test-model",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: {
          complete: vi.fn(async () => ({
            content: '{"verdict":"WAIT","confidence":0.6,"entry_quality":"fair","reasoning":"Broken',
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          })),
        } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toMatchObject({
      symbol: "BTC/USD",
      verdict: "BUY",
      entry_quality: "fair",
    });
    expect(result?.reasoning).toContain("malformed JSON");
    expect(result?.red_flags).toContain(
      "Fallback crypto research used because the LLM was unavailable or rate-limited."
    );
  });

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
        risk_per_trade_pct: 0.75,
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

    await runCryptoTrading(ctx, [
      {
        symbol: "BTCUSD",
        asset_class: "crypto",
        avg_entry_price: 100,
        current_price: 100,
        market_value: 1000,
        unrealized_pl: 0,
      },
    ] as never);

    expect(buy).not.toHaveBeenCalled();
  });

  it("does not rebuy crypto while a submitted buy is still pending", async () => {
    const buy = vi.fn(async () => true);
    const cachedResearch: ResearchResult = {
      symbol: "POL/USD",
      verdict: "BUY",
      confidence: 0.75,
      entry_quality: "good",
      reasoning: "Momentum is constructive.",
      red_flags: [],
      catalysts: ["Trend strength"],
      timestamp: Date.now(),
    };
    const state: Record<string, unknown> = {
      cryptoPendingBuys: { POLUSD: Date.now() },
      "cryptoResearch_POL/USD": cachedResearch,
    };

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["POL/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 25,
        risk_per_trade_pct: 0.75,
        crypto_max_position_value: 5000,
      },
      signals: [
        {
          symbol: "POL/USD",
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
        get: (key: string) => state[key],
        set: (key: string, value: unknown) => {
          state[key] = value;
        },
      },
      positionEntries: {},
    } as never;

    await runCryptoTrading(ctx, [] as never);

    expect(buy).not.toHaveBeenCalled();
  });

  it("promotes cached WAIT crypto research when confidence is actionable", async () => {
    const buy = vi.fn(async () => true);
    const positionEntries: Record<string, ResearchResult | unknown> = {};
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
        risk_per_trade_pct: 0.75,
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
      positionEntries,
    } as never;

    await runCryptoTrading(ctx, [] as never);

    expect(buy).toHaveBeenCalledWith(
      "BTC/USD",
      1500,
      "Crypto momentum (promoted WAIT): Momentum is constructive and pullbacks are shallow."
    );
    expect(positionEntries["BTC/USD"]).toBeTruthy();
    expect(positionEntries.BTCUSD).toBe(positionEntries["BTC/USD"]);
  });
});
