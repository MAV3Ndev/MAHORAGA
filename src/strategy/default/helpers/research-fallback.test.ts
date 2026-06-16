import { describe, expect, it } from "vitest";
import type { Account, AgentConfig } from "../../../core/types";
import {
  buildCryptoFallbackResearch,
  buildSignalFallbackResearch,
  canReuseStaleResearch,
  isLikelyLLMRateLimit,
} from "./research-fallback";

function createConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    data_poll_interval_ms: 30_000,
    analyst_interval_ms: 120_000,
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
    position_size_pct_of_cash: 25,
    equity_entry_cutoff_minutes_before_close: 15,
    after_hours_exit_limit_buffer_pct: 0.25,
    stale_position_enabled: true,
    stale_min_hold_hours: 24,
    stale_max_hold_days: 3,
    stale_min_gain_pct: 5,
    stale_mid_hold_days: 2,
    stale_mid_min_gain_pct: 3,
    stale_social_volume_decay: 0.3,
    llm_provider: "openai-raw",
    llm_model: "gpt-4o-mini",
    llm_analyst_model: "gpt-4o",
    openai_base_url: "",
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
    options_target_delta: 0.45,
    options_min_delta: 0.3,
    options_max_delta: 0.7,
    options_stop_loss_pct: 50,
    options_take_profit_pct: 100,
    options_max_spread_pct: 8,
    crypto_enabled: true,
    crypto_symbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
    crypto_momentum_threshold: 2,
    crypto_max_position_value: 1000,
    crypto_take_profit_pct: 10,
    crypto_stop_loss_pct: 5,
    twitter_cookies: "",
    twitter_cookie_accounts: [],
    reddit_cookies: "",
    reddit_cookie_accounts: [],
    reddit_user_agent: "",
    alpha_vantage_api_key: "",
    ticker_blacklist: [],
    allowed_exchanges: ["NYSE", "NASDAQ"],
    discord_daily_report_enabled: false,
    discord_daily_report_time: "21:00",
    discord_daily_report_timezone: "UTC",
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
    ...overrides,
  };
}

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "test-account",
    account_number: "12345",
    status: "ACTIVE",
    currency: "USD",
    cash: 1000,
    buying_power: 2000,
    regt_buying_power: 2000,
    daytrading_buying_power: 0,
    equity: 2000,
    last_equity: 2000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 2000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: false,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function createContext() {
  const config = createConfig();
  return {
    env: {} as never,
    config,
    llm: null,
    log: () => {},
    trackLLMCost: () => 0,
    sleep: async () => {},
    getAvailableBuyFunds: (account: Account) => account.buying_power,
    calculateEntryNotional: (account: Account, confidence: number, maxPositionValue: number) =>
      Math.min(account.buying_power * 0.2 * confidence, maxPositionValue),
    broker: {
      getAccount: async () => createAccount(),
      getPositions: async () => [],
      getClock: async () => ({
        timestamp: new Date().toISOString(),
        is_open: true,
        next_open: new Date().toISOString(),
        next_close: new Date().toISOString(),
      }),
      buy: async () => true,
      buyOption: async () => true,
      sell: async () => true,
      syncProtectiveStops: async () => {},
    },
    state: {
      get: () => undefined,
      set: () => {},
    },
    signals: [],
    positionEntries: {},
  };
}

describe("research fallback helpers", () => {
  it("detects likely rate limit errors", () => {
    expect(isLikelyLLMRateLimit("OpenAI API error (429): rate limit")).toBe(true);
    expect(isLikelyLLMRateLimit("Fair Usage Policy restriction")).toBe(true);
    expect(isLikelyLLMRateLimit("socket hang up")).toBe(false);
  });

  it("reuses stale research only within the fallback window", () => {
    expect(
      canReuseStaleResearch({
        symbol: "AAPL",
        verdict: "BUY",
        confidence: 0.7,
        entry_quality: "good",
        reasoning: "cached",
        red_flags: [],
        catalysts: [],
        timestamp: Date.now() - 60_000,
      })
    ).toBe(true);

    expect(
      canReuseStaleResearch({
        symbol: "AAPL",
        verdict: "BUY",
        confidence: 0.7,
        entry_quality: "good",
        reasoning: "old",
        red_flags: [],
        catalysts: [],
        timestamp: Date.now() - 7 * 60 * 60 * 1000,
      })
    ).toBe(false);
  });

  it("creates a conservative BUY fallback for strong multi-source stock sentiment", () => {
    const ctx = createContext();
    const result = buildSignalFallbackResearch(ctx, "LRHC", 0.92, ["reddit", "twitter"], "LLM rate-limited");

    expect(result.verdict).toBe("BUY");
    expect(result.confidence).toBeGreaterThanOrEqual(ctx.config.min_analyst_confidence);
    expect(result.entry_quality).toBe("good");
  });

  it("creates a BUY fallback for strong crypto momentum", () => {
    const ctx = createContext();
    const result = buildCryptoFallbackResearch(ctx, "BTC/USD", 4.2, 0.7, "LLM rate-limited");

    expect(result.verdict).toBe("BUY");
    expect(result.confidence).toBeGreaterThanOrEqual(ctx.config.min_analyst_confidence);
  });

  it("stays out of weak crypto setups", () => {
    const ctx = createContext();
    const result = buildCryptoFallbackResearch(ctx, "SOL/USD", 0.6, 0.1, "LLM rate-limited");

    expect(result.verdict).toBe("SKIP");
  });
});
