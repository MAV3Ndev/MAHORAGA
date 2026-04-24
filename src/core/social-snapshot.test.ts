import { describe, expect, it } from "vitest";
import type { Signal, SocialHistoryEntry } from "./types";
import {
  buildSocialSnapshot,
  getSocialSnapshotCache,
  serializeSocialSnapshot,
  updateSocialHistoryFromSnapshot,
} from "./social-snapshot";

function signal(overrides: Partial<Signal>): Signal {
  return {
    symbol: "AAPL",
    source: "test",
    source_detail: "test_detail",
    sentiment: 0,
    raw_sentiment: 0,
    volume: 1,
    freshness: 1,
    source_weight: 1,
    reason: "test",
    timestamp: 1,
    ...overrides,
  };
}

describe("social snapshot helpers", () => {
  it("aggregates weighted sentiment and sources by symbol", () => {
    const snapshot = buildSocialSnapshot([
      signal({ symbol: "AAPL", sentiment: 0.8, volume: 3, source_detail: "stocktwits" }),
      signal({ symbol: "AAPL", sentiment: -0.2, volume: 1, source_detail: "reddit" }),
      signal({ symbol: "MSFT", sentiment: 0.5, volume: 0, source_detail: "" }),
    ]);

    expect(serializeSocialSnapshot(snapshot)).toEqual({
      AAPL: {
        volume: 4,
        sentiment: 0.55,
        sources: ["stocktwits", "reddit"],
      },
      MSFT: {
        volume: 1,
        sentiment: 0.5,
        sources: ["test"],
      },
    });
  });

  it("rolls recent samples into the current history bucket", () => {
    const history: Record<string, SocialHistoryEntry[]> = {
      AAPL: [{ timestamp: 1_000, volume: 1, sentiment: 0.1 }],
    };
    const snapshot = buildSocialSnapshot([signal({ symbol: "AAPL", sentiment: 0.7, volume: 4 })]);

    updateSocialHistoryFromSnapshot(history, snapshot, 60_000);

    expect(history.AAPL).toEqual([{ timestamp: 60_000, volume: 4, sentiment: 0.7 }]);
  });

  it("prunes stale untouched symbols", () => {
    const history: Record<string, SocialHistoryEntry[]> = {
      AAPL: [{ timestamp: 1_000, volume: 1, sentiment: 0.1 }],
      MSFT: [{ timestamp: 2_000, volume: 2, sentiment: 0.2 }],
    };
    const now = 25 * 60 * 60 * 1000;
    const snapshot = buildSocialSnapshot([signal({ symbol: "AAPL", sentiment: 0.4, volume: 2 })]);

    updateSocialHistoryFromSnapshot(history, snapshot, now);

    expect(history.MSFT).toBeUndefined();
    expect(history.AAPL?.at(-1)).toMatchObject({ timestamp: now, volume: 2, sentiment: 0.4 });
  });

  it("uses persisted snapshot cache when available", () => {
    expect(
      getSocialSnapshotCache({
        socialSnapshotCache: { AAPL: { volume: 3, sentiment: 0.5, sources: ["stored"] } },
        socialSnapshotCacheUpdatedAt: 1,
        signalCache: [signal({ symbol: "MSFT", sentiment: -0.2 })],
      })
    ).toEqual({ AAPL: { volume: 3, sentiment: 0.5, sources: ["stored"] } });
  });
});
