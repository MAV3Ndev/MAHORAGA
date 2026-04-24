import { describe, expect, it } from "vitest";
import type { Position } from "../providers/types";
import { getPositionResearchCandidates, shouldRunPositionResearch } from "./position-research";

function createPosition(overrides: Partial<Position> = {}): Position {
  return {
    asset_id: "test-asset",
    symbol: "AAPL",
    exchange: "NASDAQ",
    asset_class: "us_equity",
    avg_entry_price: 150,
    qty: 10,
    side: "long",
    market_value: 1500,
    cost_basis: 1500,
    unrealized_pl: 0,
    unrealized_plpc: 0,
    unrealized_intraday_pl: 0,
    unrealized_intraday_plpc: 0,
    current_price: 150,
    lastday_price: 150,
    change_today: 0,
    ...overrides,
  };
}

describe("position research scheduling", () => {
  it("includes equities during market hours", () => {
    const candidates = getPositionResearchCandidates([createPosition()], true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.symbol).toBe("AAPL");
  });

  it("includes crypto while market is closed", () => {
    const candidates = getPositionResearchCandidates([
      createPosition({ symbol: "BTC/USD", asset_class: "crypto", exchange: "CRYPTO" }),
    ], false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.symbol).toBe("BTC/USD");
  });

  it("excludes equities while market is closed", () => {
    const candidates = getPositionResearchCandidates([createPosition()], false);
    expect(candidates).toHaveLength(0);
  });

  it("excludes options from position research", () => {
    const candidates = getPositionResearchCandidates([
      createPosition({ symbol: "AAPL240621C00150000", asset_class: "us_option" }),
    ], true);
    expect(candidates).toHaveLength(0);
  });

  it("runs on interval when closed-market crypto positions exist", () => {
    const shouldRun = shouldRunPositionResearch(
      [createPosition({ symbol: "BTC/USD", asset_class: "crypto", exchange: "CRYPTO" })],
      false,
      600_000,
      0,
      300_000
    );
    expect(shouldRun).toBe(true);
  });

  it("does not run before interval elapses", () => {
    const shouldRun = shouldRunPositionResearch(
      [createPosition({ symbol: "BTC/USD", asset_class: "crypto", exchange: "CRYPTO" })],
      false,
      100_000,
      0,
      300_000
    );
    expect(shouldRun).toBe(false);
  });
});
