import { describe, expect, it, vi } from "vitest";
import type { Account, Position, PositionEntry } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { selectExits } from "./exits";

function makeCtx(entry?: PositionEntry): StrategyContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      take_profit_pct: 20,
      stop_loss_pct: 8,
      trailing_stop_enabled: true,
      trailing_stop_activation_pct: 6,
      trailing_stop_drawdown_pct: 3,
      breakeven_stop_enabled: true,
      breakeven_stop_activation_pct: 4,
      breakeven_stop_buffer_pct: 0.25,
      sentiment_reversal_exit_enabled: true,
      sentiment_reversal_min_hold_minutes: 60,
      sentiment_reversal_loss_pct: 1.5,
      sentiment_reversal_threshold: -0.25,
      sentiment_reversal_min_sources: 1,
      stale_position_enabled: false,
      stale_min_hold_hours: 24,
      stale_loss_exit_pct: 2,
      early_loss_exit_enabled: true,
      early_loss_exit_pct: 2.5,
      early_loss_exit_max_hold_minutes: 90,
    },
    log: vi.fn(),
    state: {
      get: vi.fn(),
      set: vi.fn(),
    },
    positionEntries: entry ? { AAPL: entry } : {},
    signals: [],
  } as unknown as StrategyContext;
}

function position(currentPrice: number): Position {
  const qty = 10;
  const entryPrice = 100;
  return {
    symbol: "AAPL",
    asset_class: "us_equity",
    avg_entry_price: entryPrice,
    current_price: currentPrice,
    market_value: currentPrice * qty,
    unrealized_pl: (currentPrice - entryPrice) * qty,
  } as Position;
}

const account = { cash: 10_000, equity: 10_000 } as Account;

describe("selectExits trailing protections", () => {
  it("updates peak price while the position is still open", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 102,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);

    const exits = selectExits(ctx, [position(105)], account);

    expect(exits).toHaveLength(0);
    expect(entry.peak_price).toBe(105);
  });

  it("updates trough price while the position is still open", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 102,
      trough_price: 99,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);

    const exits = selectExits(ctx, [position(98)], account);

    expect(exits).toHaveLength(0);
    expect(entry.trough_price).toBe(98);
  });

  it("recovers missing position entry tracking so trailing protection can work later", () => {
    const ctx = makeCtx();

    const firstPass = selectExits(ctx, [position(110)], account);

    expect(firstPass).toHaveLength(0);
    expect(ctx.positionEntries.AAPL).toEqual(
      expect.objectContaining({
        symbol: "AAPL",
        entry_price: 100,
        peak_price: 110,
        trough_price: 100,
        entry_sources: ["broker_position_recovery"],
      })
    );

    const secondPass = selectExits(ctx, [position(106)], account);

    expect(secondPass).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Trailing stop"),
      }),
    ]);
  });

  it("exits early when a badly slipped entry starts losing inside the bad-fill window", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 10 * 60 * 1000,
      entry_price: 100,
      entry_quote_mid: 99.25,
      entry_slippage_pct: 0.7557,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 100,
      trough_price: 100,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.bad_fill_exit_enabled = true;
    ctx.config.bad_fill_max_slippage_pct = 0.5;
    ctx.config.bad_fill_loss_pct = 0.5;
    ctx.config.bad_fill_max_hold_minutes = 30;

    const exits = selectExits(ctx, [position(99.4)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Bad fill early exit"),
      }),
    ]);
  });

  it("does not bad-fill exit after the bad-fill window has passed", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 45 * 60 * 1000,
      entry_price: 100,
      entry_quote_mid: 99.25,
      entry_slippage_pct: 0.7557,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 100,
      trough_price: 100,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.bad_fill_exit_enabled = true;
    ctx.config.bad_fill_max_slippage_pct = 0.5;
    ctx.config.bad_fill_loss_pct = 0.5;
    ctx.config.bad_fill_max_hold_minutes = 30;

    const exits = selectExits(ctx, [position(99.4)], account);

    expect(exits).toHaveLength(0);
  });

  it("cuts an early loser before the normal stop loss", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 45 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 100,
      trough_price: 100,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stop_loss_pct = 8;
    ctx.config.early_loss_exit_enabled = true;
    ctx.config.early_loss_exit_pct = 2.5;
    ctx.config.early_loss_exit_max_hold_minutes = 90;

    const exits = selectExits(ctx, [position(97.4)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Early loss exit"),
      }),
    ]);
  });

  it("does not early-loss exit after the early loss window has passed", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 120 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 100,
      trough_price: 100,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stop_loss_pct = 8;
    ctx.config.early_loss_exit_enabled = true;
    ctx.config.early_loss_exit_pct = 2.5;
    ctx.config.early_loss_exit_max_hold_minutes = 90;

    const exits = selectExits(ctx, [position(97.4)], account);

    expect(exits).toHaveLength(0);
  });

  it("exits after an activated winner gives back too much from peak", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 110,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);

    const exits = selectExits(ctx, [position(106)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Trailing stop"),
      }),
    ]);
  });

  it("protects breakeven after a winner falls back near entry", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 105,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.trailing_stop_enabled = false;
    ctx.config.profit_lock_stop_enabled = false;

    const exits = selectExits(ctx, [position(100.2)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Breakeven stop"),
      }),
    ]);
  });

  it("locks a small winner before the normal breakeven activation window", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 103.5,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.breakeven_stop_activation_pct = 4;
    ctx.config.profit_lock_stop_enabled = true;
    ctx.config.profit_lock_activation_pct = 3;
    ctx.config.profit_lock_floor_pct = 0.5;

    const exits = selectExits(ctx, [position(100.4)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Profit lock stop"),
      }),
    ]);
  });

  it("keeps the profit-lock floor active after the breakeven activation window", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 105,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.trailing_stop_enabled = false;
    ctx.config.breakeven_stop_activation_pct = 4;
    ctx.config.breakeven_stop_buffer_pct = 0.25;
    ctx.config.profit_lock_stop_enabled = true;
    ctx.config.profit_lock_activation_pct = 3;
    ctx.config.profit_lock_floor_pct = 0.5;

    const exits = selectExits(ctx, [position(100.4)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Profit lock stop"),
      }),
    ]);
  });

  it("does not profit-lock before the small winner activation threshold", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 102.5,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.profit_lock_activation_pct = 3;

    const exits = selectExits(ctx, [position(100.4)], account);

    expect(exits).toHaveLength(0);
  });

  it("does not profit-lock when the dedicated control is disabled", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now(),
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 103.5,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.breakeven_stop_activation_pct = 4;
    ctx.config.profit_lock_stop_enabled = false;

    const exits = selectExits(ctx, [position(100.4)], account);

    expect(exits).toHaveLength(0);
  });

  it("exits stale small losers after the minimum hold period", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 25 * 60 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stale_position_enabled = true;
    ctx.config.stale_min_hold_hours = 24;
    ctx.config.stale_loss_exit_pct = 2;

    const exits = selectExits(ctx, [position(97.5)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Timed loss exit"),
      }),
    ]);
  });

  it("does not time-exit small losers before the minimum hold period", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 23 * 60 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stale_position_enabled = true;
    ctx.config.stale_min_hold_hours = 24;
    ctx.config.stale_loss_exit_pct = 2;

    const exits = selectExits(ctx, [position(97.5)], account);

    expect(exits).toHaveLength(0);
  });

  it("exits mid-hold positions that fail to gain while social volume decays", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 51 * 60 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 100,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 102,
      trough_price: 99,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stale_position_enabled = true;
    ctx.config.stale_min_hold_hours = 24;
    ctx.config.stale_mid_hold_days = 2;
    ctx.config.stale_mid_min_gain_pct = 3;
    ctx.config.stale_max_hold_days = 3;
    ctx.config.stale_min_gain_pct = 5;
    ctx.config.stale_social_volume_decay = 0.3;
    vi.mocked(ctx.state.get).mockReturnValue({ AAPL: { volume: 20 } });

    const exits = selectExits(ctx, [position(101)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Mid-hold momentum failed"),
      }),
    ]);
  });

  it("does not treat missing social volume snapshots as volume decay", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 51 * 60 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 100,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 102,
      trough_price: 99,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stale_position_enabled = true;
    ctx.config.stale_min_hold_hours = 24;
    ctx.config.stale_mid_hold_days = 2;
    ctx.config.stale_mid_min_gain_pct = 3;
    ctx.config.stale_max_hold_days = 3;
    ctx.config.stale_min_gain_pct = 5;
    ctx.config.stale_social_volume_decay = 0.3;
    vi.mocked(ctx.state.get).mockReturnValue({});

    const exits = selectExits(ctx, [position(101)], account);

    expect(exits).toHaveLength(0);
    expect(ctx.state.set).toHaveBeenCalledWith(
      "stalenessAnalysis",
      expect.objectContaining({
        AAPL: expect.objectContaining({
          isStale: false,
          reason: expect.stringContaining("OK"),
        }),
      })
    );
  });

  it("exits a small loser when fresh signals reverse bearish after the minimum hold", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.stop_loss_pct = 8;
    ctx.signals = [
      {
        symbol: "AAPL",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: -0.4,
        raw_sentiment: 0.4,
        volume: 8,
        freshness: 1,
        source_weight: 1,
        reason: "bearish reversal",
        timestamp: Date.now(),
      },
    ];

    const exits = selectExits(ctx, [position(98.2)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Sentiment reversal loss exit"),
      }),
    ]);
  });

  it("treats positive-strength raw sentiment as bearish when signed sentiment is negative", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.signals = [
      {
        symbol: "AAPL",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: -0.35,
        raw_sentiment: 0.35,
        volume: 3,
        freshness: 1,
        source_weight: 1,
        reason: "negative discussion",
        timestamp: Date.now(),
      },
    ];

    const exits = selectExits(ctx, [position(98.2)], account);

    expect(exits[0]?.reason).toContain("Sentiment reversal loss exit");
  });

  it("requires independent providers for sentiment reversal source confirmation", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.sentiment_reversal_min_sources = 2;
    ctx.signals = [
      {
        symbol: "AAPL",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: -0.35,
        raw_sentiment: 0.35,
        volume: 3,
        freshness: 1,
        source_weight: 1,
        reason: "negative discussion",
        timestamp: Date.now(),
      },
      {
        symbol: "AAPL",
        source: "reddit",
        source_detail: "reddit_wallstreetbets",
        sentiment: -0.4,
        raw_sentiment: 0.4,
        volume: 3,
        freshness: 1,
        source_weight: 1,
        reason: "negative discussion",
        timestamp: Date.now(),
      },
    ];

    const sameProviderExits = selectExits(ctx, [position(98.2)], account);
    expect(sameProviderExits).toHaveLength(0);

    ctx.signals.push({
      symbol: "AAPL",
      source: "stocktwits",
      source_detail: "stocktwits",
      sentiment: -0.45,
      raw_sentiment: 0.45,
      volume: 4,
      freshness: 1,
      source_weight: 1,
      reason: "bearish posts",
      timestamp: Date.now(),
    });

    const independentProviderExits = selectExits(ctx, [position(98.2)], account);
    expect(independentProviderExits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Sentiment reversal loss exit"),
      }),
    ]);
  });

  it("protects a small winner when fresh signals reverse bearish after the minimum hold", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 90 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101.2,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.profit_lock_floor_pct = 0.5;
    ctx.signals = [
      {
        symbol: "AAPL",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: -0.45,
        raw_sentiment: 0.45,
        volume: 8,
        freshness: 1,
        source_weight: 1,
        reason: "bearish reversal",
        timestamp: Date.now(),
      },
    ];

    const exits = selectExits(ctx, [position(100.7)], account);

    expect(exits).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        reason: expect.stringContaining("Sentiment reversal profit exit"),
      }),
    ]);
  });

  it("does not sentiment-exit before the reversal minimum hold", () => {
    const entry: PositionEntry = {
      symbol: "AAPL",
      entry_time: Date.now() - 45 * 60 * 1000,
      entry_price: 100,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 101,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.signals = [
      {
        symbol: "AAPL",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: -0.5,
        raw_sentiment: -0.5,
        volume: 8,
        freshness: 1,
        source_weight: 1,
        reason: "bearish reversal",
        timestamp: Date.now(),
      },
    ];

    const exits = selectExits(ctx, [position(98.2)], account);

    expect(exits).toHaveLength(0);
  });

  it("does not emit option exits from strategy exits because harness handles them every tick", () => {
    const entry: PositionEntry = {
      symbol: "AAPL260619C00195000",
      entry_time: Date.now(),
      entry_price: 1,
      entry_sentiment: 0.8,
      entry_social_volume: 10,
      entry_sources: ["test"],
      entry_reason: "test",
      peak_price: 1,
      peak_sentiment: 0.8,
    };
    const ctx = makeCtx(entry);
    ctx.config.options_enabled = true;

    const optionPosition = {
      ...position(2.5),
      symbol: "AAPL260619C00195000",
      asset_class: "us_option",
      avg_entry_price: 1,
      current_price: 2.5,
    } as Position;

    const exits = selectExits(ctx, [optionPosition], account);

    expect(exits).toHaveLength(0);
  });
});
