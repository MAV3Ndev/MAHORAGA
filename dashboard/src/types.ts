export interface Account {
  equity: number;
  cash: number;
  buying_power: number;
  portfolio_value: number;
}

export interface Position {
  symbol: string;
  qty: number;
  side: string;
  avg_entry_price?: number;
  cost_basis?: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_plpc?: number;
  current_price: number;
}

export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface Signal {
  symbol: string;
  source: string;
  sentiment: number;
  volume: number;
  reason: string;
  bullish?: number;
  bearish?: number;
  score?: number;
  upvotes?: number;
  isCrypto?: boolean;
  momentum?: number;
  price?: number;
}

export interface LogEntry {
  timestamp: string;
  agent: string;
  action: string;
  symbol?: string;
  [key: string]: unknown;
}

export interface CostTracker {
  total_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface Config {
  data_poll_interval_ms: number;
  analyst_interval_ms: number;
  premarket_plan_window_minutes?: number;
  market_open_execute_window_minutes?: number;
  max_position_value: number;
  max_positions: number;
  min_sentiment_score: number;
  min_analyst_confidence: number;
  min_entry_quality?: "excellent" | "good" | "fair" | "poor";
  max_entry_red_flags?: number;
  min_entry_catalysts?: number;
  min_entry_signal_sources?: number;
  min_entry_signal_consensus?: number;
  single_source_entry_min_confidence?: number;
  max_entry_research_age_minutes?: number;
  min_entry_selection_score?: number;
  exceptional_entry_confidence?: number;
  analyst_buy_requires_research_confirmation?: boolean;
  signal_research_limit: number;
  entry_candidate_limit: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  trailing_stop_enabled?: boolean;
  trailing_stop_activation_pct?: number;
  trailing_stop_drawdown_pct?: number;
  breakeven_stop_enabled?: boolean;
  breakeven_stop_activation_pct?: number;
  breakeven_stop_buffer_pct?: number;
  profit_lock_stop_enabled?: boolean;
  profit_lock_activation_pct?: number;
  profit_lock_floor_pct?: number;
  sentiment_reversal_exit_enabled?: boolean;
  sentiment_reversal_min_hold_minutes?: number;
  sentiment_reversal_loss_pct?: number;
  sentiment_reversal_threshold?: number;
  sentiment_reversal_min_sources?: number;
  position_size_pct_of_cash: number;
  equity_entry_cutoff_minutes_before_close?: number;
  max_entry_spread_pct?: number;
  min_entry_quote_size?: number;
  max_entry_price_change_pct?: number;
  bad_fill_exit_enabled?: boolean;
  bad_fill_max_slippage_pct?: number;
  bad_fill_loss_pct?: number;
  bad_fill_max_hold_minutes?: number;
  early_loss_exit_enabled?: boolean;
  early_loss_exit_pct?: number;
  early_loss_exit_max_hold_minutes?: number;
  after_hours_exit_limit_buffer_pct?: number;
  entry_timing_enabled?: boolean;
  entry_rsi_min?: number;
  entry_rsi_max?: number;
  entry_bb_lower_threshold?: number;
  entry_max_intraday_range_position?: number;
  market_regime_enabled?: boolean;
  regime_low_threshold?: number;
  regime_position_size_reduction?: number;
  portfolio_risk_enabled?: boolean;
  max_positions_per_sector?: number;
  max_daily_loss_pct?: number;
  daily_loss_entry_guard_enabled?: boolean;
  daily_loss_entry_guard_pct?: number;
  daily_loss_guard_min_confidence?: number;
  daily_loss_guard_min_entry_quality?: "excellent" | "good" | "fair" | "poor";
  open_position_loss_entry_guard_enabled?: boolean;
  open_position_loss_entry_guard_pct?: number;
  open_position_loss_guard_min_confidence?: number;
  open_position_loss_guard_min_entry_quality?: "excellent" | "good" | "fair" | "poor";
  cooldown_minutes_after_loss?: number;
  max_daily_entry_orders?: number;
  min_minutes_between_entries?: number;
  adaptive_performance_block_enabled?: boolean;
  adaptive_performance_lookback_days?: number;
  adaptive_performance_min_trades?: number;
  adaptive_performance_min_win_rate?: number;
  llm_provider?: "openai-raw" | "ai-sdk" | "cloudflare-gateway";
  llm_model: string;
  llm_analyst_model?: string;
  llm_api_key?: string;
  openai_base_url?: string;
  anthropic_base_url?: string;
  starting_equity?: number;
  llm_min_hold_minutes?: number;
  recent_sell_cooldown_hours?: number;
  defensive_sell_cooldown_hours?: number;
  llm_force_sell_pnl_pct?: number;
  llm_force_sell_min_confidence?: number;
  llm_size_conviction_scaling?: boolean;
  llm_size_low_confidence_multiplier?: number;
  llm_size_medium_confidence_multiplier?: number;
  equity_entry_cooldown_minutes_after_open?: number;

  // Stale position management
  stale_position_enabled?: boolean;
  stale_min_hold_hours?: number;
  stale_loss_exit_pct?: number;
  stale_max_hold_days?: number;
  stale_min_gain_pct?: number;
  stale_mid_hold_days?: number;
  stale_mid_min_gain_pct?: number;
  stale_social_volume_decay?: number;

  // Options config
  options_enabled?: boolean;
  options_min_confidence?: number;
  options_max_pct_per_trade?: number;
  options_min_dte?: number;
  options_max_dte?: number;
  options_target_delta?: number;
  options_min_delta?: number;
  options_max_delta?: number;
  options_max_spread_pct?: number;
  options_early_loss_exit_enabled?: boolean;
  options_early_loss_exit_pct?: number;
  options_early_loss_exit_max_hold_minutes?: number;
  options_stop_loss_pct?: number;
  options_take_profit_pct?: number;

  // Crypto trading config (24/7)
  crypto_enabled?: boolean;
  crypto_symbols?: string[];
  crypto_max_positions?: number;
  crypto_momentum_threshold?: number;
  crypto_max_momentum_pct?: number;
  crypto_max_position_value?: number;
  crypto_take_profit_pct?: number;
  crypto_stop_loss_pct?: number;

  // Custom ticker blacklist (insider trading restrictions, etc.)
  ticker_blacklist?: string[];
  allowed_exchanges?: string[];
  reddit_cookies?: string;
  reddit_cookie_accounts?: CookieAccountConfig[];
  reddit_user_agent?: string;
  alpha_vantage_api_key?: string;
  twitter_cookies?: string;
  twitter_cookie_accounts?: CookieAccountConfig[];
  discord_webhook_url?: string;
  discord_daily_report_enabled: boolean;
  discord_daily_report_time: string;
  discord_daily_report_timezone: string;
}

export interface CookieAccountConfig {
  label?: string;
  cookies: string;
}

export interface SignalResearch {
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
  sentiment?: number;
  timestamp: number;
}

export interface PositionResearch {
  recommendation: "HOLD" | "SELL" | "ADD";
  risk_level: "low" | "medium" | "high";
  reasoning: string;
  key_factors: string[];
  timestamp: number;
}

export interface PositionEntry {
  symbol: string;
  entry_time: number;
  entry_price: number;
  entry_sentiment: number;
  entry_social_volume: number;
  entry_sources: string[];
  entry_reason: string;
  peak_price: number;
  peak_sentiment: number;
}

export interface TwitterConfirmation {
  symbol: string;
  query: string;
  tweetCount: number;
  sentiment: number;
  bullishCount: number;
  bearishCount: number;
  influencerMentions: number;
  averageEngagement: number;
  timestamp: number;
}

export interface PremarketPlan {
  timestamp: number;
  summary: string;
  recommendations: Array<{
    symbol: string;
    action: "BUY" | "SELL" | "HOLD" | "SKIP";
    confidence: number;
    reasoning: string;
    entry_price?: number;
    target_price?: number;
    stop_loss?: number;
  }>;
  highConvictionPlays: string[];
  marketOutlook: string;
}

export interface StalenessAnalysis {
  symbol: string;
  score: number;
  holdDays: number;
  gainPct: number;
  socialVolumeDecay: number;
  shouldExit: boolean;
  reasons: string[];
}

export interface OvernightActivity {
  signalsGathered: number;
  signalsResearched: number;
  buySignals: number;
  twitterConfirmations: number;
  premarketPlanReady: boolean;
  lastUpdated: number;
}

export interface AdaptivePerformanceBlock {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl_usd: number;
  updated_at?: string | null;
}

export interface AdaptivePerformanceSummary {
  enabled: boolean;
  refreshed_at?: string | null;
  symbol_block_count: number;
  feature_block_count: number;
  symbols: AdaptivePerformanceBlock[];
  features: AdaptivePerformanceBlock[];
}

export interface RuntimeEntryPipelineSummary {
  buys_executed?: number;
  buys_submitted?: number;
  buys_deferred?: number;
  signal_researched?: number;
  signal_research_buy?: number;
  signal_research_wait?: number;
  signal_research_skip?: number;
  signal_research_no_candidates?: number;
  entry_selection_cycles?: number;
  researched_buy_available?: number;
  strategy_entry_candidates?: number;
  analyst_complete?: number;
  analyst_skipped?: number;
  analyst_buy_recommendations?: number;
  analyst_buy_recommendations_above_threshold?: number;
  missed_entry_evaluated?: number;
  missed_entry_would_have_won?: number;
  missed_entry_would_have_lost?: number;
  missed_entry_reasons?: Array<{
    action?: string;
    reason?: string;
    evaluated?: number;
    would_have_won?: number;
    would_have_lost?: number;
    symbols?: string[];
  }>;
  dominant_entry_blocker?: {
    action?: string;
    reason?: string;
    count?: number;
    symbols?: string[];
  } | null;
  diagnosis_hints?: string[];
}

export interface RuntimeSummary {
  entry_pipeline?: RuntimeEntryPipelineSummary;
  entry_blockers?: Array<{
    action: string;
    count: number;
    symbols?: string[];
  }>;
  entry_blocker_reasons?: Array<{
    action: string;
    reason: string;
    count: number;
    symbols?: string[];
  }>;
  adaptive_performance?: AdaptivePerformanceSummary;
}

export interface PortfolioSnapshot {
  timestamp: number;
  equity: number;
  pl: number;
  pl_pct: number;
}

export interface PositionHistory {
  symbol: string;
  prices: number[];
  timestamps: number[];
}

export interface PositionTimelinePoint {
  timestamp: number;
  price: number;
  change_pct: number;
}

export interface PositionTimelineHistory {
  symbol: string;
  entry_time: number;
  entry_price: number;
  current_price: number;
  exit_time?: number;
  exit_price?: number;
  status?: "OPEN" | "SOLD";
  points: PositionTimelinePoint[];
}

export interface Status {
  runtimeSummary?: RuntimeSummary;
  enabled: boolean;
  strategy?: string;
  account: Account | null;
  positions: Position[];
  clock: Clock | null;
  config: Config;
  signals: Signal[];
  logs: LogEntry[];
  costs: CostTracker;
  lastAnalystRun: number;
  lastResearchRun: number;
  lastPositionResearchRun?: number;
  signalResearch: Record<string, SignalResearch>;
  positionResearch: Record<string, PositionResearch>;
  portfolioHistory?: PortfolioSnapshot[];
  positionHistory?: Record<string, PositionHistory>;
  positionEntries?: Record<string, PositionEntry>;
  twitterConfirmations?: Record<string, TwitterConfirmation>;
  premarketPlan?: PremarketPlan | null;
  stalenessAnalysis?: Record<string, StalenessAnalysis>;
  overnightActivity?: OvernightActivity;
  adaptivePerformance?: AdaptivePerformanceSummary;
}
