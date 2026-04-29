import { describe, expect, it } from "vitest";
import { DEFAULT_STATE } from "../strategy/default/config";
import { buildAgentStatusPayload } from "./status-payload";
import type { AgentState, Position, PositionEntry, ResearchResult, TwitterConfirmation } from "./types";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    ...DEFAULT_STATE,
    signalCache: [],
    positionEntries: {},
    socialHistory: {},
    socialSnapshotCache: {},
    logs: [],
    dailyReportBuckets: {},
    costTracker: { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 },
    signalResearch: {},
    positionResearch: {},
    stalenessAnalysis: {},
    twitterConfirmations: {},
    ...overrides,
  };
}

function createPosition(symbol: string): Position {
  return { symbol } as Position;
}

function createPositionEntry(symbol: string): PositionEntry {
  return {
    symbol,
    entry_time: 1,
    entry_price: 10,
    entry_sentiment: 0.5,
    entry_social_volume: 100,
    entry_sources: ["test"],
    entry_reason: "test",
    peak_price: 11,
    peak_sentiment: 0.6,
  };
}

function createResearchResult(symbol: string, timestamp: number): ResearchResult {
  return {
    symbol,
    verdict: "BUY",
    confidence: 0.8,
    entry_quality: "good",
    reasoning: "test",
    red_flags: [],
    catalysts: [],
    timestamp,
  };
}

function createTwitterConfirmation(symbol: string, timestamp: number): TwitterConfirmation {
  return {
    symbol,
    tweet_count: 3,
    sentiment: 0.7,
    confirms_existing: true,
    highlights: [],
    timestamp,
  };
}

describe("status payload", () => {
  it("keeps position-scoped records only for active positions", () => {
    const payload = buildAgentStatusPayload({
      state: createState({
        positionEntries: {
          AAPL: createPositionEntry("AAPL"),
          MSFT: createPositionEntry("MSFT"),
          TSLA: createPositionEntry("TSLA"),
        },
        stalenessAnalysis: {
          AAPL: { stale: false },
          MSFT: { stale: true },
          TSLA: { stale: false },
        },
      }),
      strategyName: "test-strategy",
      account: null,
      positions: [createPosition("AAPL"), createPosition("TSLA")],
      clock: null,
      config: DEFAULT_STATE.config,
      maxLogs: 100,
      maxSignalResearchEntries: 10,
      maxTwitterConfirmations: 10,
    });

    expect(Object.keys(payload.positionEntries)).toEqual(["AAPL", "TSLA"]);
    expect(payload.stalenessAnalysis).toEqual({
      AAPL: { stale: false },
      TSLA: { stale: false },
    });
  });

  it("limits research records by newest timestamps", () => {
    const payload = buildAgentStatusPayload({
      state: createState({
        signalResearch: {
          OLD: createResearchResult("OLD", 10),
          NEW: createResearchResult("NEW", 30),
          MID: createResearchResult("MID", 20),
        },
        twitterConfirmations: {
          LOW: createTwitterConfirmation("LOW", 100),
          HIGH: createTwitterConfirmation("HIGH", 300),
          MIDDLE: createTwitterConfirmation("MIDDLE", 200),
        },
      }),
      strategyName: "test-strategy",
      account: null,
      positions: [],
      clock: null,
      config: DEFAULT_STATE.config,
      maxLogs: 100,
      maxSignalResearchEntries: 2,
      maxTwitterConfirmations: 1,
    });

    expect(Object.keys(payload.signalResearch)).toEqual(["NEW", "MID"]);
    expect(Object.keys(payload.twitterConfirmations)).toEqual(["HIGH"]);
  });

  it("slices logs and preserves nullable provider state", () => {
    const payload = buildAgentStatusPayload({
      state: createState({
        enabled: true,
        logs: [
          { timestamp: "2026-04-24T00:00:00.000Z", agent: "a", action: "old" },
          { timestamp: "2026-04-24T00:01:00.000Z", agent: "a", action: "new" },
        ],
      }),
      strategyName: "test-strategy",
      account: null,
      positions: [],
      clock: null,
      config: DEFAULT_STATE.config,
      maxLogs: 1,
      maxSignalResearchEntries: 10,
      maxTwitterConfirmations: 10,
    });

    expect(payload.enabled).toBe(true);
    expect(payload.account).toBeNull();
    expect(payload.clock).toBeNull();
    expect(payload.positions).toEqual([]);
    expect(payload.logs).toEqual([{ timestamp: "2026-04-24T00:01:00.000Z", agent: "a", action: "new" }]);
  });
});
