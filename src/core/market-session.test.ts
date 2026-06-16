import { describe, expect, it } from "vitest";
import {
  buildMarketSessionState,
  getClockNowMs,
  shouldClearPremarketPlan,
  shouldCreatePremarketPlan,
  shouldExecutePremarketPlan,
  shouldRunInterval,
} from "./market-session";
import type { MarketClock } from "./types";

function createClock(overrides: Partial<MarketClock> = {}): MarketClock {
  return {
    timestamp: "2026-04-24T13:29:00.000Z",
    is_open: false,
    next_open: "2026-04-24T13:30:00.000Z",
    next_close: "2026-04-24T20:00:00.000Z",
    ...overrides,
  };
}

describe("market session planner", () => {
  it("checks interval eligibility", () => {
    expect(shouldRunInterval(10_000, 5_000, 5_000)).toBe(true);
    expect(shouldRunInterval(9_999, 5_000, 5_000)).toBe(false);
  });

  it("falls back when broker clock timestamp is invalid", () => {
    expect(getClockNowMs(createClock({ timestamp: "invalid" }), 123)).toBe(123);
  });

  it("creates premarket plans inside the configured window", () => {
    const clock = createClock();
    const session = buildMarketSessionState({
      clock,
      nowMs: Date.parse(clock.timestamp),
      lastKnownNextOpenMs: Date.parse(clock.next_open),
      lastClockIsOpen: false,
      marketOpenExecuteWindowMinutes: 2,
    });

    expect(
      shouldCreatePremarketPlan({
        clock,
        session,
        hasPremarketPlan: false,
        premarketPlanWindowMinutes: 5,
        lastPremarketPlanDayEt: null,
        currentEtDay: "2026-04-24",
      })
    ).toBe(true);
  });

  it("executes premarket plans when market just opened", () => {
    const clock = createClock({ is_open: true, timestamp: "2026-04-24T13:30:05.000Z" });
    const session = buildMarketSessionState({
      clock,
      nowMs: Date.parse(clock.timestamp),
      lastKnownNextOpenMs: Date.parse("2026-04-24T13:30:00.000Z"),
      lastClockIsOpen: false,
      marketOpenExecuteWindowMinutes: 2,
    });

    expect(shouldExecutePremarketPlan({ hasPremarketPlan: true, session })).toBe(true);
  });

  it("clears stale premarket plans from previous ET days", () => {
    expect(
      shouldClearPremarketPlan({
        hasPremarketPlan: true,
        lastPremarketPlanDayEt: "2026-04-23",
        currentEtDay: "2026-04-24",
      })
    ).toBe(true);
  });
});
