import { describe, expect, it, vi } from "vitest";
import type { Account, ResearchResult, Signal } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { buildCryptoResearchPrompt, runCryptoTrading, sanitizeCryptoResearchResult } from "./crypto-trading";

function cryptoSignal(sentiment = 0.4): Signal {
  return {
    symbol: "SOL/USD",
    source: "crypto",
    source_detail: "crypto_momentum",
    sentiment,
    raw_sentiment: sentiment,
    volume: 10,
    freshness: 1,
    source_weight: 1,
    reason: "weak crypto tape",
    timestamp: Date.now(),
    isCrypto: true,
    momentum: 3,
  };
}

function cryptoSignalWithMomentum(momentum: number): Signal {
  return {
    ...cryptoSignal(),
    momentum,
  };
}

function equitySignal(symbol: string, sentiment = 0.35): Signal {
  return {
    symbol,
    source: "stocktwits",
    source_detail: "stocktwits",
    sentiment,
    raw_sentiment: sentiment,
    volume: 10,
    freshness: 1,
    source_weight: 1,
    reason: "weak equity tape",
    timestamp: Date.now(),
  };
}

function weakMarketRegimeSignals(): Signal[] {
  return [cryptoSignal(), equitySignal("AAPL"), equitySignal("JPM")];
}

function bearishCryptoSignal(): Signal {
  return {
    ...cryptoSignal(-0.45),
    raw_sentiment: 0.45,
    reason: "bearish crypto reversal",
  };
}

function research(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    symbol: "SOL/USD",
    verdict: "BUY",
    confidence: 0.85,
    entry_quality: "good",
    reasoning: "momentum",
    red_flags: [],
    catalysts: ["breakout"],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeCtx(cachedResearch: ResearchResult): StrategyContext {
  const state = new Map<string, unknown>([["cryptoResearch_SOL/USD", cachedResearch]]);
  return {
    config: {
      ...DEFAULT_CONFIG,
      crypto_enabled: true,
      crypto_symbols: ["SOL/USD"],
      crypto_max_positions: 3,
      crypto_max_position_value: 1_000,
      market_regime_enabled: true,
      regime_low_threshold: 0.5,
      regime_position_size_reduction: 0.45,
      exceptional_entry_confidence: 0.9,
      position_size_pct_of_cash: 20,
      min_entry_signal_sources: 1,
      min_entry_catalysts: 1,
      max_entry_red_flags: 0,
      min_entry_quality: "good",
      stale_position_enabled: true,
      stale_min_hold_hours: 24,
      stale_loss_exit_pct: 2,
      trailing_stop_enabled: true,
      trailing_stop_activation_pct: 6,
      trailing_stop_drawdown_pct: 3,
      breakeven_stop_enabled: true,
      breakeven_stop_activation_pct: 4,
      breakeven_stop_buffer_pct: 0.25,
      profit_lock_stop_enabled: true,
      profit_lock_activation_pct: 3,
      profit_lock_floor_pct: 0.5,
    },
    signals: [cryptoSignal()],
    positionEntries: {},
    state: {
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    },
    broker: {
      getAccount: vi.fn().mockResolvedValue({ cash: 10_000, equity: 10_000 } as Account),
      buy: vi.fn().mockResolvedValue(true),
      sell: vi.fn().mockResolvedValue(true),
    },
    log: vi.fn(),
  } as unknown as StrategyContext;
}

function cryptoPosition(currentPrice: number, entryPrice = 100, symbol = "SOL/USD") {
  const qty = 2;
  return {
    symbol,
    asset_class: "crypto",
    avg_entry_price: entryPrice,
    current_price: currentPrice,
    lastday_price: entryPrice,
    market_value: currentPrice * qty,
    unrealized_pl: (currentPrice - entryPrice) * qty,
  } as never;
}

describe("runCryptoTrading market regime gate", () => {
  it("formats crypto momentum as a percent without multiplying percent inputs again", () => {
    const prompt = buildCryptoResearchPrompt({
      symbol: "SOL/USD",
      price: 150,
      dailyChangePct: 3.4,
      momentumPct: 3.4,
      sentiment: 0.68,
      minMomentumPct: 2,
      maxMomentumPct: 12,
    });

    expect(prompt).toContain("MOMENTUM: 3.40%");
    expect(prompt).toContain("24H CHANGE: 3.40%");
    expect(prompt).toContain("Momentum threshold: at least 2.00%");
    expect(prompt).not.toContain("340%");
    expect(prompt).toContain("price/volume momentum can be the entry thesis");
  });

  it("sanitizes malformed crypto research before it can become an entry candidate", () => {
    const result = sanitizeCryptoResearchResult(
      {
        verdict: "MOON",
        confidence: 7,
        entry_quality: "legendary",
        reasoning: "z".repeat(1_200),
        red_flags: ["thin liquidity", 100, "late pump"],
        catalysts: Array.from({ length: 12 }, (_, index) => `catalyst-${index}`),
      },
      "SOL/USD",
      789
    );

    expect(result).toEqual(
      expect.objectContaining({
        symbol: "SOL/USD",
        verdict: "WAIT",
        confidence: 0,
        entry_quality: "poor",
        red_flags: ["thin liquidity", "late pump"],
        timestamp: 789,
      })
    );
    expect(result.reasoning).toHaveLength(1_000);
    expect(result.catalysts).toHaveLength(10);
  });

  it("skips ordinary crypto buys in weak market regime", async () => {
    const ctx = makeCtx(research());
    ctx.signals = weakMarketRegimeSignals();

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "Crypto",
      "buy_skipped_market_regime",
      expect.objectContaining({
        symbol: "SOL/USD",
        reason: "weak_market_regime",
        average_sentiment: 0.3667,
      })
    );
  });

  it("skips crypto buys during recent sell cooldown", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    (ctx.state as { get: (key: string) => unknown }).get = vi.fn((key: string) => {
      if (key === "recentSells") {
        return {
          "SOL/USD": { symbol: "SOL/USD", sold_at: Date.now(), reason: "Crypto stop loss" },
        };
      }
      if (key === "cryptoResearch_SOL/USD") return research({ confidence: 0.95, entry_quality: "excellent" });
      return undefined;
    });

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "Crypto",
      "buy_skipped_recent_sell_cooldown",
      expect.objectContaining({
        symbol: "SOL/USD",
        symbol_key: "SOL/USD",
      })
    );
  });

  it("skips crypto buys below the configured momentum threshold", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.config.crypto_momentum_threshold = 2;
    ctx.signals = [cryptoSignalWithMomentum(0.01)];

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "Crypto",
      "buy_skipped_low_momentum",
      expect.objectContaining({
        symbol: "SOL/USD",
        momentum_pct: 1,
        threshold: 2,
      })
    );
  });

  it("skips crypto buys when momentum is overextended", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.config.crypto_momentum_threshold = 2;
    ctx.config.crypto_max_momentum_pct = 12;
    ctx.signals = [cryptoSignalWithMomentum(0.15)];

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "Crypto",
      "buy_skipped_overextended_momentum",
      expect.objectContaining({
        symbol: "SOL/USD",
        momentum_pct: 15,
        max_momentum_pct: 12,
      })
    );
  });

  it("allows disabling the crypto max momentum guard", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.config.crypto_momentum_threshold = 2;
    ctx.config.crypto_max_momentum_pct = 0;
    ctx.signals = [cryptoSignalWithMomentum(0.15)];

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).toHaveBeenCalled();
  });

  it("uses the configured max crypto position count instead of a fixed cap", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.config.crypto_symbols = ["BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD"];
    ctx.config.crypto_max_positions = 4;
    ctx.config.market_regime_enabled = false;
    ctx.signals = [cryptoSignalWithMomentum(0.03)];

    await runCryptoTrading(ctx, [
      cryptoPosition(100, 100, "BTC/USD"),
      cryptoPosition(100, 100, "ETH/USD"),
      cryptoPosition(100, 100, "AVAX/USD"),
    ]);

    expect(ctx.broker.buy).toHaveBeenCalledWith(
      "SOL/USD",
      expect.any(Number),
      "Crypto momentum: momentum",
      expect.objectContaining({ entry_path: "crypto_momentum" })
    );
  });

  it("defaults crypto position capacity to three when unset", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.config.crypto_symbols = ["BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD"];
    ctx.config.crypto_max_positions = undefined as never;
    ctx.config.market_regime_enabled = false;
    ctx.signals = [cryptoSignalWithMomentum(0.03)];

    await runCryptoTrading(ctx, [
      cryptoPosition(100, 100, "BTC/USD"),
      cryptoPosition(100, 100, "ETH/USD"),
      cryptoPosition(100, 100, "AVAX/USD"),
    ]);

    expect(ctx.broker.buy).not.toHaveBeenCalled();
  });

  it("allows exceptional excellent crypto buys in weak market regime with reduced size", async () => {
    const ctx = makeCtx(research({ confidence: 0.95, entry_quality: "excellent" }));
    ctx.signals = weakMarketRegimeSignals();

    await runCryptoTrading(ctx, []);

    expect(ctx.broker.buy).toHaveBeenCalledWith(
      "SOL/USD",
      855,
      "Crypto momentum: momentum",
      expect.objectContaining({
        entry_path: "crypto_momentum",
        confidence: 0.95,
        entry_quality: "excellent",
        entry_selection_score: expect.any(Number),
        source_count: 1,
        size_multiplier: 0.45,
      })
    );
  });

  it("trails profitable crypto positions from tracked peaks", async () => {
    const ctx = makeCtx(research());
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 112,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(107)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith("SOL/USD", expect.stringContaining("Crypto trailing stop"));
  });

  it("profit-locks small crypto winners before breakeven activation", async () => {
    const ctx = makeCtx(research());
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 103.5,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(100.4)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith("SOL/USD", expect.stringContaining("Crypto profit lock stop"));
  });

  it("keeps crypto profit-lock active after breakeven activation", async () => {
    const ctx = makeCtx(research());
    ctx.config.trailing_stop_enabled = false;
    ctx.config.breakeven_stop_activation_pct = 4;
    ctx.config.breakeven_stop_buffer_pct = 0.25;
    ctx.config.profit_lock_stop_enabled = true;
    ctx.config.profit_lock_activation_pct = 3;
    ctx.config.profit_lock_floor_pct = 0.5;
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 105,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(100.4)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith("SOL/USD", expect.stringContaining("Crypto profit lock stop"));
  });

  it("cuts early crypto losers before the normal crypto stop loss", async () => {
    const ctx = makeCtx(research());
    ctx.config.crypto_stop_loss_pct = 5;
    ctx.config.early_loss_exit_enabled = true;
    ctx.config.early_loss_exit_pct = 2.5;
    ctx.config.early_loss_exit_max_hold_minutes = 90;
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now() - 45 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 100,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(97.4)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith("SOL/USD", expect.stringContaining("Crypto early loss exit"));
  });

  it("protects small crypto winners when fresh signals reverse bearish after the minimum hold", async () => {
    const ctx = makeCtx(research());
    ctx.signals = [bearishCryptoSignal()];
    ctx.config.sentiment_reversal_exit_enabled = true;
    ctx.config.sentiment_reversal_min_hold_minutes = 60;
    ctx.config.sentiment_reversal_threshold = -0.25;
    ctx.config.sentiment_reversal_min_sources = 1;
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101.2,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(100.7)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith(
      "SOL/USD",
      expect.stringContaining("Crypto sentiment reversal profit exit")
    );
  });

  it("cuts small crypto losers when fresh signals reverse bearish after the minimum hold", async () => {
    const ctx = makeCtx(research());
    ctx.signals = [bearishCryptoSignal()];
    ctx.config.crypto_stop_loss_pct = 5;
    ctx.config.stale_position_enabled = false;
    ctx.config.sentiment_reversal_exit_enabled = true;
    ctx.config.sentiment_reversal_min_hold_minutes = 60;
    ctx.config.sentiment_reversal_loss_pct = 1.5;
    ctx.config.sentiment_reversal_threshold = -0.25;
    ctx.config.sentiment_reversal_min_sources = 1;
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(98.2)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith(
      "SOL/USD",
      expect.stringContaining("Crypto sentiment reversal loss exit")
    );
  });

  it("requires independent providers for crypto sentiment reversal confirmation", async () => {
    const ctx = makeCtx(research());
    ctx.config.sentiment_reversal_exit_enabled = true;
    ctx.config.sentiment_reversal_min_hold_minutes = 60;
    ctx.config.sentiment_reversal_threshold = -0.25;
    ctx.config.sentiment_reversal_min_sources = 2;
    ctx.signals = [
      { ...bearishCryptoSignal(), source: "reddit", source_detail: "reddit_crypto" },
      { ...bearishCryptoSignal(), source: "reddit", source_detail: "reddit_solana" },
    ];
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101.2,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(100.7)]);
    expect(ctx.broker.sell).not.toHaveBeenCalledWith(
      "SOL/USD",
      expect.stringContaining("Crypto sentiment reversal profit exit")
    );

    ctx.signals.push({ ...bearishCryptoSignal(), source: "stocktwits", source_detail: "stocktwits" });
    await runCryptoTrading(ctx, [cryptoPosition(100.7)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith(
      "SOL/USD",
      expect.stringContaining("Crypto sentiment reversal profit exit")
    );
  });

  it("time-exits stale crypto losers after the minimum hold period", async () => {
    const ctx = makeCtx(research());
    ctx.positionEntries["SOL/USD"] = {
      symbol: "SOL/USD",
      entry_time: Date.now() - 25 * 60 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };

    await runCryptoTrading(ctx, [cryptoPosition(97.5)]);

    expect(ctx.broker.sell).toHaveBeenCalledWith("SOL/USD", expect.stringContaining("Crypto timed loss exit"));
  });
});
