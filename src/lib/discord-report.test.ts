import { describe, expect, it } from "vitest";
import type { Account, Position } from "../providers/types";
import {
  createDailyReportBucket,
  formatDailyReportEmbed,
  getDailyReportBucketStart,
  getDailyReportDateKey,
  parseDailyReportTime,
  pruneDailyReportBuckets,
  shouldSendDailyReport,
  summarizeDailyActivity,
  summarizeDailyActivityWindow,
} from "./discord-report";

describe("discord report helpers", () => {
  function createAccount(overrides: Partial<Account> = {}): Account {
    return {
      id: "acct-1",
      account_number: "123456",
      status: "ACTIVE",
      currency: "USD",
      cash: 45000,
      buying_power: 90000,
      regt_buying_power: 90000,
      daytrading_buying_power: 0,
      equity: 125000,
      last_equity: 124000,
      long_market_value: 80000,
      short_market_value: 0,
      portfolio_value: 125000,
      pattern_day_trader: false,
      trading_blocked: false,
      transfers_blocked: false,
      account_blocked: false,
      multiplier: "2",
      shorting_enabled: false,
      maintenance_margin: 0,
      initial_margin: 0,
      daytrade_count: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function createPosition(overrides: Partial<Position> = {}): Position {
    return {
      asset_id: "asset-1",
      symbol: "NVDA",
      exchange: "NASDAQ",
      asset_class: "us_equity",
      avg_entry_price: 1100,
      qty: 5,
      side: "long",
      market_value: 6000,
      cost_basis: 5500,
      unrealized_pl: 500,
      unrealized_plpc: 0.09,
      unrealized_intraday_pl: 100,
      unrealized_intraday_plpc: 0.02,
      current_price: 1200,
      lastday_price: 1180,
      change_today: 0.016,
      ...overrides,
    };
  }

  it("parses HH:mm report times", () => {
    expect(parseDailyReportTime("09:30")).toBe(570);
    expect(parseDailyReportTime("23:59")).toBe(1439);
    expect(parseDailyReportTime("24:00")).toBeNull();
    expect(parseDailyReportTime("9:30")).toBeNull();
  });

  it("sends once per local day after the configured time", () => {
    const now = Date.parse("2026-04-22T01:05:00.000Z");
    expect(shouldSendDailyReport(now, null, "10:00", "Asia/Tokyo")).toBe(true);
    expect(shouldSendDailyReport(now, Date.parse("2026-04-22T00:30:00.000Z"), "10:00", "Asia/Tokyo")).toBe(false);
    expect(shouldSendDailyReport(now, null, "11:00", "Asia/Tokyo")).toBe(false);
  });

  it("creates stable local date keys", () => {
    expect(getDailyReportDateKey(Date.parse("2026-04-22T14:59:00.000Z"), "Asia/Tokyo")).toBe("2026-04-22");
    expect(getDailyReportDateKey(Date.parse("2026-04-22T15:01:00.000Z"), "Asia/Tokyo")).toBe("2026-04-23");
  });

  it("prunes expired buckets", () => {
    const staleStart = Date.parse("2026-04-20T11:00:00.000Z");
    const freshStart = Date.parse("2026-04-22T11:00:00.000Z");
    const buckets = {
      [String(staleStart)]: createDailyReportBucket(staleStart),
      [String(freshStart)]: createDailyReportBucket(freshStart),
    };

    const changed = pruneDailyReportBuckets(buckets, Date.parse("2026-04-22T12:00:00.000Z"), 24 * 60 * 60 * 1000);
    expect(changed).toBe(true);
    expect(Object.keys(buckets)).toEqual([String(freshStart)]);
  });

  it("summarizes buckets and formats an embed", () => {
    const now = Date.parse("2026-04-22T12:00:00.000Z");
    const tradeBucketStart = getDailyReportBucketStart(Date.parse("2026-04-22T11:40:00.000Z"));
    const tradeBucket = createDailyReportBucket(tradeBucketStart);
    tradeBucket.total_events = 3;
    tradeBucket.executed_buys = 1;
    tradeBucket.executed_sells = 1;
    tradeBucket.executed_buy_notional = 1200;
    tradeBucket.symbol_counts.NVDA = 2;
    tradeBucket.symbol_counts.TSLA = 1;
    tradeBucket.recent_trades.push(
      {
        side: "BUY",
        symbol: "NVDA",
        timestamp: Date.parse("2026-04-22T11:40:00.000Z"),
        notional: 1200,
        reason: "Momentum breakout",
      },
      {
        side: "SELL",
        symbol: "TSLA",
        timestamp: Date.parse("2026-04-22T11:20:00.000Z"),
        reason: "Stop loss",
      }
    );

    const researchBucketStart = getDailyReportBucketStart(Date.parse("2026-04-22T11:45:00.000Z"));
    const researchBucket = createDailyReportBucket(researchBucketStart);
    researchBucket.total_events = 5;
    researchBucket.data_gather_cycles = 1;
    researchBucket.analyst_runs = 1;
    researchBucket.premarket_plans = 1;
    researchBucket.breaking_news_alerts = 1;
    researchBucket.errors = 1;
    researchBucket.researched_signals = 1;
    researchBucket.buy_verdicts = 1;
    researchBucket.symbol_counts.NVDA = 1;
    researchBucket.symbol_counts.AMD = 1;

    const previousBucketStart = getDailyReportBucketStart(Date.parse("2026-04-21T11:40:00.000Z"));
    const previousBucket = createDailyReportBucket(previousBucketStart);
    previousBucket.total_events = 4;
    previousBucket.data_gather_cycles = 2;
    previousBucket.analyst_runs = 1;
    previousBucket.executed_buys = 2;
    previousBucket.executed_buy_notional = 2000;
    previousBucket.buy_verdicts = 2;
    previousBucket.skip_verdicts = 1;
    previousBucket.wait_verdicts = 1;
    previousBucket.researched_signals = 4;

    const buckets = {
      [String(tradeBucketStart)]: tradeBucket,
      [String(researchBucketStart)]: researchBucket,
      [String(previousBucketStart)]: previousBucket,
    };
    const summary = summarizeDailyActivity(buckets, now);
    const previousSummary = summarizeDailyActivityWindow(
      buckets,
      Date.parse("2026-04-20T12:00:00.000Z"),
      Date.parse("2026-04-21T12:00:00.000Z")
    );

    expect(summary.totalEvents).toBe(8);
    expect(summary.executedBuys).toBe(1);
    expect(summary.executedSells).toBe(1);
    expect(summary.buyVerdicts).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.topSymbols[0]).toEqual({ symbol: "NVDA", count: 3 });

    const embed = formatDailyReportEmbed(summary, createAccount(), [createPosition()], previousSummary);
    expect(embed.title).toBe("📊 MAHORAGA Daily Report");
    expect(embed.fields.some((field) => field.name === "Executed Trades")).toBe(true);
    expect(embed.fields.some((field) => field.name === "Recent Trades")).toBe(true);
    expect(embed.fields.find((field) => field.name === "Executed Trades")?.value).toContain("Δ BUY -1 / SELL +1");
    expect(embed.fields.find((field) => field.name === "Live Portfolio")?.value).toContain(
      "Day change +$1,000 / +0.81%"
    );
    expect(embed.fields.find((field) => field.name === "Bot Activity")?.value).toContain("Data cycles 1 (Δ -1)");
  });
});
