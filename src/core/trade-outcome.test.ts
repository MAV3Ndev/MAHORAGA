import { describe, expect, it } from "vitest";
import { calculateTradeOutcome } from "./trade-outcome";

describe("calculateTradeOutcome", () => {
  it("calculates winning realized outcomes from entry, exit, and quantity", () => {
    const result = calculateTradeOutcome({
      entryPrice: 100,
      exitPrice: 103,
      qty: 10,
      entryAt: "2026-01-01T10:00:00.000Z",
      nowMs: new Date("2026-01-01T11:15:00.000Z").getTime(),
    });

    expect(result).toEqual({
      exitPrice: 103,
      pnlUsd: 30,
      pnlPct: 3,
      holdDurationMins: 75,
      outcome: "win",
    });
  });

  it("calculates loss and scratch outcomes", () => {
    expect(calculateTradeOutcome({ entryPrice: 100, exitPrice: 97.5, qty: 4 })).toEqual(
      expect.objectContaining({ pnlUsd: -10, pnlPct: -2.5, outcome: "loss" })
    );
    expect(calculateTradeOutcome({ entryPrice: 100, exitPrice: 100, qty: 4 })).toEqual(
      expect.objectContaining({ pnlUsd: 0, pnlPct: 0, outcome: "scratch" })
    );
  });

  it("rejects incomplete or invalid realized outcome inputs", () => {
    expect(calculateTradeOutcome({ entryPrice: 0, exitPrice: 100, qty: 1 })).toBeNull();
    expect(calculateTradeOutcome({ entryPrice: 100, exitPrice: 0, qty: 1 })).toBeNull();
    expect(calculateTradeOutcome({ entryPrice: 100, exitPrice: 101, qty: 0 })).toBeNull();
  });
});
