import type { Account, AgentConfig, AgentState, LogEntry, MarketClock, Position } from "./types";
import { filterRecordBySymbols, limitTimestampedRecord } from "./record-utils";

export interface AgentStatusPayload {
  enabled: boolean;
  strategy: string;
  account: Account | null;
  positions: Position[];
  clock: MarketClock | null;
  config: AgentConfig;
  signals: AgentState["signalCache"];
  logs: LogEntry[];
  costs: AgentState["costTracker"];
  lastAnalystRun: number;
  lastResearchRun: number;
  lastPositionResearchRun: number;
  signalResearch: AgentState["signalResearch"];
  positionResearch: AgentState["positionResearch"];
  positionEntries: AgentState["positionEntries"];
  twitterConfirmations: AgentState["twitterConfirmations"];
  premarketPlan: AgentState["premarketPlan"];
  stalenessAnalysis: AgentState["stalenessAnalysis"];
}

export interface BuildAgentStatusPayloadParams {
  state: AgentState;
  strategyName: string;
  account: Account | null;
  positions: Position[];
  clock: MarketClock | null;
  config: AgentConfig;
  maxLogs: number;
  maxSignalResearchEntries: number;
  maxTwitterConfirmations: number;
}

export function buildAgentStatusPayload({
  state,
  strategyName,
  account,
  positions,
  clock,
  config,
  maxLogs,
  maxSignalResearchEntries,
  maxTwitterConfirmations,
}: BuildAgentStatusPayloadParams): AgentStatusPayload {
  const activePositionSymbols = new Set(positions.map((position) => position.symbol));

  return {
    enabled: state.enabled,
    strategy: strategyName,
    account,
    positions,
    clock,
    config,
    signals: state.signalCache,
    logs: state.logs.slice(-maxLogs),
    costs: state.costTracker,
    lastAnalystRun: state.lastAnalystRun,
    lastResearchRun: state.lastResearchRun,
    lastPositionResearchRun: state.lastPositionResearchRun,
    signalResearch: limitTimestampedRecord(state.signalResearch, maxSignalResearchEntries),
    positionResearch: state.positionResearch,
    positionEntries: filterRecordBySymbols(state.positionEntries, activePositionSymbols),
    twitterConfirmations: limitTimestampedRecord(state.twitterConfirmations, maxTwitterConfirmations),
    premarketPlan: state.premarketPlan,
    stalenessAnalysis: filterRecordBySymbols(state.stalenessAnalysis, activePositionSymbols),
  };
}
