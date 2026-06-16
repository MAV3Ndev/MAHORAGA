import { z } from "zod";

const CookieAccountSchema = z.object({
  label: z.string().trim().max(80).optional(),
  cookies: z.string().trim().min(1).max(20000),
});

export const AgentConfigSchema = z
  .object({
    data_poll_interval_ms: z.number().min(5000).max(300000),
    analyst_interval_ms: z.number().min(30000).max(600000),

    premarket_plan_window_minutes: z.number().min(1).max(60),
    market_open_execute_window_minutes: z.number().min(0).max(10),

    max_position_value: z.number().positive().max(100000),
    max_positions: z.number().int().min(1).max(50),
    min_sentiment_score: z.number().min(0).max(1),
    min_analyst_confidence: z.number().min(0).max(1),
    signal_research_limit: z.number().int().min(1).max(20),
    max_entry_research_age_minutes: z.number().min(1).max(1440),
    entry_candidate_limit: z.number().int().min(1).max(10),
    min_entry_selection_score: z.number().min(0).max(2),
    min_entry_quality: z.enum(["excellent", "good", "fair", "poor"]),
    max_entry_red_flags: z.number().int().min(0).max(10),
    min_entry_catalysts: z.number().int().min(0).max(10),
    min_entry_signal_sources: z.number().int().min(1).max(10),
    min_entry_signal_consensus: z.number().min(0).max(1),
    single_source_entry_min_confidence: z.number().min(0).max(1),
    exceptional_entry_confidence: z.number().min(0).max(1),
    analyst_buy_requires_research_confirmation: z.boolean(),
    llm_size_conviction_scaling: z.boolean(),
    llm_size_low_confidence_multiplier: z.number().min(0.1).max(1),
    llm_size_medium_confidence_multiplier: z.number().min(0.1).max(1),
    equity_entry_cooldown_minutes_after_open: z.number().min(0).max(120),
    equity_entry_cutoff_minutes_before_close: z.number().min(0).max(120),
    max_entry_spread_pct: z.number().min(0).max(10),
    min_entry_quote_size: z.number().int().min(0).max(10000),
    max_entry_price_change_pct: z.number().min(0).max(100),
    bad_fill_exit_enabled: z.boolean(),
    bad_fill_max_slippage_pct: z.number().min(0).max(10),
    bad_fill_loss_pct: z.number().min(0).max(50),
    bad_fill_max_hold_minutes: z.number().min(0).max(1440),
    early_loss_exit_enabled: z.boolean(),
    early_loss_exit_pct: z.number().min(0).max(50),
    early_loss_exit_max_hold_minutes: z.number().min(0).max(1440),
    after_hours_exit_limit_buffer_pct: z.number().min(0).max(5),
    entry_timing_enabled: z.boolean(),
    entry_rsi_min: z.number().min(0).max(100),
    entry_rsi_max: z.number().min(0).max(100),
    entry_bb_lower_threshold: z.number().min(0).max(1),
    entry_max_intraday_range_position: z.number().min(0).max(1),
    market_regime_enabled: z.boolean(),
    regime_low_threshold: z.number().min(0).max(1),
    regime_position_size_reduction: z.number().min(0.1).max(1),
    portfolio_risk_enabled: z.boolean(),
    max_positions_per_sector: z.number().int().min(1).max(10),
    max_daily_loss_pct: z.number().min(0.001).max(1),
    daily_loss_entry_guard_enabled: z.boolean(),
    daily_loss_entry_guard_pct: z.number().min(0).max(1),
    daily_loss_guard_min_confidence: z.number().min(0).max(1),
    daily_loss_guard_min_entry_quality: z.enum(["excellent", "good", "fair", "poor"]),
    open_position_loss_entry_guard_enabled: z.boolean(),
    open_position_loss_entry_guard_pct: z.number().min(0).max(1),
    open_position_loss_guard_min_confidence: z.number().min(0).max(1),
    open_position_loss_guard_min_entry_quality: z.enum(["excellent", "good", "fair", "poor"]),
    cooldown_minutes_after_loss: z.number().min(0).max(1440),
    max_daily_entry_orders: z.number().int().min(0).max(100),
    min_minutes_between_entries: z.number().min(0).max(1440),
    adaptive_performance_block_enabled: z.boolean(),
    adaptive_performance_lookback_days: z.number().int().min(1).max(3650),
    adaptive_performance_min_trades: z.number().int().min(1).max(100),
    adaptive_performance_min_win_rate: z.number().min(0).max(1),
    llm_force_sell_pnl_pct: z.number().min(0).max(50),
    llm_force_sell_min_confidence: z.number().min(0).max(1),

    take_profit_pct: z.number().min(1).max(100),
    stop_loss_pct: z.number().min(1).max(50),
    trailing_stop_enabled: z.boolean(),
    trailing_stop_activation_pct: z.number().min(0).max(100),
    trailing_stop_drawdown_pct: z.number().min(0.1).max(100),
    breakeven_stop_enabled: z.boolean(),
    breakeven_stop_activation_pct: z.number().min(0).max(100),
    breakeven_stop_buffer_pct: z.number().min(0).max(10),
    profit_lock_stop_enabled: z.boolean(),
    profit_lock_activation_pct: z.number().min(0).max(100),
    profit_lock_floor_pct: z.number().min(0).max(10),
    sentiment_reversal_exit_enabled: z.boolean(),
    sentiment_reversal_min_hold_minutes: z.number().min(0).max(1440),
    sentiment_reversal_loss_pct: z.number().min(0).max(50),
    sentiment_reversal_threshold: z.number().min(-1).max(0),
    sentiment_reversal_min_sources: z.number().int().min(1).max(10),
    position_size_pct_of_cash: z.number().min(1).max(100),
    equity_entry_cutoff_minutes_before_close: z.number().int().min(0).max(120),
    after_hours_exit_limit_buffer_pct: z.number().min(0).max(5),

    stale_position_enabled: z.boolean(),
    stale_min_hold_hours: z.number().min(0).max(168),
    stale_loss_exit_pct: z.number().min(0).max(50),
    stale_max_hold_days: z.number().min(1).max(30),
    stale_min_gain_pct: z.number().min(0).max(100),
    stale_mid_hold_days: z.number().min(1).max(30),
    stale_mid_min_gain_pct: z.number().min(0).max(100),
    stale_social_volume_decay: z.number().min(0).max(1),

    llm_provider: z.enum(["openai-raw", "ai-sdk", "cloudflare-gateway"]),
    llm_model: z.string().min(1),
    llm_analyst_model: z.string().min(1),
    openai_base_url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      }, "openai_base_url must be a valid URL"),
    llm_min_hold_minutes: z.number().min(0).max(1440),
    recent_sell_cooldown_hours: z.number().min(0).max(720),
    defensive_sell_cooldown_hours: z.number().min(0).max(1440),

    options_enabled: z.boolean(),
    options_min_confidence: z.number().min(0).max(1),
    options_max_pct_per_trade: z.number().min(0).max(0.25),
    options_min_dte: z.number().int().min(1).max(365),
    options_max_dte: z.number().int().min(1).max(365),
    options_target_delta: z.number().min(0.1).max(0.9),
    options_min_delta: z.number().min(0.1).max(0.9),
    options_max_delta: z.number().min(0.1).max(0.9),
    options_max_spread_pct: z.number().min(0).max(100),
    options_early_loss_exit_enabled: z.boolean(),
    options_early_loss_exit_pct: z.number().min(0).max(100),
    options_early_loss_exit_max_hold_minutes: z.number().min(0).max(1440),
    options_stop_loss_pct: z.number().min(1).max(100),
    options_take_profit_pct: z.number().min(1).max(500),

    crypto_enabled: z.boolean(),
    crypto_symbols: z.array(z.string()),
    crypto_max_positions: z.number().int().min(1).max(50),
    crypto_momentum_threshold: z.number().min(0.1).max(20),
    crypto_max_momentum_pct: z.number().min(0).max(100),
    crypto_max_position_value: z.number().positive().max(100000),
    crypto_take_profit_pct: z.number().min(1).max(100),
    crypto_stop_loss_pct: z.number().min(1).max(50),

    ticker_blacklist: z.array(z.string()),
    allowed_exchanges: z.array(z.string()),
    starting_equity: z.number().positive().max(1_000_000_000),
    twitter_cookies: z.string().trim().max(20000),
    twitter_cookie_accounts: z.array(CookieAccountSchema).max(20),
    reddit_cookies: z.string().trim().max(20000),
    reddit_cookie_accounts: z.array(CookieAccountSchema).max(20),
    reddit_user_agent: z.string().trim().max(512),
    alpha_vantage_api_key: z.string().trim().max(256),
    discord_webhook_url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      }, "discord_webhook_url must be a valid URL"),
    discord_daily_report_enabled: z.boolean(),
    discord_daily_report_time: z.string().regex(/^\d{2}:\d{2}$/),
    discord_daily_report_timezone: z.string().min(1),
  })
  .refine((data) => data.options_min_delta < data.options_max_delta, {
    message: "options_min_delta must be less than options_max_delta",
    path: ["options_min_delta"],
  })
  .refine((data) => data.options_min_dte < data.options_max_dte, {
    message: "options_min_dte must be less than options_max_dte",
    path: ["options_min_dte"],
  })
  .refine((data) => data.stale_mid_hold_days <= data.stale_max_hold_days, {
    message: "stale_mid_hold_days must be <= stale_max_hold_days",
    path: ["stale_mid_hold_days"],
  })
  .refine((data) => data.entry_rsi_min <= data.entry_rsi_max, {
    message: "entry_rsi_min must be <= entry_rsi_max",
    path: ["entry_rsi_min"],
  })
  .refine((data) => data.profit_lock_activation_pct < data.breakeven_stop_activation_pct, {
    message: "profit_lock_activation_pct must be below breakeven_stop_activation_pct",
    path: ["profit_lock_activation_pct"],
  })
  .refine((data) => data.profit_lock_floor_pct <= data.profit_lock_activation_pct, {
    message: "profit_lock_floor_pct must be <= profit_lock_activation_pct",
    path: ["profit_lock_floor_pct"],
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function validateAgentConfig(config: unknown): AgentConfig {
  return AgentConfigSchema.parse(config);
}

export function safeValidateAgentConfig(
  config: unknown
): { success: true; data: AgentConfig } | { success: false; error: z.ZodError } {
  const result = AgentConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
