import { describe, expect, it } from "vitest";
import type { Signal } from "../../../core/types";
import { getSignedSignalSentiment } from "./sentiment";

const signal = {
  symbol: "NVDA",
  source: "reddit",
  source_detail: "reddit",
  sentiment: 0.4,
  raw_sentiment: 0.4,
  volume: 10,
  freshness: 1,
  source_weight: 1,
  reason: "bearish vote imbalance",
  timestamp: Date.now(),
} satisfies Signal;

describe("getSignedSignalSentiment", () => {
  it("treats positive sentiment as bearish when bearish votes dominate", () => {
    expect(getSignedSignalSentiment({ ...signal, bullish: 1, bearish: 4 })).toBe(-0.4);
  });

  it("keeps positive sentiment when bullish votes are not dominated", () => {
    expect(getSignedSignalSentiment({ ...signal, bullish: 4, bearish: 1 })).toBe(0.4);
  });
});
