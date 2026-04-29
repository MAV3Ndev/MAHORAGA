import { describe, expect, it } from "vitest";
import { replayOrders } from "./replay";

describe("strategy replay", () => {
  it("replays buy and sell orders against timestamped prices", () => {
    const result = replayOrders(
      1_000,
      [
        { symbol: "AAPL", timestamp: 1, price: 100 },
        { symbol: "AAPL", timestamp: 2, price: 110 },
      ],
      [
        { symbol: "AAPL", timestamp: 1, side: "BUY", notional: 500 },
        { symbol: "AAPL", timestamp: 2, side: "SELL", reason: "take profit" },
      ]
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.pnl).toBe(50);
    expect(result.realizedPnl).toBe(50);
    expect(result.endingEquity).toBe(1_050);
  });
});
