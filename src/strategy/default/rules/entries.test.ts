import { describe, expect, it } from "vitest";
import type { Account, ResearchResult } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { selectEntries } from "./entries";

function createTestContext(): StrategyContext {
  const state = new Map<string, unknown>();

  return {
    env: {} as never,
    config: {
      ...DEFAULT_CONFIG,
      scoring_enabled: false,
      entry_timing_enabled: false,
      market_regime_enabled: false,
      portfolio_risk_enabled: false,
      min_analyst_confidence: 0.6,
      position_size_pct_of_cash: 10,
      max_position_value: 5000,
    },
    llm: null,
    log: () => {},
    trackLLMCost: () => 0,
    sleep: async () => {},
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
      get: <T>(key: string) => state.get(key) as T | undefined,
      set: <T>(key: string, value: T) => void state.set(key, value),
    },
    signals: [],
    positionEntries: {},
  };
}

function createAccount(): Account {
  return {
    id: "acct",
    account_number: "ACCT",
    status: "ACTIVE",
    currency: "USD",
    cash: 10_000,
    buying_power: 20_000,
    regt_buying_power: 20_000,
    daytrading_buying_power: 0,
    equity: 10_000,
    last_equity: 10_000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 10_000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "2",
    shorting_enabled: true,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: new Date().toISOString(),
  };
}

function createResearchResult(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    symbol: "NOW",
    verdict: "WAIT",
    confidence: 0.56,
    entry_quality: "fair",
    reasoning: "Needs one more push but is nearly actionable.",
    red_flags: [],
    catalysts: ["Enterprise software momentum"],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("selectEntries", () => {
  it("does not promote WAIT verdicts into entries", () => {
    const ctx = createTestContext();
    const account = createAccount();

    const result = selectEntries(ctx, [createResearchResult()], [], account);

    expect(result).toHaveLength(0);
  });

  it("does not promote poor-quality WAIT verdicts", () => {
    const ctx = createTestContext();
    const account = createAccount();

    const result = selectEntries(
      ctx,
      [createResearchResult({ entry_quality: "poor", confidence: 0.72, reasoning: "Too noisy." })],
      [],
      account
    );

    expect(result).toHaveLength(0);
  });

  it("does not promote WAIT verdicts with multiple red flags", () => {
    const ctx = createTestContext();
    const account = createAccount();

    const result = selectEntries(
      ctx,
      [createResearchResult({ red_flags: ["Dilution risk", "Weak volume"], confidence: 0.7 })],
      [],
      account
    );

    expect(result).toHaveLength(0);
  });

  it("does not promote excellent WAIT verdicts without an explicit BUY", () => {
    const ctx = createTestContext();
    const account = createAccount();

    const result = selectEntries(
      ctx,
      [createResearchResult({ entry_quality: "excellent", confidence: 0.58, reasoning: "Strong but not confirmed." })],
      [],
      account
    );

    expect(result).toHaveLength(0);
  });

  it("uses the configured position size without a hard 20 percent cap", () => {
    const ctx = createTestContext();
    const account = createAccount();
    ctx.config.position_size_pct_of_cash = 25;

    const result = selectEntries(
      ctx,
      [createResearchResult({ verdict: "BUY", confidence: 0.6, entry_quality: "good" })],
      [],
      account
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.notional).toBeCloseTo(1500);
  });
});
