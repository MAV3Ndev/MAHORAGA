import type { AgentConfig, AgentState } from "./types";

export function createInitialAgentState(config: AgentConfig): AgentState {
  return {
    config,
    signalCache: [],
    positionEntries: {},
    socialHistory: {},
    socialSnapshotCache: {},
    socialSnapshotCacheUpdatedAt: 0,
    logs: [],
    dailyReportBuckets: {},
    costTracker: { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 },
    lastDataGatherRun: 0,
    lastAnalystRun: 0,
    lastResearchRun: 0,
    lastPositionResearchRun: 0,
    signalResearch: {},
    positionResearch: {},
    analystBuyCooldowns: {},
    stalenessAnalysis: {},
    twitterConfirmations: {},
    twitterDailyReads: 0,
    twitterDailyReadReset: 0,
    lastKnownNextOpenMs: null,
    premarketPlan: null,
    lastPremarketPlanDayEt: null,
    lastClockIsOpen: null,
    lastDailyReportSentAt: null,
    enabled: false,
  };
}
