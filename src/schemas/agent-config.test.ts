import { describe, expect, it } from "vitest";
import { AgentConfigSchema, safeValidateAgentConfig, validateAgentConfig } from "./agent-config";

function createValidConfig() {
  return {
    data_poll_interval_ms: 30000,
    analyst_interval_ms: 120000,
    premarket_plan_window_minutes: 5,
    market_open_execute_window_minutes: 2,
    max_position_value: 5000,
    max_positions: 5,
    min_sentiment_score: 0.3,
    min_analyst_confidence: 0.6,
    signal_research_limit: 5,
    max_entry_research_age_minutes: 30,
    entry_candidate_limit: 3,
    min_entry_selection_score: 0.85,
    min_entry_quality: "good" as const,
    max_entry_red_flags: 0,
    min_entry_catalysts: 1,
    min_entry_signal_sources: 1,
    min_entry_signal_consensus: 0.15,
    single_source_entry_min_confidence: 0.82,
    exceptional_entry_confidence: 0.9,
    analyst_buy_requires_research_confirmation: true,
    llm_size_conviction_scaling: true,
    llm_size_low_confidence_multiplier: 0.4,
    llm_size_medium_confidence_multiplier: 0.7,
    equity_entry_cooldown_minutes_after_open: 10,
    equity_entry_cutoff_minutes_before_close: 15,
    max_entry_spread_pct: 0.8,
    min_entry_quote_size: 1,
    max_entry_price_change_pct: 5,
    bad_fill_exit_enabled: true,
    bad_fill_max_slippage_pct: 0.5,
    bad_fill_loss_pct: 0.5,
    bad_fill_max_hold_minutes: 30,
    early_loss_exit_enabled: true,
    early_loss_exit_pct: 2.5,
    early_loss_exit_max_hold_minutes: 90,
    after_hours_exit_limit_buffer_pct: 0.25,
    entry_timing_enabled: true,
    entry_rsi_min: 40,
    entry_rsi_max: 55,
    entry_bb_lower_threshold: 0.2,
    entry_max_intraday_range_position: 0.75,
    market_regime_enabled: true,
    regime_low_threshold: 0.5,
    regime_position_size_reduction: 0.45,
    portfolio_risk_enabled: true,
    max_positions_per_sector: 2,
    max_daily_loss_pct: 0.02,
    daily_loss_entry_guard_enabled: true,
    daily_loss_entry_guard_pct: 0.0075,
    daily_loss_guard_min_confidence: 0.8,
    daily_loss_guard_min_entry_quality: "good" as const,
    open_position_loss_entry_guard_enabled: true,
    open_position_loss_entry_guard_pct: 0.01,
    open_position_loss_guard_min_confidence: 0.85,
    open_position_loss_guard_min_entry_quality: "excellent" as const,
    cooldown_minutes_after_loss: 30,
    max_daily_entry_orders: 8,
    min_minutes_between_entries: 5,
    adaptive_performance_block_enabled: true,
    adaptive_performance_lookback_days: 90,
    adaptive_performance_min_trades: 3,
    adaptive_performance_min_win_rate: 0.35,
    llm_force_sell_pnl_pct: 2,
    llm_force_sell_min_confidence: 0.65,
    take_profit_pct: 10,
    stop_loss_pct: 5,
    trailing_stop_enabled: true,
    trailing_stop_activation_pct: 6,
    trailing_stop_drawdown_pct: 3,
    breakeven_stop_enabled: true,
    breakeven_stop_activation_pct: 4,
    breakeven_stop_buffer_pct: 0.25,
    profit_lock_stop_enabled: true,
    profit_lock_activation_pct: 3,
    profit_lock_floor_pct: 0.5,
    sentiment_reversal_exit_enabled: true,
    sentiment_reversal_min_hold_minutes: 60,
    sentiment_reversal_loss_pct: 1.5,
    sentiment_reversal_threshold: -0.25,
    sentiment_reversal_min_sources: 1,
    position_size_pct_of_cash: 10,
    equity_entry_cutoff_minutes_before_close: 15,
    after_hours_exit_limit_buffer_pct: 0.25,
    stale_position_enabled: true,
    stale_min_hold_hours: 4,
    stale_loss_exit_pct: 2,
    stale_max_hold_days: 7,
    stale_min_gain_pct: 5,
    stale_mid_hold_days: 3,
    stale_mid_min_gain_pct: 2,
    stale_social_volume_decay: 0.3,
    llm_provider: "openai-raw" as const,
    llm_model: "gpt-4o-mini",
    llm_analyst_model: "gpt-4o",
    openai_base_url: "",
    llm_min_hold_minutes: 30,
    recent_sell_cooldown_hours: 72,
    defensive_sell_cooldown_hours: 168,
    options_enabled: false,
    options_min_confidence: 0.8,
    options_max_pct_per_trade: 0.02,
    options_min_dte: 30,
    options_max_dte: 60,
    options_target_delta: 0.5,
    options_min_delta: 0.3,
    options_max_delta: 0.7,
    options_max_spread_pct: 8,
    options_early_loss_exit_enabled: true,
    options_early_loss_exit_pct: 25,
    options_early_loss_exit_max_hold_minutes: 60,
    options_stop_loss_pct: 50,
    options_take_profit_pct: 100,
    crypto_enabled: false,
    crypto_symbols: ["BTC/USD", "ETH/USD"],
    crypto_max_positions: 3,
    crypto_momentum_threshold: 2.0,
    crypto_max_momentum_pct: 12,
    crypto_max_position_value: 2000,
    crypto_take_profit_pct: 15,
    crypto_stop_loss_pct: 10,
    ticker_blacklist: [],
    allowed_exchanges: ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
    starting_equity: 100000,
    twitter_cookies: "",
    twitter_cookie_accounts: [],
    reddit_cookies: "",
    reddit_cookie_accounts: [],
    reddit_user_agent: "Mozilla/5.0",
    alpha_vantage_api_key: "",
    discord_webhook_url: "",
    discord_daily_report_enabled: false,
    discord_daily_report_time: "21:00",
    discord_daily_report_timezone: "Asia/Tokyo",
  };
}

describe("AgentConfigSchema", () => {
  describe("valid configurations", () => {
    it("accepts a valid configuration", () => {
      const config = createValidConfig();
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts all llm_provider values", () => {
      const providers = ["openai-raw", "ai-sdk", "cloudflare-gateway"] as const;
      for (const provider of providers) {
        const config = { ...createValidConfig(), llm_provider: provider };
        const result = AgentConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
      }
    });

    it("accepts empty ticker_blacklist", () => {
      const config = { ...createValidConfig(), ticker_blacklist: [] };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts populated ticker_blacklist", () => {
      const config = { ...createValidConfig(), ticker_blacklist: ["NET", "AAPL"] };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts stricter entry quality controls", () => {
      const config = {
        ...createValidConfig(),
        min_entry_quality: "excellent" as const,
        max_entry_red_flags: 1,
        min_entry_catalysts: 2,
        min_entry_signal_sources: 2,
        min_entry_signal_consensus: 0.25,
        exceptional_entry_confidence: 0.95,
        analyst_buy_requires_research_confirmation: false,
        signal_research_limit: 10,
        entry_candidate_limit: 5,
        llm_size_low_confidence_multiplier: 0.5,
        llm_size_medium_confidence_multiplier: 0.8,
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts a Discord webhook URL in agent config", () => {
      const config = {
        ...createValidConfig(),
        discord_webhook_url: "https://discord.com/api/webhooks/example/token",
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts Twitter/X cookies in agent config", () => {
      const config = {
        ...createValidConfig(),
        twitter_cookies: "auth_token=token; ct0=csrf",
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts rotating social cookie accounts in agent config", () => {
      const config = {
        ...createValidConfig(),
        twitter_cookie_accounts: [
          { label: "x-main", cookies: "auth_token=token1; ct0=csrf1" },
          { label: "x-backup", cookies: "auth_token=token2; ct0=csrf2" },
        ],
        reddit_cookie_accounts: [
          { label: "reddit-main", cookies: "reddit_session=session1; token_v2=token1" },
        ],
        reddit_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts an OpenAI-compatible base URL and starting equity", () => {
      const config = {
        ...createValidConfig(),
        openai_base_url: "https://gateway.example.com/v1",
        starting_equity: 250000,
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid configurations", () => {
    it("rejects negative max_position_value", () => {
      const config = { ...createValidConfig(), max_position_value: -1000 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects max_position_value over 100000", () => {
      const config = { ...createValidConfig(), max_position_value: 150000 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects zero max_positions", () => {
      const config = { ...createValidConfig(), max_positions: 0 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects signal_research_limit outside 1-20", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), signal_research_limit: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), signal_research_limit: 21 }).success).toBe(false);
    });

    it("rejects entry_candidate_limit outside 1-10", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), entry_candidate_limit: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), entry_candidate_limit: 11 }).success).toBe(false);
    });

    it("rejects sentiment scores outside 0-1 range", () => {
      const config = { ...createValidConfig(), min_sentiment_score: 1.5 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects negative sentiment scores", () => {
      const config = { ...createValidConfig(), min_sentiment_score: -0.5 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects invalid llm_provider", () => {
      const config = { ...createValidConfig(), llm_provider: "invalid-provider" };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects empty llm_model", () => {
      const config = { ...createValidConfig(), llm_model: "" };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects poll interval below minimum", () => {
      const config = { ...createValidConfig(), data_poll_interval_ms: 1000 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects poll interval above maximum", () => {
      const config = { ...createValidConfig(), data_poll_interval_ms: 500000 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects premarket_plan_window_minutes outside 1-60", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), premarket_plan_window_minutes: 0 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), premarket_plan_window_minutes: 61 }).success).toBe(
        false
      );
    });

    it("rejects market_open_execute_window_minutes outside 0-10", () => {
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), market_open_execute_window_minutes: -1 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), market_open_execute_window_minutes: 11 }).success
      ).toBe(false);
    });

    it("rejects stop_loss_pct over 50", () => {
      const config = { ...createValidConfig(), stop_loss_pct: 75 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects invalid trailing and breakeven controls", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), trailing_stop_activation_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), trailing_stop_drawdown_pct: 0 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), breakeven_stop_activation_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), breakeven_stop_buffer_pct: 11 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), profit_lock_activation_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), profit_lock_floor_pct: 11 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), sentiment_reversal_threshold: 0.1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), sentiment_reversal_min_sources: 0 }).success).toBe(
        false
      );
    });

    it("rejects invalid entry quality controls", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_quality: "weak" }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_entry_red_flags: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_signal_sources: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_signal_consensus: -0.1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_signal_consensus: 1.1 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), single_source_entry_min_confidence: -1 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), single_source_entry_min_confidence: 1.1 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), exceptional_entry_confidence: 1.2 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), signal_research_limit: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), entry_candidate_limit: 11 }).success).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), llm_size_low_confidence_multiplier: 0 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), adaptive_performance_lookback_days: 0 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), adaptive_performance_min_trades: 0 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), adaptive_performance_min_win_rate: 1.2 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_daily_loss_pct: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_daily_loss_pct: 1.2 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), daily_loss_entry_guard_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), daily_loss_guard_min_confidence: 1.2 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), open_position_loss_entry_guard_pct: -1 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), open_position_loss_entry_guard_pct: 1.2 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), open_position_loss_guard_min_confidence: 1.2 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), cooldown_minutes_after_loss: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), cooldown_minutes_after_loss: 1441 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_daily_entry_orders: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_daily_entry_orders: 101 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_minutes_between_entries: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_minutes_between_entries: 1441 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), equity_entry_cooldown_minutes_after_open: -1 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), equity_entry_cooldown_minutes_after_open: 121 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_selection_score: -0.1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_selection_score: 2.1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_entry_price_change_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), max_entry_price_change_pct: 101 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), entry_max_intraday_range_position: -0.1 }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), entry_max_intraday_range_position: 1.1 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_quote_size: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_entry_quote_size: 10001 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), bad_fill_max_slippage_pct: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), bad_fill_loss_pct: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), bad_fill_max_hold_minutes: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), early_loss_exit_pct: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), early_loss_exit_pct: 51 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), early_loss_exit_max_hold_minutes: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), defensive_sell_cooldown_hours: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), defensive_sell_cooldown_hours: 1441 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), options_max_spread_pct: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), options_max_spread_pct: 101 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), options_early_loss_exit_pct: -1 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), options_early_loss_exit_pct: 101 }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), options_early_loss_exit_max_hold_minutes: -1 }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), crypto_max_momentum_pct: -1 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), crypto_max_momentum_pct: 101 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), crypto_max_positions: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), crypto_max_positions: 51 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), discord_webhook_url: "not-a-url" }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), twitter_cookies: "x".repeat(20001) }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({
          ...createValidConfig(),
          twitter_cookie_accounts: [{ cookies: "" }],
        }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), reddit_cookies: "x".repeat(20001) }).success).toBe(
        false
      );
      expect(
        AgentConfigSchema.safeParse({ ...createValidConfig(), alpha_vantage_api_key: "x".repeat(257) }).success
      ).toBe(false);
      expect(
        AgentConfigSchema.safeParse({
          ...createValidConfig(),
          reddit_cookie_accounts: Array.from({ length: 21 }, (_, index) => ({
            label: `reddit-${index}`,
            cookies: "reddit_session=session",
          })),
        }).success
      ).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), openai_base_url: "not-a-url" }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), starting_equity: 0 }).success).toBe(false);
    });
  });

  describe("refinement validations", () => {
    it("rejects options_min_delta >= options_max_delta", () => {
      const config = { ...createValidConfig(), options_min_delta: 0.7, options_max_delta: 0.5 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("options_min_delta"))).toBe(true);
      }
    });

    it("rejects options_min_dte >= options_max_dte", () => {
      const config = { ...createValidConfig(), options_min_dte: 60, options_max_dte: 30 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects stale_mid_hold_days > stale_max_hold_days", () => {
      const config = { ...createValidConfig(), stale_mid_hold_days: 10, stale_max_hold_days: 5 };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects profit-lock activation at or above breakeven activation", () => {
      const config = {
        ...createValidConfig(),
        profit_lock_activation_pct: 4,
        breakeven_stop_activation_pct: 4,
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("profit_lock_activation_pct"))).toBe(true);
      }
    });

    it("rejects profit-lock floor above activation", () => {
      const config = {
        ...createValidConfig(),
        profit_lock_activation_pct: 3,
        profit_lock_floor_pct: 3.5,
      };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("profit_lock_floor_pct"))).toBe(true);
      }
    });
  });

  describe("validateAgentConfig", () => {
    it("returns parsed config on success", () => {
      const config = createValidConfig();
      const result = validateAgentConfig(config);
      expect(result.max_position_value).toBe(5000);
    });

    it("throws ZodError on invalid config", () => {
      const config = { ...createValidConfig(), max_position_value: -1 };
      expect(() => validateAgentConfig(config)).toThrow();
    });
  });

  describe("safeValidateAgentConfig", () => {
    it("returns success: true with data on valid config", () => {
      const config = createValidConfig();
      const result = safeValidateAgentConfig(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.max_position_value).toBe(5000);
      }
    });

    it("returns success: false with error on invalid config", () => {
      const config = { ...createValidConfig(), max_position_value: -1 };
      const result = safeValidateAgentConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
