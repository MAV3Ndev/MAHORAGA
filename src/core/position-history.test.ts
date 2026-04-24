import { describe, expect, it } from "vitest";
import {
  buildPortfolioHistoryParams,
  buildPortfolioHistoryPayload,
  getPeriodStartMs,
  getPositionHistoryLimit,
  getPositionHistoryTimeframeCandidates,
  getPositionHistoryTimeframeMs,
  normalizePortfolioHistoryTimeframe,
} from "./position-history";

describe("position history helpers", () => {
  it("builds portfolio history params from URL search params", () => {
    const params = buildPortfolioHistoryParams(
      new URLSearchParams({
        period: "30D",
        timeframe: "1Hour",
        intraday_reporting: "market_hours",
      })
    );

    expect(params).toEqual({
      period: "30D",
      timeframe: "1D",
      intraday_reporting: "market_hours",
    });
  });

  it("falls back to extended hours for invalid intraday reporting", () => {
    const params = buildPortfolioHistoryParams(new URLSearchParams({ intraday_reporting: "invalid" }));

    expect(params.intraday_reporting).toBe("extended_hours");
  });

  it("builds portfolio history response payloads", () => {
    expect(
      buildPortfolioHistoryPayload({
        timestamp: [1_700_000_000, 1_700_000_060],
        equity: [10_000, 10_100],
        profit_loss: [0, 100],
        profit_loss_pct: [0, 0.01],
        base_value: 10_000,
        timeframe: "1Min",
      })
    ).toEqual({
      snapshots: [
        { timestamp: 1_700_000_000_000, equity: 10_000, pl: 0, pl_pct: 0 },
        { timestamp: 1_700_000_060_000, equity: 10_100, pl: 100, pl_pct: 0.01 },
      ],
      base_value: 10_000,
      timeframe: "1Min",
    });
  });

  it("skips incomplete portfolio history rows", () => {
    expect(
      buildPortfolioHistoryPayload({
        timestamp: [1_700_000_000, 1_700_000_060],
        equity: [10_000],
        profit_loss: [0, 100],
        profit_loss_pct: [0, 0.01],
        base_value: 10_000,
        timeframe: "1Min",
      }).snapshots
    ).toEqual([{ timestamp: 1_700_000_000_000, equity: 10_000, pl: 0, pl_pct: 0 }]);
  });

  it("normalizes hourly history to daily for 30 day windows", () => {
    expect(normalizePortfolioHistoryTimeframe("30D", "1Hour")).toBe("1D");
    expect(normalizePortfolioHistoryTimeframe("30D", "1H")).toBe("1D");
    expect(normalizePortfolioHistoryTimeframe("7D", "1Hour")).toBe("1Hour");
  });

  it("computes period start timestamps", () => {
    const now = Date.UTC(2026, 3, 24, 12, 0, 0);

    expect(getPeriodStartMs("5Min", now)).toBe(now - 5 * 60 * 1000);
    expect(getPeriodStartMs("1H", now)).toBe(now - 60 * 60 * 1000);
    expect(getPeriodStartMs("6H", now)).toBe(now - 6 * 60 * 60 * 1000);
    expect(getPeriodStartMs("1D", now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(getPeriodStartMs("unknown", now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });

  it("orders timeframe candidates and removes duplicates", () => {
    expect(getPositionHistoryTimeframeCandidates("1H", "1Min")).toEqual(["1Min", "5Min", "15Min"]);
    expect(getPositionHistoryTimeframeCandidates("7D", "1Hour")).toEqual(["1Hour", "15Min", "1Day"]);
    expect(getPositionHistoryTimeframeCandidates("30D", "1Day")).toEqual(["1Day", "1Hour"]);
  });

  it("returns request limits by period and timeframe", () => {
    expect(getPositionHistoryLimit("5Min", "1Min")).toBe(12);
    expect(getPositionHistoryLimit("1H", "1Min")).toBe(90);
    expect(getPositionHistoryLimit("1D", "5Min")).toBe(288);
    expect(getPositionHistoryLimit("30D", "1Hour")).toBe(500);
    expect(getPositionHistoryLimit("7D", "unknown")).toBe(240);
  });

  it("returns timeframe durations in milliseconds", () => {
    expect(getPositionHistoryTimeframeMs("1Min")).toBe(60_000);
    expect(getPositionHistoryTimeframeMs("5Min")).toBe(5 * 60_000);
    expect(getPositionHistoryTimeframeMs("15Min")).toBe(15 * 60_000);
    expect(getPositionHistoryTimeframeMs("1Hour")).toBe(60 * 60_000);
    expect(getPositionHistoryTimeframeMs("1Day")).toBe(24 * 60 * 60_000);
  });
});
