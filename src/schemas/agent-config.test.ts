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
    signal_research_limit: 8,
    entry_candidate_limit: 5,
    take_profit_pct: 10,
    stop_loss_pct: 5,
    risk_per_trade_pct: 0.75,
    position_size_pct_of_cash: 10,
    equity_entry_cutoff_minutes_before_close: 15,
    after_hours_exit_limit_buffer_pct: 0.25,
    stale_position_enabled: true,
    stale_min_hold_hours: 4,
    stale_max_hold_days: 7,
    stale_min_gain_pct: 5,
    stale_mid_hold_days: 3,
    stale_mid_min_gain_pct: 2,
    stale_social_volume_decay: 0.3,
    llm_provider: "openai-raw" as const,
    llm_model: "gpt-4o-mini",
    llm_analyst_model: "gpt-4o",
    llm_api_key: "",
    openai_base_url: "",
    anthropic_base_url: "",
    llm_min_hold_minutes: 15,
    llm_force_sell_pnl_pct: 2,
    llm_force_sell_min_confidence: 0.65,
    llm_size_conviction_scaling: true,
    llm_size_low_confidence_multiplier: 0.4,
    llm_size_medium_confidence_multiplier: 0.7,
    options_enabled: false,
    options_min_confidence: 0.8,
    options_max_pct_per_trade: 0.02,
    options_min_dte: 30,
    options_max_dte: 60,
    options_target_delta: 0.5,
    options_min_delta: 0.3,
    options_max_delta: 0.7,
    options_stop_loss_pct: 50,
    options_take_profit_pct: 100,
    crypto_enabled: false,
    crypto_symbols: ["BTC/USD", "ETH/USD"],
    crypto_momentum_threshold: 2.0,
    crypto_max_position_value: 2000,
    crypto_take_profit_pct: 15,
    crypto_stop_loss_pct: 10,
    ticker_blacklist: [],
    allowed_exchanges: ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
    discord_daily_report_enabled: false,
    discord_daily_report_time: "21:00",
    discord_daily_report_timezone: "Asia/Tokyo",
    trailing_stop_enabled: true,
    trailing_stop_pct: 3.5,
    trailing_stop_activation_pct: 5,
    dynamic_tp_enabled: true,
    tp_atr_multiplier: 3,
    tp_min_pct: 5,
    tp_max_pct: 25,
    dynamic_tp_fallback_pct: 12,
    entry_timing_enabled: true,
    entry_require_technical_data: false,
    entry_rsi_min: 40,
    entry_rsi_max: 55,
    entry_bb_lower_threshold: 0.2,
    min_signal_quality_score: 0.35,
    scoring_enabled: true,
    scoring_sentiment_weight: 0.3,
    scoring_technical_weight: 0.35,
    scoring_catalyst_weight: 0.2,
    scoring_momentum_weight: 0.15,
    market_regime_enabled: true,
    regime_low_threshold: 0.5,
    regime_position_size_reduction: 0.45,
    portfolio_risk_enabled: true,
    max_positions_per_sector: 2,
    unknown_sector_max_positions: 2,
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

    it("rejects invalid risk controls", () => {
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), risk_per_trade_pct: 0 }).success).toBe(false);
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), min_signal_quality_score: 1.5 }).success).toBe(
        false
      );
      expect(AgentConfigSchema.safeParse({ ...createValidConfig(), unknown_sector_max_positions: -1 }).success).toBe(
        false
      );
    });

    it("rejects invalid discord daily report time", () => {
      const config = { ...createValidConfig(), discord_daily_report_time: "25:99" };
      const result = AgentConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
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
