import { describe, expect, it } from "vitest";
import type { StrategyContext } from "../../types";
import { researchSignalPrompt } from "./research";

describe("researchSignalPrompt", () => {
  it("includes per-source signal evidence so the LLM can evaluate catalysts", () => {
    const ctx = {
      signals: [
        {
          symbol: "APLD",
          source: "reddit",
          source_detail: "reddit_stocks",
          sentiment: 0.72,
          raw_sentiment: 0.72,
          volume: 42,
          freshness: 0.91,
          source_weight: 0.9,
          reason: "Reddit(stocks): 12 mentions, 450 upvotes, quality:82%",
          quality_score: 0.82,
        },
        {
          symbol: "MSFT",
          source: "stocktwits",
          source_detail: "stocktwits_trending",
          sentiment: 0.4,
          raw_sentiment: 0.4,
          volume: 10,
          freshness: 0.5,
          source_weight: 0.85,
          reason: "Different symbol should not leak into APLD research",
        },
      ],
    } as StrategyContext;

    const prompt = researchSignalPrompt("APLD", 0.72, ["reddit"], 12.34, ctx);

    expect(prompt.user).toContain("SOURCE EVIDENCE:");
    expect(prompt.user).toContain("reddit:reddit_stocks");
    expect(prompt.user).toContain("Reddit(stocks): 12 mentions");
    expect(prompt.user).toContain("quality=82%");
    expect(prompt.user).not.toContain("Different symbol should not leak");
  });

  it("makes missing evidence explicit instead of silently omitting context", () => {
    const ctx = { signals: [] } as unknown as StrategyContext;

    const prompt = researchSignalPrompt("WULF", 0.9, ["stocktwits"], 4.56, ctx);

    expect(prompt.user).toContain("No per-source signal details were available");
  });
});
