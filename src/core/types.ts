/**
 * Core types shared between the harness orchestrator and strategies.
 *
 * These types are the stable contract — changes here affect all strategies.
 */

// Re-export provider types that strategies need
export type { Account, LLMProvider, MarketClock, Position } from "../providers/types";

// Re-export config types
export type { AgentConfig } from "../schemas/agent-config";

// ---------------------------------------------------------------------------
// Signal — produced by data gatherers, consumed by the research & trading loop
// ---------------------------------------------------------------------------

export interface Signal {
  symbol: string;
  source: string;
  source_detail: string;
  sentiment: number;
  raw_sentiment: number;
  volume: number;
  freshness: number;
  source_weight: number;
  reason: string;
  timestamp: number;
  // Optional enrichment fields (gatherers add what they need)
  upvotes?: number;
  comments?: number;
  quality_score?: number;
  subreddits?: string[];
  best_flair?: string | null;
  bullish?: number;
  bearish?: number;
  isCrypto?: boolean;
  momentum?: number;
  price?: number;
}

// ---------------------------------------------------------------------------
// Position tracking — entry metadata persisted across alarm cycles
// ---------------------------------------------------------------------------

export interface PositionEntry {
  symbol: string;
  entry_time: number;
  entry_price: number;
  entry_sentiment: number;
  entry_social_volume: number;
  entry_sources: string[];
  entry_reason: string;
  entry_quote_mid?: number;
  entry_slippage_pct?: number;
  peak_price: number;
  trough_price?: number;
  peak_sentiment: number;
  recommended_entry_zone?: string;
  recommended_stop_loss_pct?: number;
  recommended_take_profit_pct?: number;
}

export interface RecentSellEntry {
  symbol: string;
  sold_at: number;
  reason: string;
}

export interface MissedEntryOpportunity {
  id: string;
  symbol: string;
  symbol_key: string;
  blocked_at: number;
  blocked_price: number;
  reason: string;
  agent: string;
  action: string;
  confidence?: number;
  entry_quality?: ResearchResult["entry_quality"];
  notional?: number;
  evaluated_at?: number;
  evaluation_price?: number;
  change_pct?: number;
}

// ---------------------------------------------------------------------------
// Social history — rolling time-series for staleness detection
// ---------------------------------------------------------------------------

export interface SocialHistoryEntry {
  timestamp: number;
  volume: number;
  sentiment: number;
}

export interface SocialSnapshotCacheEntry {
  volume: number;
  sentiment: number;
  sources: string[];
}

// ---------------------------------------------------------------------------
// Logging & cost tracking
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  agent: string;
  action: string;
  [key: string]: unknown;
}

export interface CostTracker {
  total_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface DailyReportTrade {
  side: "BUY" | "SELL";
  symbol: string;
  timestamp: number;
  reason?: string;
  notional?: number;
}

export interface DailyReportBucket {
  bucket_start_ms: number;
  total_events: number;
  data_gather_cycles: number;
  analyst_runs: number;
  premarket_plans: number;
  breaking_news_alerts: number;
  errors: number;
  researched_signals: number;
  buy_verdicts: number;
  skip_verdicts: number;
  wait_verdicts: number;
  executed_buys: number;
  executed_sells: number;
  executed_buy_notional: number;
  symbol_counts: Record<string, number>;
  recent_trades: DailyReportTrade[];
}

// ---------------------------------------------------------------------------
// Research results — output of LLM analysis
// ---------------------------------------------------------------------------

export interface ResearchResult {
  symbol: string;
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
  sentiment?: number;
  timestamp: number;
  recommended_entry_zone?: string;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

export interface TwitterConfirmation {
  symbol: string;
  tweet_count: number;
  sentiment: number;
  confirms_existing: boolean;
  highlights: Array<{ author: string; text: string; likes: number }>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Pre-market plan
// ---------------------------------------------------------------------------

export interface PremarketPlan {
  timestamp: number;
  recommendations: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary: string;
  high_conviction: string[];
  researched_buys: ResearchResult[];
}

// ---------------------------------------------------------------------------
// Agent state — persisted in DO storage
// ---------------------------------------------------------------------------

export interface AgentState {
  config: import("../schemas/agent-config").AgentConfig;
  signalCache: Signal[];
  positionEntries: Record<string, PositionEntry>;
  entryPerformanceBlocks?: Record<string, unknown>;
  entryFeaturePerformanceBlocks?: Record<string, unknown>;
  entryPerformanceBlocksRefreshedAt?: number;
  recentSells: Record<string, RecentSellEntry>;
  missedEntryOpportunities: Record<string, MissedEntryOpportunity>;
  socialHistory: Record<string, SocialHistoryEntry[]>;
  socialSnapshotCache: Record<string, SocialSnapshotCacheEntry>;
  socialSnapshotCacheUpdatedAt: number;
  logs: LogEntry[];
  dailyReportBuckets: Record<string, DailyReportBucket>;
  costTracker: CostTracker;
  lastDataGatherRun: number;
  lastAlarmStartedAt?: number;
  lastAnalystRun: number;
  lastResearchRun: number;
  lastPositionResearchRun: number;
  signalResearch: Record<string, ResearchResult>;
  positionResearch: Record<string, unknown>;
  analystBuyCooldowns: Record<string, number>;
  stalenessAnalysis: Record<string, unknown>;
  twitterConfirmations: Record<string, TwitterConfirmation>;
  twitterDailyReads: number;
  twitterDailyReadReset: number;
  lastKnownNextOpenMs: number | null;
  premarketPlan: PremarketPlan | null;
  lastPremarketPlanDayEt: string | null;
  lastClockIsOpen: boolean | null;
  lastDiscordDailyReportDay: string | null;
  enabled: boolean;
}
