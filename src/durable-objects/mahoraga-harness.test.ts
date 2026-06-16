import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentConfigSchema } from "../schemas/agent-config";
import { DEFAULT_CONFIG } from "../strategy/default/config";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

let summarizeRuntimeLogs: typeof import("./mahoraga-harness").summarizeRuntimeLogs;
let buildTradeReviewSummary: typeof import("./mahoraga-harness").buildTradeReviewSummary;
let buildTradeReviewTuningSuggestions: typeof import("./mahoraga-harness").buildTradeReviewTuningSuggestions;
let buildDeferredBuyJournalSignals: typeof import("./mahoraga-harness").buildDeferredBuyJournalSignals;
let mergeAgentConfigWithDefaults: typeof import("./mahoraga-harness").mergeAgentConfigWithDefaults;
let buildRecoveredPositionEntryFromJournal: typeof import("./mahoraga-harness").buildRecoveredPositionEntryFromJournal;
let shouldCancelStaleDeferredBuyOrder: typeof import("./mahoraga-harness").shouldCancelStaleDeferredBuyOrder;
let shouldCancelStaleDeferredSellOrder: typeof import("./mahoraga-harness").shouldCancelStaleDeferredSellOrder;
let isDeferredSellComplete: typeof import("./mahoraga-harness").isDeferredSellComplete;
let buildOptionsOrderFillSnapshot: typeof import("./mahoraga-harness").buildOptionsOrderFillSnapshot;
let evaluateOptionEntryQuote: typeof import("./mahoraga-harness").evaluateOptionEntryQuote;
let evaluateOptionsEarlyLossExit: typeof import("./mahoraga-harness").evaluateOptionsEarlyLossExit;
let evaluateEntryIntradayRangePosition: typeof import("./mahoraga-harness").evaluateEntryIntradayRangePosition;
let buildSignalResearchCandidates: typeof import("./mahoraga-harness").buildSignalResearchCandidates;
let buildFreshSignalCache: typeof import("./mahoraga-harness").buildFreshSignalCache;
let pruneSignalResearchMap: typeof import("./mahoraga-harness").pruneSignalResearchMap;
let findSignalForSymbolByAlias: typeof import("./mahoraga-harness").findSignalForSymbolByAlias;
let findSocialSnapshotForSymbolByAlias: typeof import("./mahoraga-harness").findSocialSnapshotForSymbolByAlias;
let getMarketClockMinutesToClose: typeof import("./mahoraga-harness").getMarketClockMinutesToClose;
let getMarketClockMinutesSinceOpen: typeof import("./mahoraga-harness").getMarketClockMinutesSinceOpen;
let sanitizeSignalResearchResult: typeof import("./mahoraga-harness").sanitizeSignalResearchResult;
let sanitizeAnalystRecommendations: typeof import("./mahoraga-harness").sanitizeAnalystRecommendations;
let sanitizePositionResearchResult: typeof import("./mahoraga-harness").sanitizePositionResearchResult;

function expectSuggestionPatchesToBeSchemaValid(
  suggestions: Array<{ proposed_config_patch?: Record<string, unknown> }>
) {
  for (const suggestion of suggestions) {
    if (!suggestion.proposed_config_patch) continue;
    const result = AgentConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...suggestion.proposed_config_patch });
    expect(result.success, JSON.stringify(suggestion.proposed_config_patch)).toBe(true);
  }
}

beforeAll(async () => {
  const harness = await import("./mahoraga-harness");
  summarizeRuntimeLogs = harness.summarizeRuntimeLogs;
  buildTradeReviewSummary = harness.buildTradeReviewSummary;
  buildTradeReviewTuningSuggestions = harness.buildTradeReviewTuningSuggestions;
  buildDeferredBuyJournalSignals = harness.buildDeferredBuyJournalSignals;
  mergeAgentConfigWithDefaults = harness.mergeAgentConfigWithDefaults;
  buildRecoveredPositionEntryFromJournal = harness.buildRecoveredPositionEntryFromJournal;
  shouldCancelStaleDeferredBuyOrder = harness.shouldCancelStaleDeferredBuyOrder;
  shouldCancelStaleDeferredSellOrder = harness.shouldCancelStaleDeferredSellOrder;
  isDeferredSellComplete = harness.isDeferredSellComplete;
  buildOptionsOrderFillSnapshot = harness.buildOptionsOrderFillSnapshot;
  evaluateOptionEntryQuote = harness.evaluateOptionEntryQuote;
  evaluateOptionsEarlyLossExit = harness.evaluateOptionsEarlyLossExit;
  evaluateEntryIntradayRangePosition = harness.evaluateEntryIntradayRangePosition;
  buildSignalResearchCandidates = harness.buildSignalResearchCandidates;
  buildFreshSignalCache = harness.buildFreshSignalCache;
  pruneSignalResearchMap = harness.pruneSignalResearchMap;
  findSignalForSymbolByAlias = harness.findSignalForSymbolByAlias;
  findSocialSnapshotForSymbolByAlias = harness.findSocialSnapshotForSymbolByAlias;
  getMarketClockMinutesToClose = harness.getMarketClockMinutesToClose;
  getMarketClockMinutesSinceOpen = harness.getMarketClockMinutesSinceOpen;
  sanitizeSignalResearchResult = harness.sanitizeSignalResearchResult;
  sanitizeAnalystRecommendations = harness.sanitizeAnalystRecommendations;
  sanitizePositionResearchResult = harness.sanitizePositionResearchResult;
}, 30_000);

describe("MahoragaHarness runtime summary helpers", () => {
  it("backfills new config keys when merging older persisted configs", () => {
    const legacyConfig = { ...DEFAULT_CONFIG } as Partial<typeof DEFAULT_CONFIG>;
    delete legacyConfig.max_entry_price_change_pct;

    const merged = mergeAgentConfigWithDefaults(legacyConfig);
    const result = AgentConfigSchema.safeParse(merged);

    expect(result.success).toBe(true);
    expect(merged.max_entry_price_change_pct).toBe(DEFAULT_CONFIG.max_entry_price_change_pct);
  });

  it("recovers position entry timing and lifecycle metadata from open journal rows", () => {
    const entry = buildRecoveredPositionEntryFromJournal(
      {
        symbol: "AAPL",
        entry_price: 100,
        entry_at: "2026-06-05T14:30:00.000Z",
        created_at: "2026-06-05T14:31:00.000Z",
        notes: "Recovered journal entry",
        signals_json: JSON.stringify({
          reason: "High quality entry",
          confidence: 0.82,
          sources: ["stocktwits", "reddit"],
          lifecycle: {
            peak_price: 106,
            trough_price: 98,
          },
        }),
      },
      {
        symbol: "AAPL",
        avg_entry_price: 101,
        current_price: 104,
        lastday_price: 103,
      }
    );

    expect(entry).toEqual(
      expect.objectContaining({
        symbol: "AAPL",
        entry_time: new Date("2026-06-05T14:30:00.000Z").getTime(),
        entry_price: 100,
        entry_sentiment: 0.82,
        entry_sources: ["stocktwits", "reddit"],
        entry_reason: "High quality entry",
        peak_price: 106,
        trough_price: 98,
      })
    );
  });

  it("restores original entry metadata when reconciling deferred buy fills", () => {
    const signals = buildDeferredBuyJournalSignals(
      {
        reason: "High-quality delayed entry",
        metadata: {
          entry_path: "strategy_select_entries",
          confidence: 0.92,
          entry_quality: "excellent",
          portfolio_bucket: "technology",
        },
        policy: {
          quote_spread_pct: 0.3,
        },
      },
      {
        reason: "deferred_buy_fill_reconciliation",
        alpaca_order_id: "order-delayed",
        order_status: "filled",
      }
    );

    expect(signals).toEqual(
      expect.objectContaining({
        reason: "High-quality delayed entry",
        entry_path: "strategy_select_entries",
        confidence: 0.92,
        entry_quality: "excellent",
        portfolio_bucket: "technology",
        alpaca_order_id: "order-delayed",
        order_status: "filled",
        reconciled_from_deferred_buy: true,
        policy: expect.objectContaining({ quote_spread_pct: 0.3 }),
      })
    );
  });

  it("validates option entry quotes before placing a limit order", () => {
    expect(evaluateOptionEntryQuote({ bid_price: 1.9, ask_price: 2.1 }, 10)).toEqual(
      expect.objectContaining({
        allowed: true,
        bid: 1.9,
        ask: 2.1,
        midPrice: 2,
        spreadPct: expect.closeTo(9.5238, 4),
      })
    );

    expect(evaluateOptionEntryQuote({ bid_price: 1, ask_price: 1.3 }, 10)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "wide_spread",
        spreadPct: expect.closeTo(23.0769, 4),
      })
    );

    expect(evaluateOptionEntryQuote({ bid_price: 0, ask_price: 1.3 }, 10)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "invalid_bid_ask",
      })
    );
  });

  it("evaluates options early-loss exits inside the configured window", () => {
    const now = Date.parse("2026-06-05T15:30:00.000Z");
    const config = {
      options_early_loss_exit_enabled: true,
      options_early_loss_exit_pct: 25,
      options_early_loss_exit_max_hold_minutes: 60,
    };

    expect(evaluateOptionsEarlyLossExit(-26, now - 45 * 60_000, config, now)).toEqual(
      expect.objectContaining({
        shouldExit: true,
        holdMinutes: 45,
        reason: "Options early loss exit at -26.0% after 45m",
      })
    );
    expect(evaluateOptionsEarlyLossExit(-24.9, now - 45 * 60_000, config, now).shouldExit).toBe(false);
    expect(evaluateOptionsEarlyLossExit(-26, now - 75 * 60_000, config, now).shouldExit).toBe(false);
    expect(
      evaluateOptionsEarlyLossExit(
        -26,
        now - 45 * 60_000,
        { ...config, options_early_loss_exit_enabled: false },
        now
      ).shouldExit
    ).toBe(false);
  });

  it("evaluates intraday range-position entry timing", () => {
    expect(
      evaluateEntryIntradayRangePosition(
        {
          latest_trade: { price: 109 },
          daily_bar: { h: 110, l: 100, c: 108 },
        },
        0.75
      )
    ).toEqual(
      expect.objectContaining({
        blocked: true,
        reason: "near_intraday_range_high",
        rangePosition: 0.9,
        currentPrice: 109,
      })
    );

    expect(
      evaluateEntryIntradayRangePosition(
        {
          latest_trade: { price: 105 },
          daily_bar: { h: 110, l: 100, c: 105 },
        },
        0.75
      )
    ).toEqual(expect.objectContaining({ blocked: false, rangePosition: 0.5, currentPrice: 105 }));

    expect(evaluateEntryIntradayRangePosition(null, 0.75)).toEqual(
      expect.objectContaining({ blocked: false, rangePosition: null })
    );
  });

  it("counts independent providers when ranking signal research candidates", () => {
    const now = Date.now();
    const signals = [
      {
        symbol: "AAA",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.7,
        raw_sentiment: 0.7,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "bullish",
        timestamp: now,
      },
      {
        symbol: "AAA",
        source: "reddit",
        source_detail: "reddit_wallstreetbets",
        sentiment: 0.7,
        raw_sentiment: 0.7,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "bullish",
        timestamp: now,
      },
      {
        symbol: "BBB",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.7,
        raw_sentiment: 0.7,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "bullish",
        timestamp: now,
      },
      {
        symbol: "BBB",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.7,
        raw_sentiment: 0.7,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "bullish",
        timestamp: now,
      },
      {
        symbol: "CCC",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.2,
        raw_sentiment: 0.2,
        volume: 10,
        freshness: 1,
        source_weight: 1,
        reason: "weak",
        timestamp: now,
      },
      {
        symbol: "HELD",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.9,
        raw_sentiment: 0.9,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "already held",
        timestamp: now,
      },
    ];

    const candidates = buildSignalResearchCandidates(signals, new Set(["HELD"]), 0.3, 10);

    expect(candidates[0]).toEqual(expect.objectContaining({ symbol: "BBB" }));
    expect(candidates.find((candidate) => candidate.symbol === "BBB")?.sources.sort()).toEqual([
      "reddit",
      "stocktwits",
    ]);
    expect(candidates.find((candidate) => candidate.symbol === "AAA")?.sources).toEqual(["reddit"]);
    expect(candidates.some((candidate) => candidate.symbol === "CCC")).toBe(false);
    expect(candidates.some((candidate) => candidate.symbol === "HELD")).toBe(false);
  });

  it("deduplicates fresh signals by normalized symbol and source detail", () => {
    const now = Date.now();
    const signals = [
      {
        symbol: "SOLUSD",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.4,
        raw_sentiment: 0.4,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "older duplicate",
        timestamp: now - 1_000,
      },
      {
        symbol: "SOL/USD",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.7,
        raw_sentiment: 0.7,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "newer duplicate",
        timestamp: now,
      },
      {
        symbol: "SOL/USD",
        source: "stocktwits",
        source_detail: "stocktwits_trending",
        sentiment: 0.6,
        raw_sentiment: 0.6,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "independent provider",
        timestamp: now,
      },
      {
        symbol: "OLD",
        source: "reddit",
        source_detail: "reddit_stocks",
        sentiment: 0.9,
        raw_sentiment: 0.9,
        volume: 1,
        freshness: 1,
        source_weight: 1,
        reason: "stale",
        timestamp: now - 31 * 60_000,
      },
    ];

    const cache = buildFreshSignalCache(signals, now, 30 * 60_000, 10);

    expect(cache).toHaveLength(2);
    expect(cache.map((signal) => signal.reason)).toEqual(["newer duplicate", "independent provider"]);
    expect(cache.some((signal) => signal.symbol === "OLD")).toBe(false);
  });

  it("prunes stale entry research using the configured trading freshness window", () => {
    const now = Date.now();
    const research = pruneSignalResearchMap(
      {
        "SOL/USD": {
          symbol: "SOL/USD",
          verdict: "BUY",
          confidence: 0.8,
          entry_quality: "good",
          reasoning: "old",
          red_flags: [],
          catalysts: ["breakout"],
          timestamp: now - 31 * 60_000,
        },
        SOLUSD: {
          symbol: "SOLUSD",
          verdict: "BUY",
          confidence: 0.9,
          entry_quality: "excellent",
          reasoning: "fresh",
          red_flags: [],
          catalysts: ["breakout"],
          timestamp: now - 5 * 60_000,
        },
        AAPL: {
          symbol: "AAPL",
          verdict: "WAIT",
          confidence: 0.6,
          entry_quality: "fair",
          reasoning: "too old",
          red_flags: [],
          catalysts: [],
          timestamp: now - 45 * 60_000,
        },
      },
      now,
      30 * 60_000
    );

    expect(Object.keys(research)).toEqual(["SOL/USD"]);
    expect(research["SOL/USD"]).toEqual(expect.objectContaining({ symbol: "SOL/USD", reasoning: "fresh" }));
  });

  it("resolves signals and social snapshots across normalized symbol aliases", () => {
    const now = Date.now();
    const signal = {
      symbol: "SOL/USD",
      source: "stocktwits",
      source_detail: "stocktwits_trending",
      sentiment: 0.8,
      raw_sentiment: 0.8,
      volume: 12,
      freshness: 1,
      source_weight: 1,
      reason: "crypto alias",
      timestamp: now,
    };
    const snapshot = {
      "SOL/USD": {
        volume: 12,
        sentiment: 0.8,
        sources: ["stocktwits_trending"],
      },
    };

    expect(findSignalForSymbolByAlias([signal], "SOLUSD")).toBe(signal);
    expect(findSocialSnapshotForSymbolByAlias(snapshot, "SOLUSD")).toEqual(snapshot["SOL/USD"]);
  });

  it("uses the broker market clock timestamp when calculating minutes to close", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00.000Z"));

    expect(
      getMarketClockMinutesToClose({
        timestamp: "2026-06-05T19:50:00.000Z",
        next_close: "2026-06-05T20:00:00.000Z",
      })
    ).toBe(10);
    vi.useRealTimers();
  });

  it("uses the broker market clock timestamp when calculating minutes since open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00.000Z"));

    expect(
      getMarketClockMinutesSinceOpen({
        timestamp: "2026-06-05T13:37:00.000Z",
      })
    ).toBe(7);
    vi.useRealTimers();
  });

  it("sanitizes malformed signal research values before entry selection can use them", () => {
    const result = sanitizeSignalResearchResult(
      {
        verdict: "BUY_NOW",
        confidence: 5,
        entry_quality: "perfect",
        reasoning: "x".repeat(1_200),
        red_flags: ["first", 123, "second"],
        catalysts: Array.from({ length: 12 }, (_, index) => `catalyst-${index}`),
      },
      "AAPL",
      123
    );

    expect(result).toEqual(
      expect.objectContaining({
        symbol: "AAPL",
        verdict: "WAIT",
        confidence: 0,
        entry_quality: "poor",
        red_flags: ["first", "second"],
        timestamp: 123,
      })
    );
    expect(result.reasoning).toHaveLength(1_000);
    expect(result.catalysts).toHaveLength(10);
  });

  it("normalizes unsafe analyst recommendations to non-trading defaults", () => {
    const recommendations = sanitizeAnalystRecommendations([
      {
        action: "STRONG_BUY",
        symbol: " aapl ",
        confidence: "1.4",
        reasoning: "",
        suggested_size_pct: 250,
      },
      {
        action: "SELL",
        symbol: "MSFT",
        confidence: -2,
        reasoning: "Risk has increased",
        suggested_size_pct: -10,
      },
      { action: "BUY", confidence: 0.9 },
    ]);

    expect(recommendations).toEqual([
      {
        action: "HOLD",
        symbol: "AAPL",
        confidence: 0,
        reasoning: "LLM analyst output missing usable reasoning",
        suggested_size_pct: 100,
      },
      {
        action: "SELL",
        symbol: "MSFT",
        confidence: 0,
        reasoning: "Risk has increased",
        suggested_size_pct: 0,
      },
    ]);
  });

  it("sanitizes malformed position research before persisting held-position analysis", () => {
    const result = sanitizePositionResearchResult(
      {
        recommendation: "DOUBLE_DOWN",
        risk_level: "catastrophic",
        reasoning: "y".repeat(1_200),
        key_factors: ["earnings", 42, "reversal"],
      },
      456
    );

    expect(result).toEqual(
      expect.objectContaining({
        recommendation: "HOLD",
        risk_level: "medium",
        key_factors: ["earnings", "reversal"],
        timestamp: 456,
      })
    );
    expect(result.reasoning).toHaveLength(1_000);
  });

  it("cancels stale deferred buy orders before old signals can fill later", () => {
    const nowMs = new Date("2026-06-06T15:00:00.000Z").getTime();

    expect(
      shouldCancelStaleDeferredBuyOrder(
        { status: "accepted", submitted_at: "2026-06-06T14:20:00.000Z" },
        30,
        nowMs
      )
    ).toEqual({ cancel: true, ageMinutes: 40 });
    expect(
      shouldCancelStaleDeferredBuyOrder(
        { status: "accepted", submitted_at: "2026-06-06T14:45:00.000Z" },
        30,
        nowMs
      )
    ).toEqual({ cancel: false, ageMinutes: 15 });
    expect(
      shouldCancelStaleDeferredBuyOrder(
        { status: "partially_filled", submitted_at: "2026-06-06T14:00:00.000Z" },
        30,
        nowMs
      )
    ).toEqual({ cancel: false, ageMinutes: null });
  });

  it("cancels stale deferred sell orders so exits can be repriced", () => {
    const nowMs = new Date("2026-06-06T15:00:00.000Z").getTime();

    expect(
      shouldCancelStaleDeferredSellOrder(
        { status: "accepted", submitted_at: "2026-06-06T14:40:00.000Z" },
        15,
        nowMs
      )
    ).toEqual({ cancel: true, ageMinutes: 20 });
    expect(
      shouldCancelStaleDeferredSellOrder(
        { status: "new", submitted_at: "2026-06-06T14:50:00.000Z" },
        15,
        nowMs
      )
    ).toEqual({ cancel: false, ageMinutes: 10 });
    expect(
      shouldCancelStaleDeferredSellOrder(
        { status: "partially_filled", submitted_at: "2026-06-06T14:00:00.000Z" },
        15,
        nowMs
      )
    ).toEqual({ cancel: false, ageMinutes: null });
  });

  it("does not treat partial deferred sell fills as completed exits", () => {
    expect(isDeferredSellComplete({ status: "filled" })).toBe(true);
    expect(isDeferredSellComplete({ status: "partially_filled" })).toBe(false);
    expect(isDeferredSellComplete({ status: "PARTIALLY_FILLED" })).toBe(false);
    expect(isDeferredSellComplete({ status: "new" })).toBe(false);
  });

  it("builds numeric options fill snapshots without leaking invalid values", () => {
    expect(
      buildOptionsOrderFillSnapshot({ status: "partially_filled", filled_qty: "2", filled_avg_price: "1.25" }, 1.3)
    ).toEqual({
      status: "partially_filled",
      filled_qty: 2,
      filled_avg_price: 1.25,
      filled_notional: 250,
    });

    expect(buildOptionsOrderFillSnapshot({ status: "accepted", filled_qty: "0", filled_avg_price: "NaN" }, 1.3)).toEqual({
      status: "accepted",
      filled_qty: null,
      filled_avg_price: null,
      filled_notional: 0,
    });
  });

  it("groups missed entry evaluations by blocked action and reason", () => {
    const summary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "Analyst",
        action: "missed_entry_evaluated",
        symbol: "AAPL",
        reason: "timing_gate",
        blocked_action: "llm_buy_skipped_timing_gate",
        change_pct: 3.2,
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "System",
        action: "missed_entry_evaluated",
        symbol: "MSFT",
        reason: "quality_gate",
        blocked_action: "premarket_buy_skipped_quality_gate",
        change_pct: -2.4,
      },
      {
        timestamp: "2026-06-06T00:10:00.000Z",
        agent: "System",
        action: "missed_entry_evaluated",
        symbol: "NVDA",
        reason: "timing_gate",
        blocked_action: "llm_buy_skipped_timing_gate",
        change_pct: 1.1,
      },
    ]);

    const pipeline = summary.entry_pipeline as Record<string, unknown>;
    expect(pipeline.missed_entry_evaluated).toBe(3);
    expect(pipeline.missed_entry_would_have_won).toBe(1);
    expect(pipeline.missed_entry_would_have_lost).toBe(1);
    expect(pipeline.missed_entry_reasons).toEqual([
      {
        action: "llm_buy_skipped_timing_gate",
        reason: "timing_gate",
        evaluated: 2,
        would_have_won: 1,
        would_have_lost: 0,
        symbols: ["AAPL", "NVDA"],
      },
      {
        action: "premarket_buy_skipped_quality_gate",
        reason: "quality_gate",
        evaluated: 1,
        would_have_won: 0,
        would_have_lost: 1,
        symbols: ["MSFT"],
      },
    ]);
  });

  it("includes the top missed entry reason in tuning suggestions", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "Analyst",
        action: "missed_entry_evaluated",
        symbol: "AAPL",
        reason: "timing_gate",
        blocked_action: "llm_buy_skipped_timing_gate",
        change_pct: 3.2,
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "Analyst",
        action: "missed_entry_evaluated",
        symbol: "NVDA",
        reason: "timing_gate",
        blocked_action: "llm_buy_skipped_timing_gate",
        change_pct: 2.4,
      },
      {
        timestamp: "2026-06-06T00:10:00.000Z",
        agent: "System",
        action: "missed_entry_evaluated",
        symbol: "MSFT",
        reason: "quality_gate",
        blocked_action: "premarket_buy_skipped_quality_gate",
        change_pct: -2.4,
      },
    ]);

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);
    const missedEntrySuggestion = suggestions.find((suggestion) =>
      suggestion.target.startsWith("missed_entry_opportunities")
    );

    expect(missedEntrySuggestion?.target).toBe("missed_entry_opportunities:timing_gate");
    expect(missedEntrySuggestion?.evidence.top_missed_entry_reason).toEqual({
      action: "llm_buy_skipped_timing_gate",
      reason: "timing_gate",
      evaluated: 2,
      would_have_won: 2,
      would_have_lost: 0,
      symbols: ["AAPL", "NVDA"],
    });
  });

  it("adds reason-specific tuning keys for winning missed low-consensus entries", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "System",
        action: "missed_entry_evaluated",
        symbol: "AAPL",
        reason: "low_signal_consensus",
        blocked_action: "entry_skipped_quality_gate",
        change_pct: 2.8,
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "Analyst",
        action: "missed_entry_evaluated",
        symbol: "NVDA",
        reason: "low_signal_consensus",
        blocked_action: "llm_buy_skipped_quality_gate",
        change_pct: 2.3,
      },
      {
        timestamp: "2026-06-06T00:10:00.000Z",
        agent: "System",
        action: "missed_entry_evaluated",
        symbol: "MSFT",
        reason: "timing_gate",
        blocked_action: "entry_skipped_timing_gate",
        change_pct: -2.2,
      },
    ]);

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);
    const missedEntrySuggestion = suggestions.find((suggestion) =>
      suggestion.target.startsWith("missed_entry_opportunities")
    );

    expect(missedEntrySuggestion).toEqual(
      expect.objectContaining({
        target: "missed_entry_opportunities:low_signal_consensus",
        config_keys: expect.arrayContaining(["min_entry_signal_consensus"]),
        proposed_config_patch: expect.objectContaining({
          min_entry_signal_consensus: 0.1,
        }),
      })
    );
  });

  it("surfaces wide-spread buy blockers as liquidity review signals", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_wide_spread",
        symbol: "AAPL",
        reason: "wide_spread",
        spread_pct: 2,
        max_spread_pct: 0.8,
      },
    ]);

    expect(runtimeSummary.entry_blocker_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "buy_blocked_wide_spread",
          reason: "wide_spread",
          count: 1,
          symbols: ["AAPL"],
        }),
      ])
    );
    expect(runtimeSummary.entry_blocker_samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "buy_blocked_wide_spread",
          reason: "wide_spread",
          spread_pct: 2,
          max_spread_pct: 0.8,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "entry_liquidity",
          config_keys: expect.arrayContaining(["max_entry_spread_pct", "ticker_blacklist", "allowed_exchanges"]),
          evidence: expect.objectContaining({
            action: "buy_blocked_wide_spread",
            reason: "wide_spread",
            count: 1,
          }),
        }),
      ])
    );
  });

  it("suggests defensive tuning from policy blockers even when buys are still executing", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "PolicyBroker",
        action: "buy_executed",
        symbol: "AAPL",
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_daily_loss_soft_guard",
        symbol: "MSFT",
        reason: "daily_loss_soft_guard",
      },
      {
        timestamp: "2026-06-06T00:10:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_entry_spacing",
        symbol: "NVDA",
        reason: "entry_spacing",
      },
      {
        timestamp: "2026-06-06T00:15:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_overextended_entry",
        symbol: "TSLA",
        reason: "overextended_entry",
      },
      {
        timestamp: "2026-06-06T00:20:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_thin_quote",
        symbol: "XYZ",
        reason: "thin_quote",
      },
      {
        timestamp: "2026-06-06T00:25:00.000Z",
        agent: "PolicyBroker",
        action: "buy_rejected",
        symbol: "AMD",
        reason: "averaging_down_blocked",
        violation_rules: ["averaging_down_blocked"],
      },
      {
        timestamp: "2026-06-06T00:30:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_open_position_loss_guard",
        symbol: "PLTR",
        reason: "open_position_loss_guard",
        open_loss_pct: 0.015,
        confidence: 0.7,
        min_confidence: 0.85,
        entry_quality: "good",
      },
      {
        timestamp: "2026-06-06T00:35:00.000Z",
        agent: "PolicyBroker",
        action: "buy_blocked_pending_order_check_unavailable",
        symbol: "SHOP",
        reason: "pending_order_check_unavailable",
        error: "Error: orders unavailable",
      },
      {
        timestamp: "2026-06-06T00:40:00.000Z",
        agent: "Options",
        action: "options_buy_rejected",
        contract: "AAPL260619C00195000",
        reason: "open_position_loss_entry_guard",
        violation_rules: ["open_position_loss_entry_guard"],
      },
      {
        timestamp: "2026-06-06T00:45:00.000Z",
        agent: "Options",
        action: "options_buy_skipped_pending_order_check_unavailable",
        contract: "MSFT260619C00420000",
        reason: "pending_order_check_unavailable",
        error: "Error: orders unavailable",
      },
    ]);

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "daily_loss_entry_guard",
          proposed_config_patch: expect.objectContaining({
            daily_loss_entry_guard_enabled: true,
            daily_loss_entry_guard_pct: 0.005,
            daily_loss_guard_min_confidence: 0.85,
            max_daily_loss_pct: 0.015,
          }),
        }),
        expect.objectContaining({
          target: "entry_spacing",
          proposed_config_patch: expect.objectContaining({
            min_minutes_between_entries: 10,
            max_daily_entry_orders: 6,
          }),
        }),
        expect.objectContaining({
          target: "policy_overextended_entry_guard",
          proposed_config_patch: expect.objectContaining({
            entry_timing_enabled: true,
            entry_max_intraday_range_position: 0.7,
          }),
        }),
        expect.objectContaining({
          target: "thin_quote_liquidity",
          proposed_config_patch: expect.objectContaining({
            min_entry_quote_size: 1,
            max_entry_spread_pct: 0.8,
          }),
        }),
        expect.objectContaining({
          target: "averaging_down_guard",
          config_keys: [],
          evidence: expect.objectContaining({
            action: "buy_rejected",
            reason: "averaging_down_blocked",
            count: 1,
          }),
        }),
        expect.objectContaining({
          target: "open_position_loss_entry_guard",
          config_keys: expect.arrayContaining([
            "open_position_loss_entry_guard_enabled",
            "open_position_loss_entry_guard_pct",
            "open_position_loss_guard_min_confidence",
            "open_position_loss_guard_min_entry_quality",
          ]),
          proposed_config_patch: expect.objectContaining({
            open_position_loss_entry_guard_enabled: true,
            open_position_loss_entry_guard_pct: 0.01,
            open_position_loss_guard_min_confidence: 0.85,
          }),
          evidence: expect.objectContaining({
            reason: expect.stringMatching(/^open_position_loss/),
            count: 1,
          }),
        }),
        expect.objectContaining({
          target: "entry_order_status_visibility",
          config_keys: [],
          evidence: expect.objectContaining({
            action: "buy_blocked_pending_order_check_unavailable",
            reason: "pending_order_check_unavailable",
            count: 1,
          }),
        }),
        expect.objectContaining({
          target: "options_entry_order_status_visibility",
          config_keys: [],
          evidence: expect.objectContaining({
            action: "options_buy_skipped_pending_order_check_unavailable",
            reason: "pending_order_check_unavailable",
            count: 1,
          }),
        }),
      ])
    );
  });

  it("surfaces low signal-consensus blockers as consensus gate review signals", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "System",
        action: "entry_skipped_quality_gate",
        symbol: "AAPL",
        reason: "low_signal_consensus",
        source_count: 2,
        min_signal_consensus: 0.15,
        average_sentiment: 0.08,
        bullish_signals: 2,
        bearish_signals: 1,
      },
    ]);

    expect((runtimeSummary.entry_pipeline as Record<string, unknown>).diagnosis_hints).toEqual(
      expect.arrayContaining(["entry_signal_consensus_is_below_minimum"])
    );
    expect(runtimeSummary.entry_blocker_samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "entry_skipped_quality_gate",
          reason: "low_signal_consensus",
          min_signal_consensus: 0.15,
          average_sentiment: 0.08,
          bullish_signals: 2,
          bearish_signals: 1,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "buy_starvation_signal_consensus",
          config_keys: expect.arrayContaining([
            "min_entry_signal_consensus",
            "min_sentiment_score",
            "min_entry_signal_sources",
            "single_source_entry_min_confidence",
          ]),
          evidence: expect.objectContaining({
            action: "entry_skipped_quality_gate",
            reason: "low_signal_consensus",
            count: 1,
          }),
        }),
      ])
    );
  });

  it("suggests exit-execution review when sell blockers appear", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "Analyst",
        action: "llm_sell_blocked",
        symbol: "AAPL",
        reason: "Position held less than minimum hold time",
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "PolicyBroker",
        action: "sell_failed",
        symbol: "MSFT",
        error: "broker unavailable",
      },
      {
        timestamp: "2026-06-06T00:10:00.000Z",
        agent: "PolicyBroker",
        action: "sell_blocked_pending_order",
        symbol: "NVDA",
        status: "new",
      },
      {
        timestamp: "2026-06-06T00:15:00.000Z",
        agent: "PolicyBroker",
        action: "sell_pending_order_check_unavailable",
        symbol: "TSLA",
        error: "order list unavailable",
      },
      {
        timestamp: "2026-06-06T00:20:00.000Z",
        agent: "PolicyBroker",
        action: "deferred_sell_canceled_stale_exit",
        symbol: "AMD",
        order_type: "limit",
        age_minutes: 18,
      },
      {
        timestamp: "2026-06-06T00:25:00.000Z",
        agent: "PolicyBroker",
        action: "sell_outcome_deferred",
        symbol: "META",
        status: "accepted",
      },
      {
        timestamp: "2026-06-06T00:30:00.000Z",
        agent: "PolicyBroker",
        action: "deferred_sell_partially_filled",
        symbol: "GOOGL",
        filled_qty: 2,
        filled_avg_price: 101,
      },
    ]);

    expect(runtimeSummary.exit_blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "llm_sell_blocked", count: 1, symbols: ["AAPL"] }),
        expect.objectContaining({ action: "sell_failed", count: 1, symbols: ["MSFT"] }),
        expect.objectContaining({ action: "sell_blocked_pending_order", count: 1, symbols: ["NVDA"] }),
        expect.objectContaining({ action: "sell_pending_order_check_unavailable", count: 1, symbols: ["TSLA"] }),
        expect.objectContaining({ action: "deferred_sell_canceled_stale_exit", count: 1, symbols: ["AMD"] }),
        expect.objectContaining({ action: "sell_outcome_deferred", count: 1, symbols: ["META"] }),
        expect.objectContaining({ action: "deferred_sell_partially_filled", count: 1, symbols: ["GOOGL"] }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions({}, runtimeSummary, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "llm_sell_min_hold_gate",
          proposed_config_patch: expect.objectContaining({
            llm_min_hold_minutes: 20,
            llm_force_sell_pnl_pct: 2,
            llm_force_sell_min_confidence: 0.65,
          }),
        }),
        expect.objectContaining({
          target: "exit_execution_failure",
          proposed_config_patch: expect.objectContaining({
            after_hours_exit_limit_buffer_pct: 0.5,
          }),
        }),
        expect.objectContaining({
          target: "exit_pending_order_block",
          config_keys: expect.arrayContaining(["after_hours_exit_limit_buffer_pct"]),
        }),
        expect.objectContaining({
          target: "exit_order_status_visibility",
          config_keys: [],
        }),
        expect.objectContaining({
          target: "stale_exit_order_repricing",
          proposed_config_patch: expect.objectContaining({
            after_hours_exit_limit_buffer_pct: 0.5,
          }),
        }),
        expect.objectContaining({
          target: "incomplete_exit_fill_tracking",
          evidence: expect.objectContaining({
            action: expect.stringMatching(/sell_outcome_deferred|deferred_sell_partially_filled/),
          }),
        }),
      ])
    );
  });

  it("summarizes closed trades by normalized exit reason", () => {
    const summary = buildTradeReviewSummary(
      [
        {
          journal_id: "j1",
          symbol: "AAPL",
          side: "buy",
          outcome: "win",
          pnl_usd: 12,
          pnl_pct: 0.4,
          hold_duration_mins: 45,
          lessons_learned: "Profit lock stop: peak +3.5%, current near +0.50% floor",
        },
        {
          journal_id: "j2",
          symbol: "MSFT",
          side: "buy",
          outcome: "loss",
          pnl_usd: -30,
          pnl_pct: -3,
          hold_duration_mins: 80,
          lessons_learned: "Stop loss at -3.0%",
        },
        {
          journal_id: "j4",
          symbol: "TSLA",
          side: "buy",
          outcome: "win",
          pnl_usd: 6,
          pnl_pct: 0.6,
          hold_duration_mins: 90,
          lessons_learned: "Sentiment reversal profit exit: +0.6%, avg signal -0.45, 1/1 bearish",
        },
        {
          journal_id: "j5",
          symbol: "META",
          side: "buy",
          outcome: "loss",
          pnl_usd: -16,
          pnl_pct: -1.6,
          hold_duration_mins: 90,
          lessons_learned: "Sentiment reversal loss exit: -1.6%, avg signal -0.45, 1/1 bearish",
        },
        {
          journal_id: "j3",
          symbol: "NVDA",
          side: "buy",
          outcome: null,
          pnl_usd: null,
          pnl_pct: null,
          hold_duration_mins: null,
          notes: "Open trade",
        },
      ],
      {}
    );

    const buckets = (summary.buckets as Record<string, unknown>).by_exit_reason;
    expect(summary.totals).toEqual(
      expect.objectContaining({
        closed_trades: 4,
        gross_profit_usd: 18,
        gross_loss_usd: 46,
        profit_factor: 0.3913,
        expectancy_usd: -7,
        avg_win_usd: 9,
        avg_loss_usd: -23,
        payoff_ratio: 0.3913,
      })
    );
    expect(buckets).toEqual([
      expect.objectContaining({ key: "profit_lock", trades: 1, wins: 1, losses: 0 }),
      expect.objectContaining({ key: "sentiment_reversal_loss", trades: 1, wins: 0, losses: 1 }),
      expect.objectContaining({ key: "sentiment_reversal_profit", trades: 1, wins: 1, losses: 0 }),
      expect.objectContaining({ key: "stop_loss", trades: 1, wins: 0, losses: 1 }),
    ]);
  });

  it("summarizes closed trades by entry selection score", () => {
    const summary = buildTradeReviewSummary(
      [
        {
          journal_id: "score-high",
          symbol: "AAPL",
          side: "buy",
          outcome: "win",
          pnl_usd: 18,
          pnl_pct: 1.8,
          hold_duration_mins: 55,
        },
        {
          journal_id: "score-low",
          symbol: "MSFT",
          side: "buy",
          outcome: "loss",
          pnl_usd: -20,
          pnl_pct: -2,
          hold_duration_mins: 90,
        },
      ],
      {
        "score-high": { entry_selection_score: 1.16 },
        "score-low": { entry_selection_score: 0.91 },
      }
    );

    const buckets = (summary.buckets as Record<string, unknown>).by_entry_selection_score;
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "1.15+", trades: 1, wins: 1, losses: 0 }),
        expect.objectContaining({ key: "0.85-0.94", trades: 1, wins: 0, losses: 1 }),
      ])
    );
  });

  it("summarizes closed trades by research confirmation state", () => {
    const summary = buildTradeReviewSummary(
      [
        {
          journal_id: "confirmed",
          symbol: "AAPL",
          side: "buy",
          outcome: "win",
          pnl_usd: 12,
          pnl_pct: 1.2,
          hold_duration_mins: 50,
          signals_json: JSON.stringify({ research_confirmed: true }),
        },
        {
          journal_id: "unconfirmed",
          symbol: "MSFT",
          side: "buy",
          outcome: "loss",
          pnl_usd: -14,
          pnl_pct: -1.4,
          hold_duration_mins: 60,
          signals_json: JSON.stringify({ research_confirmed: false }),
        },
      ],
      {}
    );

    const buckets = (summary.buckets as Record<string, unknown>).by_research_confirmation;
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "confirmed", trades: 1, wins: 1, losses: 0 }),
        expect.objectContaining({ key: "unconfirmed", trades: 1, wins: 0, losses: 1 }),
      ])
    );
  });

  it("flags weak profit-lock exit buckets for review", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `j${index}`,
      symbol: `T${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 6 : -12,
      pnl_pct: index === 0 ? 0.3 : -0.8,
      hold_duration_mins: 30,
      lessons_learned: "Profit lock stop: peak +3.5%, current near +0.50% floor",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "profit_lock_exit",
          evidence: expect.objectContaining({ group: "by_exit_reason", key: "profit_lock", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            profit_lock_stop_enabled: true,
            profit_lock_activation_pct: 3.95,
            profit_lock_floor_pct: 0.5,
          }),
        }),
      ])
    );
  });

  it("drops invalid patch candidates while keeping the review suggestion", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `pl-invalid-${index}`,
      symbol: `P${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -14,
      pnl_pct: index === 0 ? 0.2 : -0.7,
      hold_duration_mins: 30,
      lessons_learned: "Profit lock stop: peak +3.5%, current near +0.50% floor",
    }));
    const summary = buildTradeReviewSummary(rows, {});
    const invalidCurrentConfig = {
      ...DEFAULT_CONFIG,
      breakeven_stop_activation_pct: 0,
      profit_lock_activation_pct: 0,
      profit_lock_floor_pct: 0,
    };

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, invalidCurrentConfig);
    const suggestion = suggestions.find((item) => item.target === "profit_lock_exit");

    expect(suggestion).toEqual(
      expect.objectContaining({
        target: "profit_lock_exit",
        proposed_config_patch: undefined,
        evidence: expect.objectContaining({
          invalid_config_patch: expect.objectContaining({ profit_lock_stop_enabled: true }),
          invalid_config_patch_issues: expect.arrayContaining([
            expect.objectContaining({ path: "profit_lock_activation_pct" }),
          ]),
        }),
      })
    );
  });

  it("suggests tighter entry gates when stop-loss exits are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `s${index}`,
      symbol: `S${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 8 : -25,
      pnl_pct: index === 0 ? 0.8 : -5,
      hold_duration_mins: 90,
      lessons_learned: "Stop loss at -5.0%",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "stop_loss_exits",
          evidence: expect.objectContaining({ group: "by_exit_reason", key: "stop_loss", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            min_analyst_confidence: 0.65,
            min_entry_quality: "good",
          }),
        }),
      ])
    );
  });

  it("suggests expectancy controls when closed trades have negative expectancy", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      journal_id: `expectancy-${index}`,
      symbol: `E${index}`,
      side: "buy",
      outcome: index < 5 ? "win" : "loss",
      pnl_usd: index < 5 ? 5 : -12,
      pnl_pct: index < 5 ? 0.5 : -1.2,
      hold_duration_mins: 80,
      lessons_learned: index < 5 ? "Take profit" : "Stop loss",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect(summary.totals).toEqual(
      expect.objectContaining({
        closed_trades: 10,
        profit_factor: 0.4167,
        expectancy_usd: -3.5,
        payoff_ratio: 0.4167,
      })
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "negative_trade_expectancy",
          evidence: expect.objectContaining({
            closed_trades: 10,
            expectancy_usd: -3.5,
            profit_factor: 0.4167,
          }),
          proposed_config_patch: expect.objectContaining({
            stop_loss_pct: 4,
            early_loss_exit_enabled: true,
            early_loss_exit_pct: 2,
            early_loss_exit_max_hold_minutes: 75,
            profit_lock_stop_enabled: true,
            trailing_stop_enabled: true,
            trailing_stop_activation_pct: 5,
            trailing_stop_drawdown_pct: 2.5,
          }),
        }),
      ])
    );
  });

  it("suggests calibration controls when average confidence exceeds realized win rate", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      journal_id: `calibration-${index}`,
      symbol: `C${index}`,
      side: "buy",
      outcome: index < 3 ? "win" : "loss",
      pnl_usd: index < 3 ? 8 : -10,
      pnl_pct: index < 3 ? 0.8 : -1,
      hold_duration_mins: 90,
      signals_json: JSON.stringify({ confidence: 0.8, catalysts: ["trend"], sources: ["stocktwits"] }),
      lessons_learned: index < 3 ? "Take profit" : "Stop loss",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect(summary.totals).toEqual(
      expect.objectContaining({
        closed_trades: 10,
        win_rate: 0.3,
        avg_confidence: 0.8,
        confidence_calibration_gap: 0.5,
      })
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "confidence_calibration_mismatch",
          evidence: expect.objectContaining({
            closed_trades: 10,
            win_rate: 0.3,
            avg_confidence: 0.8,
            confidence_calibration_gap: 0.5,
          }),
          proposed_config_patch: expect.objectContaining({
            analyst_buy_requires_research_confirmation: true,
            min_entry_signal_sources: 2,
            max_entry_red_flags: 0,
            llm_size_conviction_scaling: true,
            llm_size_medium_confidence_multiplier: 0.6,
            llm_size_low_confidence_multiplier: 0.35,
          }),
        }),
      ])
    );
  });

  it("suggests risk controls when recent closed trades form a loss streak", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      journal_id: `streak-${index}`,
      symbol: `S${index}`,
      side: "buy",
      outcome: index < 3 ? "win" : "loss",
      pnl_usd: index < 3 ? 10 : -18,
      pnl_pct: index < 3 ? 1 : -1.8,
      hold_duration_mins: 60,
      exit_at: new Date(Date.UTC(2026, 5, 1, 14, index)).toISOString(),
      lessons_learned: index < 3 ? "Take profit" : "Stop loss",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect(summary.totals).toEqual(
      expect.objectContaining({
        closed_trades: 6,
        max_consecutive_losses: 3,
        current_consecutive_losses: 3,
        recent_closed_trades: 6,
        recent_win_rate: 0.5,
        recent_total_pnl_usd: -24,
      })
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "loss_streak_risk_control",
          evidence: expect.objectContaining({
            current_consecutive_losses: 3,
            max_consecutive_losses: 3,
            recent_total_pnl_usd: -24,
          }),
          proposed_config_patch: expect.objectContaining({
            cooldown_minutes_after_loss: 60,
            max_daily_loss_pct: 0.0125,
            adaptive_performance_block_enabled: true,
            adaptive_performance_min_win_rate: 0.4,
            position_size_pct_of_cash: 10,
          }),
        }),
      ])
    );
  });

  it("suggests symbol quarantine when the same ticker repeatedly underperforms", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `symbol-risk-${index}`,
      symbol: "MULN",
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 3 : -20,
      pnl_pct: index === 0 ? 0.3 : -2,
      hold_duration_mins: 50,
      lessons_learned: index === 0 ? "Take profit" : "Stop loss",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_symbol).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "MULN", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "symbol_quarantine:MULN",
          evidence: expect.objectContaining({ group: "by_symbol", key: "MULN", trades: 3, blacklist_symbol: "MULN" }),
          proposed_config_patch: expect.objectContaining({
            ticker_blacklist: expect.arrayContaining(["MULN"]),
            recent_sell_cooldown_hours: 96,
            adaptive_performance_block_enabled: true,
          }),
        }),
      ])
    );
  });

  it("suggests tighter confirmation when sentiment-reversal loss exits are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `sr-loss-${index}`,
      symbol: `R${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 3 : -18,
      pnl_pct: index === 0 ? 0.2 : -1.8,
      hold_duration_mins: 90,
      lessons_learned: "Sentiment reversal loss exit: -1.8%, avg signal -0.35, 1/1 bearish",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "sentiment_reversal_loss_exit",
          evidence: expect.objectContaining({
            group: "by_exit_reason",
            key: "sentiment_reversal_loss",
            trades: 3,
          }),
          proposed_config_patch: expect.objectContaining({
            sentiment_reversal_exit_enabled: true,
            sentiment_reversal_loss_pct: 1.25,
            sentiment_reversal_min_sources: 2,
          }),
        }),
      ])
    );
  });

  it("segments weak trades by asset class and suggests dedicated controls", () => {
    const rows = [
      {
        journal_id: "asset-option-0",
        symbol: "AAPL260619C00195000",
        side: "buy",
        outcome: "win",
        pnl_usd: 8,
        pnl_pct: 8,
        hold_duration_mins: 45,
        lessons_learned: "Options take profit",
      },
      ...Array.from({ length: 2 }, (_, index) => ({
        journal_id: `asset-option-loss-${index}`,
        symbol: "MSFT260619C00420000",
        side: "buy",
        outcome: "loss",
        pnl_usd: -30,
        pnl_pct: -30,
        hold_duration_mins: 50,
        lessons_learned: "Options stop loss",
      })),
      {
        journal_id: "asset-crypto-0",
        symbol: "BTC/USD",
        side: "buy",
        outcome: "win",
        pnl_usd: 6,
        pnl_pct: 1.2,
        hold_duration_mins: 90,
        lessons_learned: "Crypto take profit",
      },
      ...Array.from({ length: 2 }, (_, index) => ({
        journal_id: `asset-crypto-loss-${index}`,
        symbol: "ETH/USD",
        side: "buy",
        outcome: "loss",
        pnl_usd: -18,
        pnl_pct: -2.4,
        hold_duration_mins: 80,
        lessons_learned: "Crypto stop loss",
      })),
    ];
    const snapshots = Object.fromEntries(
      rows.map((row) => [
        row.journal_id,
        row.symbol.includes("260619")
          ? {
              order: {
                dte: 5,
                delta: 0.24,
                option_type: "call",
              },
            }
          : row.symbol.includes("/")
            ? { momentum: 0.015 }
            : {},
      ])
    );
    const summary = buildTradeReviewSummary(rows, snapshots);

    const buckets = (summary.buckets as Record<string, unknown>).by_asset_class;
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "options", trades: 3, wins: 1, losses: 2 }),
        expect.objectContaining({ key: "crypto", trades: 3, wins: 1, losses: 2 }),
      ])
    );
    expect((summary.buckets as Record<string, unknown>).by_option_dte).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "<7d", trades: 3, wins: 1, losses: 2 })])
    );
    expect((summary.buckets as Record<string, unknown>).by_option_delta).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "<0.30", trades: 3, wins: 1, losses: 2 })])
    );
    expect((summary.buckets as Record<string, unknown>).by_option_type).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "call", trades: 3, wins: 1, losses: 2 })])
    );
    expect((summary.buckets as Record<string, unknown>).by_crypto_momentum).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "<2%", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "options_asset_class_risk",
          evidence: expect.objectContaining({ group: "by_asset_class", key: "options", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            options_min_confidence: 0.8,
            options_max_pct_per_trade: 0.015,
            options_max_spread_pct: 6,
            options_early_loss_exit_enabled: true,
            options_early_loss_exit_pct: 20,
            options_early_loss_exit_max_hold_minutes: 45,
            options_stop_loss_pct: 35,
          }),
        }),
        expect.objectContaining({
          target: "crypto_asset_class_risk",
          evidence: expect.objectContaining({ group: "by_asset_class", key: "crypto", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            crypto_momentum_threshold: 2.5,
            crypto_max_position_value: 750,
            crypto_stop_loss_pct: 4,
          }),
        }),
        expect.objectContaining({
          target: "options_dte_risk",
          evidence: expect.objectContaining({ group: "by_option_dte", key: "<7d", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            options_min_dte: 30,
            options_max_pct_per_trade: 0.015,
            options_early_loss_exit_enabled: true,
            options_early_loss_exit_pct: 20,
            options_stop_loss_pct: 35,
          }),
        }),
        expect.objectContaining({
          target: "options_delta_band",
          evidence: expect.objectContaining({ group: "by_option_delta", key: "<0.30", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            options_target_delta: 0.4,
            options_min_confidence: 0.82,
          }),
        }),
        expect.objectContaining({
          target: "options_type:call",
          evidence: expect.objectContaining({ group: "by_option_type", key: "call", trades: 3 }),
        }),
        expect.objectContaining({
          target: "crypto_low_momentum_entries",
          evidence: expect.objectContaining({ group: "by_crypto_momentum", key: "<2%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            crypto_momentum_threshold: 3,
            crypto_max_position_value: 750,
            crypto_stop_loss_pct: 4,
          }),
        }),
      ])
    );
  });

  it("suggests max crypto momentum caps when overextended crypto entries are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `crypto-hot-${index}`,
      symbol: "SOL/USD",
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 5 : -18,
      pnl_pct: index === 0 ? 1 : -3,
      hold_duration_mins: 60,
      lessons_learned: index === 0 ? "Crypto take profit" : "Crypto stop loss",
    }));
    const snapshots = Object.fromEntries(rows.map((row) => [row.journal_id, { momentum: 0.09 }]));
    const summary = buildTradeReviewSummary(rows, snapshots);

    expect((summary.buckets as Record<string, unknown>).by_crypto_momentum).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "8%+", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "crypto_overextended_momentum",
          evidence: expect.objectContaining({ group: "by_crypto_momentum", key: "8%+", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            crypto_max_momentum_pct: 8,
            crypto_max_position_value: 600,
            crypto_stop_loss_pct: 3.5,
          }),
        }),
      ])
    );
  });

  it("suggests tighter setup requirements when low entry-selection scores are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `score-${index}`,
      symbol: `Q${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 5 : -18,
      pnl_pct: index === 0 ? 0.5 : -2.2,
      hold_duration_mins: 75,
    }));
    const summary = buildTradeReviewSummary(rows, {
      "score-0": { entry_selection_score: 0.92 },
      "score-1": { entry_selection_score: 0.91 },
      "score-2": { entry_selection_score: 0.9 },
    });

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "entry_selection_score",
          evidence: expect.objectContaining({ group: "by_entry_selection_score", key: "0.85-0.94", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            min_entry_selection_score: 0.95,
            min_analyst_confidence: 0.65,
            min_entry_quality: "good",
            min_entry_catalysts: 1,
            min_entry_signal_sources: 2,
          }),
        }),
      ])
    );
  });

  it("flags weak high-confidence buckets as overconfidence risk", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `high-confidence-${index}`,
      symbol: `HC${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -22,
      pnl_pct: index === 0 ? 0.4 : -2.2,
      hold_duration_mins: 70,
      lessons_learned: index === 0 ? "Take profit" : "Stop loss",
    }));
    const snapshots = Object.fromEntries(
      rows.map((row) => [
        row.journal_id,
        {
          confidence: 0.94,
          catalysts: ["trend"],
          sources: ["stocktwits"],
        },
      ])
    );
    const summary = buildTradeReviewSummary(rows, snapshots);

    expect((summary.buckets as Record<string, unknown>).by_confidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "0.90+", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "high_confidence_overfit",
          evidence: expect.objectContaining({ group: "by_confidence", key: "0.90+", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            analyst_buy_requires_research_confirmation: true,
            max_entry_red_flags: 0,
            min_entry_signal_sources: 2,
            llm_size_conviction_scaling: true,
            llm_size_medium_confidence_multiplier: 0.6,
          }),
        }),
      ])
    );
  });

  it("suggests requiring research confirmation when unconfirmed buys are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `unconfirmed-${index}`,
      symbol: `U${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -16,
      pnl_pct: index === 0 ? 0.4 : -1.8,
      hold_duration_mins: 70,
      signals_json: JSON.stringify({
        entry_path: "llm_recommendation_unresearched",
        confidence: 0.95,
        research_confirmed: false,
      }),
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const buckets = (summary.buckets as Record<string, unknown>).by_research_confirmation;
    expect(buckets).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "unconfirmed", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "research_confirmation",
          evidence: expect.objectContaining({ group: "by_research_confirmation", key: "unconfirmed", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            analyst_buy_requires_research_confirmation: true,
            exceptional_entry_confidence: 0.9,
          }),
        }),
      ])
    );
  });

  it("suggests tighter loss-depth controls when large pnl losses are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `deep-loss-${index}`,
      symbol: `D${index}`,
      side: "buy",
      outcome: "loss",
      pnl_usd: -75 - index,
      pnl_pct: -6.5,
      hold_duration_mins: 180,
      lessons_learned: "Stopped after weakness continued",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const buckets = (summary.buckets as Record<string, unknown>).by_pnl_pct;
    expect(buckets).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "-10%..-5%", trades: 3, wins: 0, losses: 3 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "loss_depth_control",
          evidence: expect.objectContaining({ group: "by_pnl_pct", key: "-10%..-5%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            stop_loss_pct: 5,
            early_loss_exit_enabled: true,
            early_loss_exit_pct: 2,
            early_loss_exit_max_hold_minutes: 75,
            sentiment_reversal_loss_pct: 1.25,
            stale_loss_exit_pct: 1.5,
            cooldown_minutes_after_loss: 45,
            max_daily_loss_pct: 0.015,
          }),
        }),
      ])
    );
  });

  it("suggests excursion controls when weak trades barely move favorably or move deeply adverse", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `excursion-${index}`,
      symbol: `X${index}`,
      side: "buy",
      outcome: "loss",
      pnl_usd: -35 - index,
      pnl_pct: -3.5,
      hold_duration_mins: 120,
      lessons_learned: "Weak entry never followed through",
    }));
    const snapshots = Object.fromEntries(
      rows.map((row) => [
        row.journal_id,
        {
          lifecycle_metadata: {
            mfe_pct: 0.6,
            mae_pct: -3.2,
          },
        },
      ])
    );
    const summary = buildTradeReviewSummary(rows, snapshots);

    const buckets = summary.buckets as Record<string, unknown>;
    expect(buckets.by_mfe_pct).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "<1%", trades: 3, wins: 0, losses: 3 })])
    );
    expect(buckets.by_mae_pct).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "-5%..-2%", trades: 3, wins: 0, losses: 3 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "low_favorable_excursion_entries",
          evidence: expect.objectContaining({ group: "by_mfe_pct", key: "<1%", trades: 3 }),
        }),
        expect.objectContaining({
          target: "adverse_excursion_control",
          evidence: expect.objectContaining({ group: "by_mae_pct", key: "-5%..-2%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            early_loss_exit_enabled: true,
            early_loss_exit_pct: 2,
            early_loss_exit_max_hold_minutes: 75,
          }),
        }),
      ])
    );
  });

  it("suggests profit protection when weak trades give back favorable movement", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `giveback-${index}`,
      symbol: `G${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -24,
      pnl_pct: index === 0 ? 0.4 : -2.1,
      hold_duration_mins: 180,
      lessons_learned: "Winner gave back most of its favorable move",
    }));
    const snapshots = Object.fromEntries(
      rows.map((row) => [
        row.journal_id,
        {
          lifecycle_metadata: {
            mfe_pct: 5.5,
            mae_pct: -1.1,
          },
        },
      ])
    );
    const summary = buildTradeReviewSummary(rows, snapshots);

    const buckets = summary.buckets as Record<string, unknown>;
    expect(buckets.by_giveback_pct).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "3%..6%", trades: 3, wins: 1, losses: 2 })])
    );
    expect(buckets.by_exit_efficiency_pct).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "<25%", trades: 3, wins: 1, losses: 2 })])
    );
    expect((summary.totals as Record<string, unknown>).avg_exit_efficiency_pct).toBeCloseTo(2.4242, 4);

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "winner_giveback_control",
          evidence: expect.objectContaining({ group: "by_giveback_pct", key: "3%..6%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            profit_lock_stop_enabled: true,
            trailing_stop_enabled: true,
          }),
        }),
        expect.objectContaining({
          target: "low_exit_efficiency",
          evidence: expect.objectContaining({ group: "by_exit_efficiency_pct", key: "<25%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            profit_lock_stop_enabled: true,
            trailing_stop_enabled: true,
            trailing_stop_activation_pct: 4,
            trailing_stop_drawdown_pct: 2,
          }),
        }),
      ])
    );
  });

  it("suggests stale-exit tightening when long hold-time buckets are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `stale-hold-${index}`,
      symbol: `H${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 8 : -28,
      pnl_pct: index === 0 ? 0.8 : -2.4,
      hold_duration_mins: 6 * 24 * 60,
      lessons_learned: "Stale position exit",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const buckets = (summary.buckets as Record<string, unknown>).by_hold_time;
    expect(buckets).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "5d+", trades: 3, wins: 1, losses: 2 })])
    );

    const looseStaleConfig = {
      ...DEFAULT_CONFIG,
      stale_min_hold_hours: 48,
      stale_mid_hold_days: 5,
      stale_max_hold_days: 7,
      stale_min_gain_pct: 8,
    };
    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, looseStaleConfig);
    const staleSuggestion = suggestions.find((suggestion) => suggestion.target === "stale_hold_time");

    expectSuggestionPatchesToBeSchemaValid(suggestions);
    expect(staleSuggestion).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({ group: "by_hold_time", key: "5d+", trades: 3 }),
        proposed_config_patch: expect.objectContaining({
          stale_position_enabled: true,
          stale_min_hold_hours: 12,
          stale_loss_exit_pct: 1.5,
          stale_mid_hold_days: 2,
          stale_max_hold_days: 4,
          stale_min_gain_pct: 3,
        }),
      })
    );
  });

  it("surfaces weak entry-session and weekday buckets for timing review", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `open-session-${index}`,
      symbol: `O${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 5 : -20,
      pnl_pct: index === 0 ? 0.5 : -2,
      hold_duration_mins: 120,
      entry_at: `2026-06-05T13:4${index}:00.000Z`,
    }));
    const summary = buildTradeReviewSummary(rows, {});

    const buckets = summary.buckets as Record<string, unknown>;
    expect(buckets.by_entry_session).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "open_30m", trades: 3, wins: 1, losses: 2 })])
    );
    expect(buckets.by_entry_weekday).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "Fri", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);
    const entrySessionSuggestion = suggestions.find((suggestion) => suggestion.target === "entry_session:open_30m");
    const weekdaySuggestion = suggestions.find((suggestion) => suggestion.target === "entry_weekday:Fri");

    expect(entrySessionSuggestion).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({ group: "by_entry_session", key: "open_30m", trades: 3 }),
        proposed_config_patch: expect.objectContaining({
          equity_entry_cooldown_minutes_after_open: 15,
          market_open_execute_window_minutes: 1,
          entry_timing_enabled: true,
        }),
      })
    );
    expect(weekdaySuggestion).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({ group: "by_entry_weekday", key: "Fri", trades: 3 }),
      })
    );
    expect(weekdaySuggestion?.proposed_config_patch).toBeUndefined();
  });

  it("suggests reducing low-conviction size multipliers when reduced-size entries are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `low-size-${index}`,
      symbol: `L${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 3 : -18,
      pnl_pct: index === 0 ? 0.3 : -1.8,
      hold_duration_mins: 90,
    }));
    const snapshots = Object.fromEntries(rows.map((row) => [row.journal_id, { size_multiplier: 0.4 }]));
    const summary = buildTradeReviewSummary(rows, snapshots);

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "low_conviction_position_sizing",
          evidence: expect.objectContaining({ group: "by_size_multiplier", key: "<0.45", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            llm_size_conviction_scaling: true,
            llm_size_low_confidence_multiplier: 0.3,
            llm_size_medium_confidence_multiplier: 0.6,
          }),
        }),
      ])
    );
  });

  it("suggests reducing base exposure when full-size entries are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `full-size-${index}`,
      symbol: `F${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 8 : -35,
      pnl_pct: index === 0 ? 0.8 : -3.5,
      hold_duration_mins: 75,
    }));
    const snapshots = Object.fromEntries(rows.map((row) => [row.journal_id, { size_multiplier: 1 }]));
    const largeSizeConfig = {
      ...DEFAULT_CONFIG,
      position_size_pct_of_cash: 25,
      max_position_value: 5_000,
    };
    const summary = buildTradeReviewSummary(rows, snapshots);

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, largeSizeConfig);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "full_size_position_risk",
          evidence: expect.objectContaining({ group: "by_size_multiplier", key: "0.90+", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            position_size_pct_of_cash: 15,
            max_position_value: 4_000,
            min_analyst_confidence: 0.65,
            min_entry_quality: "good",
          }),
        }),
      ])
    );
  });

  it("suggests tightening executed entry liquidity when high-spread fills are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `wide-fill-${index}`,
      symbol: `WIDE${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 5 : -20,
      pnl_pct: index === 0 ? 0.5 : -2,
      hold_duration_mins: 45,
    }));
    const snapshots = Object.fromEntries(rows.map((row) => [row.journal_id, { policy: { quote_spread_pct: 1.4 } }]));
    const summary = buildTradeReviewSummary(rows, snapshots);

    expect((summary.buckets as Record<string, unknown>).by_entry_spread_pct).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0.80%..2%",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "executed_entry_liquidity",
          evidence: expect.objectContaining({ group: "by_entry_spread_pct", key: "0.80%..2%", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            max_entry_spread_pct: 0.7,
          }),
        }),
      ])
    );
  });

  it("suggests tightening signal freshness when delayed entry fills are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `slow-fill-${index}`,
      trade_id: `slow-trade-${index}`,
      symbol: `SLOW${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -18,
      pnl_pct: index === 0 ? 0.4 : -1.8,
      hold_duration_mins: 60,
      trade_created_at: "2026-06-06T13:00:00.000Z",
      entry_at: "2026-06-06T13:12:00.000Z",
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_entry_fill_delay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "5m..30m",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "slow_entry_fills",
          evidence: expect.objectContaining({ group: "by_entry_fill_delay", key: "5m..30m", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            max_entry_research_age_minutes: 20,
            entry_timing_enabled: true,
            market_open_execute_window_minutes: 1,
          }),
        }),
      ])
    );
  });

  it("suggests tightening execution quality when quote slippage is weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `slip-fill-${index}`,
      trade_id: `slip-trade-${index}`,
      symbol: `SLIP${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 6 : -24,
      pnl_pct: index === 0 ? 0.6 : -2.4,
      hold_duration_mins: 50,
      filled_avg_price: 101.1,
    }));
    const snapshots = Object.fromEntries(
      rows.map((row) => [row.trade_id, { policy: { quote_bid: 99.8, quote_ask: 100, quote_mid: 99.9 } }])
    );
    const summary = buildTradeReviewSummary(rows, snapshots);

    expect((summary.buckets as Record<string, unknown>).by_entry_quote_slippage_pct).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0.75%+",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "entry_execution_quality",
          evidence: expect.objectContaining({ group: "by_entry_quote_slippage_pct", key: "0.75%+", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            max_entry_spread_pct: 0.5,
          }),
        }),
      ])
    );
  });

  it("suggests reducing chase risk when extended entry moves are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `extended-entry-${index}`,
      symbol: `EXT${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 7 : -28,
      pnl_pct: index === 0 ? 0.7 : -2.8,
      hold_duration_mins: 55,
      signals_json: JSON.stringify({ entry_price_change_pct: 6.2 }),
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_entry_price_change_pct).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "5%+",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "overextended_entry_chasing",
          evidence: expect.objectContaining({ group: "by_entry_price_change_pct", key: "5%+", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            entry_timing_enabled: true,
            entry_rsi_max: 50,
            entry_max_intraday_range_position: 0.65,
            max_entry_research_age_minutes: 20,
            max_entry_price_change_pct: 5,
          }),
        }),
      ])
    );
  });

  it("suggests higher single-source confidence when thin signal-source buckets are weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `thin-source-${index}`,
      symbol: `SRC${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -16,
      pnl_pct: index === 0 ? 0.4 : -1.6,
      hold_duration_mins: 75,
      signals_json: JSON.stringify({ source_count: 1, signal_sources: 1 }),
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_signal_sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "1", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "signal_confirmation",
          evidence: expect.objectContaining({ group: "by_signal_sources", key: "1", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            min_entry_signal_sources: 2,
            single_source_entry_min_confidence: 0.85,
          }),
        }),
      ])
    );
  });

  it("suggests a stronger minimum entry consensus when mixed signal consensus is weak", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `mixed-consensus-${index}`,
      symbol: `MIX${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 4 : -18,
      pnl_pct: index === 0 ? 0.4 : -1.8,
      hold_duration_mins: 75,
      signals_json: JSON.stringify({ signal_consensus_state: "mixed" }),
    }));
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_signal_consensus).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "mixed", trades: 3, wins: 1, losses: 2 })])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, DEFAULT_CONFIG);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "signal_consensus",
          evidence: expect.objectContaining({ group: "by_signal_consensus", key: "mixed", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            min_sentiment_score: 0.3,
            min_entry_signal_sources: 2,
            min_entry_signal_consensus: 0.2,
          }),
        }),
      ])
    );
  });

  it("suggests tightening portfolio concentration when a sector bucket is weak", () => {
    const rows = ["AAPL", "MSFT", "NVDA"].map((symbol, index) => ({
      journal_id: `bucket-risk-${index}`,
      symbol,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 6 : -26,
      pnl_pct: index === 0 ? 0.6 : -2.6,
      hold_duration_mins: 80,
    }));
    const loosePortfolioConfig = { ...DEFAULT_CONFIG, max_positions_per_sector: 3 };
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_portfolio_bucket).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "technology",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, loosePortfolioConfig);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "portfolio_bucket:technology",
          evidence: expect.objectContaining({ group: "by_portfolio_bucket", key: "technology", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            portfolio_risk_enabled: true,
            max_positions_per_sector: 1,
            adaptive_performance_block_enabled: true,
          }),
        }),
      ])
    );
  });

  it("suggests tightening weak premarket entry paths", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      journal_id: `premarket-path-${index}`,
      symbol: `PM${index}`,
      side: "buy",
      outcome: index === 0 ? "win" : "loss",
      pnl_usd: index === 0 ? 5 : -22,
      pnl_pct: index === 0 ? 0.5 : -2.2,
      hold_duration_mins: 70,
      signals_json: JSON.stringify({
        entry_path: "premarket_plan",
        research_confirmed: index === 0,
      }),
    }));
    const loosePremarketConfig = {
      ...DEFAULT_CONFIG,
      market_open_execute_window_minutes: 3,
      analyst_buy_requires_research_confirmation: false,
    };
    const summary = buildTradeReviewSummary(rows, {});

    expect((summary.buckets as Record<string, unknown>).by_entry_path).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "premarket_plan",
          trades: 3,
          wins: 1,
          losses: 2,
        }),
      ])
    );

    const suggestions = buildTradeReviewTuningSuggestions(summary, {}, loosePremarketConfig);
    expectSuggestionPatchesToBeSchemaValid(suggestions);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "entry_path:premarket_plan",
          evidence: expect.objectContaining({ group: "by_entry_path", key: "premarket_plan", trades: 3 }),
          proposed_config_patch: expect.objectContaining({
            market_open_execute_window_minutes: 1,
            entry_timing_enabled: true,
            analyst_buy_requires_research_confirmation: true,
          }),
        }),
      ])
    );
  });

  it("emits schema-valid patch candidates for buy-starvation blockers", () => {
    const runtimeSummary = summarizeRuntimeLogs([
      {
        timestamp: "2026-06-06T00:00:00.000Z",
        agent: "System",
        action: "entry_skipped_timing_gate",
        symbol: "AAPL",
        reason: "timing_gate",
        confidence: 0.91,
      },
      {
        timestamp: "2026-06-06T00:01:00.000Z",
        agent: "System",
        action: "entry_skipped_notional_too_small",
        symbol: "MSFT",
        reason: "notional_too_small",
        confidence: 0.86,
      },
      {
        timestamp: "2026-06-06T00:02:00.000Z",
        agent: "System",
        action: "entry_skipped_no_signals",
        symbol: "NVDA",
        reason: "no_signals",
      },
      {
        timestamp: "2026-06-06T00:03:00.000Z",
        agent: "System",
        action: "entry_skipped_no_capacity",
        symbol: "TSLA",
        reason: "position_capacity",
      },
      {
        timestamp: "2026-06-06T00:04:00.000Z",
        agent: "System",
        action: "entry_skipped_open_window",
        symbol: "AMD",
        reason: "near_market_open",
      },
      {
        timestamp: "2026-06-06T00:05:00.000Z",
        agent: "System",
        action: "entry_selection_summary",
        strategy_entry_candidates: 2,
      },
    ]);
    const summary = {
      totals: {
        closed_trades: 10,
        win_rate: 0.6,
      },
      diagnostics: {
        weak_buckets: [
          {
            group: "by_size_multiplier",
            key: "0.45-0.69",
            trades: 3,
            wins: 1,
            losses: 2,
            win_rate: 0.3333,
            total_pnl_usd: -30,
          },
        ],
      },
    };

    const suggestions = buildTradeReviewTuningSuggestions(summary, runtimeSummary, DEFAULT_CONFIG);

    expectSuggestionPatchesToBeSchemaValid(suggestions);
    expect(suggestions.some((suggestion) => suggestion.proposed_config_patch)).toBe(true);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "market_open_entry_cooldown",
          config_keys: expect.arrayContaining(["equity_entry_cooldown_minutes_after_open"]),
          evidence: expect.objectContaining({
            action: "entry_skipped_open_window",
            reason: "near_market_open",
          }),
        }),
      ])
    );
  });
});
