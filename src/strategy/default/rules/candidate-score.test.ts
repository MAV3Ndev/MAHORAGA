import { describe, expect, it } from "vitest";
import type { ResearchResult, Signal } from "../../../core/types";
import { calculateCandidateScores, rankSignalCandidates } from "./candidate-score";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: "AAPL",
    source: "reddit",
    source_detail: "reddit_stocks",
    sentiment: 0.5,
    raw_sentiment: 0.6,
    volume: 10,
    freshness: 0.9,
    source_weight: 0.8,
    quality_score: 0.8,
    reason: "test",
    timestamp: Date.now(),
    ...overrides,
  };
}

function research(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    symbol: "AAPL",
    verdict: "BUY",
    confidence: 0.8,
    entry_quality: "good",
    reasoning: "test",
    red_flags: [],
    catalysts: ["contract"],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("candidate scoring", () => {
  it("ranks candidates by research quality, signal quality, and momentum", () => {
    const scores = calculateCandidateScores(
      [
        research({ symbol: "AAPL", confidence: 0.78 }),
        research({ symbol: "XYZ", confidence: 0.78, red_flags: ["Dilution", "Weak liquidity"] }),
      ],
      [
        signal({ symbol: "AAPL", quality_score: 0.85, raw_sentiment: 0.7 }),
        signal({ symbol: "XYZ", quality_score: 0.2, raw_sentiment: 0.7 }),
      ],
      {
        AAPL: { priceChange24h: 4, volumeChange: 3 },
        XYZ: { priceChange24h: -3 },
      }
    );

    expect(scores[0]?.symbol).toBe("AAPL");
    expect(scores[0]?.score).toBeGreaterThan(scores[1]?.score ?? 0);
  });

  it("filters low quality signal research candidates", () => {
    const ranked = rankSignalCandidates(
      [
        signal({ symbol: "AAPL", raw_sentiment: 0.7, quality_score: 0.8 }),
        signal({ symbol: "XYZ", raw_sentiment: 0.8, quality_score: 0.05, freshness: 0.1 }),
      ],
      0.4,
      0.35,
      5
    );

    expect(ranked.map((candidate) => candidate.symbol)).toEqual(["AAPL"]);
  });
});
