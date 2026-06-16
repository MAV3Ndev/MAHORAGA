import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, RecentSellEntry, ResearchResult } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import {
  type EntryFeaturePerformanceBlock,
  type EntryPerformanceBlock,
  evaluateEntryTimingBypass,
  evaluatePortfolioBucket,
  evaluateUnresearchedRecommendationBuy,
  getEntryFeatureKeysFromMetadata,
  getEntrySessionMetadata,
  getEntrySelectionScore,
  getRecentSellCooldown,
  inferPortfolioBucket,
  isAdaptiveBlockableEntryFeature,
  selectEntries,
} from "./entries";

afterEach(() => {
  vi.useRealTimers();
});

function makeCtx(
  recentSells: Record<string, RecentSellEntry> = {},
  entryPerformanceBlocks: Record<string, EntryPerformanceBlock> = {},
  entryFeaturePerformanceBlocks: Record<string, EntryFeaturePerformanceBlock> = {}
): StrategyContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      max_positions: 5,
      recent_sell_cooldown_hours: 72,
      defensive_sell_cooldown_hours: 168,
      min_entry_quality: "good",
      max_entry_red_flags: 0,
      min_entry_catalysts: 1,
      min_entry_signal_sources: 1,
      min_entry_signal_consensus: 0.15,
      single_source_entry_min_confidence: 0.82,
    },
    log: vi.fn(),
    state: {
      get: (key: string) => {
        if (key === "recentSells") return recentSells;
        if (key === "entryPerformanceBlocks") return entryPerformanceBlocks;
        if (key === "entryFeaturePerformanceBlocks") return entryFeaturePerformanceBlocks;
        return undefined;
      },
      set: vi.fn(),
    },
    positionEntries: {},
    signals: [
      {
        symbol: "SOLUSD",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.8,
        volume: 10,
        reason: "fresh signal",
        timestamp: Date.now(),
        raw_sentiment: 0.8,
        freshness: 1,
        source_weight: 1,
      },
    ],
  } as unknown as StrategyContext;
}

const account = { cash: 10_000, equity: 10_000 } as Account;
const buyResearch: ResearchResult = {
  symbol: "SOLUSD",
  verdict: "BUY",
  confidence: 0.9,
  entry_quality: "good",
  reasoning: "momentum",
  red_flags: [],
  catalysts: ["breakout"],
  timestamp: Date.now(),
};

function signalFor(symbol: string) {
  return {
    symbol,
    source: "stocktwits",
    source_detail: "stocktwits",
    sentiment: 0.8,
    volume: 10,
    reason: "fresh signal",
    timestamp: Date.now(),
    raw_sentiment: 0.8,
    freshness: 1,
    source_weight: 1,
  };
}

describe("entry recent-sell cooldown", () => {
  it("blocks re-entry using canonical crypto symbols", () => {
    const ctx = makeCtx({
      "SOL/USD": { symbol: "SOL/USD", sold_at: Date.now(), reason: "Stop loss" },
    });

    const cooldown = getRecentSellCooldown(ctx, "SOLUSD");
    expect(cooldown.blocked).toBe(true);
    expect(cooldown.symbolKey).toBe("SOL/USD");

    const entries = selectEntries(ctx, [buyResearch], [], account);
    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_recent_sell_cooldown",
      expect.objectContaining({ symbol_key: "SOL/USD" })
    );
  });

  it("allows re-entry after the cooldown expires", () => {
    const ctx = makeCtx({
      "SOL/USD": { symbol: "SOL/USD", sold_at: Date.now() - 73 * 60 * 60 * 1000, reason: "Take profit" },
    });

    expect(getRecentSellCooldown(ctx, "SOLUSD").blocked).toBe(false);
    expect(selectEntries(ctx, [buyResearch], [], account)).toHaveLength(1);
  });

  it("keeps defensive exits quarantined longer than normal profit exits", () => {
    const ctx = makeCtx({
      "SOL/USD": { symbol: "SOL/USD", sold_at: Date.now() - 100 * 60 * 60 * 1000, reason: "Bad fill early exit" },
    });

    const cooldown = getRecentSellCooldown(ctx, "SOLUSD");

    expect(cooldown.blocked).toBe(true);
    expect(cooldown.remainingMinutes).toBeGreaterThan(60 * 60);
    expect(selectEntries(ctx, [buyResearch], [], account)).toHaveLength(0);
  });

  it("blocks option entries when the underlying was sold recently", () => {
    const ctx = makeCtx({
      AAPL: { symbol: "AAPL", sold_at: Date.now(), reason: "Stop loss" },
    });

    const cooldown = getRecentSellCooldown(ctx, "AAPL260619C00195000");

    expect(cooldown.blocked).toBe(true);
    expect(cooldown.symbolKey).toBe("AAPL260619C00195000");
    expect(cooldown.reason).toBe("Stop loss");
  });

  it("blocks underlying entries when an option sell recorded the underlying alias", () => {
    const ctx = makeCtx({
      AAPL: { symbol: "AAPL", sold_at: Date.now(), reason: "Options stop loss" },
    });

    const cooldown = getRecentSellCooldown(ctx, "AAPL");

    expect(cooldown.blocked).toBe(true);
    expect(cooldown.symbolKey).toBe("AAPL");
    expect(cooldown.reason).toBe("Options stop loss");
  });
});

describe("entry quality gate", () => {
  it("skips fair or poor quality BUY research", () => {
    const ctx = makeCtx();

    const entries = selectEntries(ctx, [{ ...buyResearch, entry_quality: "fair" }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "low_entry_quality" })
    );
  });

  it("skips BUY research with red flags", () => {
    const ctx = makeCtx();

    const entries = selectEntries(ctx, [{ ...buyResearch, red_flags: ["already pumped"] }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "too_many_red_flags" })
    );
  });

  it("skips BUY research without concrete catalysts", () => {
    const ctx = makeCtx();

    const entries = selectEntries(ctx, [{ ...buyResearch, catalysts: [] }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_catalysts" })
    );
  });

  it("requires enough independent signal sources when configured", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 2;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_signal_sources" })
    );
  });

  it("requires higher confidence for single-source BUY research", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.single_source_entry_min_confidence = 0.82;

    const entries = selectEntries(ctx, [{ ...buyResearch, confidence: 0.78 }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({
        reason: "single_source_low_confidence",
        source_count: 1,
        min_single_source_confidence: 0.82,
      })
    );
  });

  it("allows lower confidence BUY research when independent sources confirm it", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.single_source_entry_min_confidence = 0.82;
    ctx.signals = [signalFor("SOLUSD"), { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit" }] as never;

    const entries = selectEntries(ctx, [{ ...buyResearch, confidence: 0.78 }], [], account);

    expect(entries).toHaveLength(1);
  });

  it("skips BUY research when average signal consensus is too low", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.min_entry_signal_consensus = 0.3;
    ctx.signals = [
      { ...signalFor("SOLUSD"), source: "stocktwits", source_detail: "stocktwits", sentiment: 0.4, raw_sentiment: 0.4 },
      { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit", sentiment: 0.2, raw_sentiment: 0.2 },
      { ...signalFor("SOLUSD"), source: "news", source_detail: "news", sentiment: -0.1, raw_sentiment: -0.1 },
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({
        reason: "low_signal_consensus",
        min_signal_consensus: 0.3,
        average_sentiment: 0.1667,
        bullish_signals: 2,
        bearish_signals: 1,
      })
    );
  });

  it("allows low average signal consensus when the consensus gate is disabled", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.min_entry_signal_consensus = 0;
    ctx.signals = [
      { ...signalFor("SOLUSD"), source: "stocktwits", source_detail: "stocktwits", sentiment: 0.4, raw_sentiment: 0.4 },
      { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit", sentiment: 0.2, raw_sentiment: 0.2 },
      { ...signalFor("SOLUSD"), source: "news", source_detail: "news", sentiment: -0.1, raw_sentiment: -0.1 },
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(1);
  });

  it("does not count multiple details from the same provider as independent signal sources", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 2;
    ctx.signals = [
      { ...signalFor("SOLUSD"), source: "stocktwits", source_detail: "stocktwits:trending" },
      { ...signalFor("SOLUSD"), source: "stocktwits", source_detail: "stocktwits:watchlist" },
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_signal_sources", source_count: 1 })
    );
  });

  it("requires a current signal for BUY research", () => {
    const ctx = makeCtx();
    ctx.signals = [];

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_signal_sources", source_count: 0 })
    );
  });

  it("ignores current signals below the configured sentiment threshold", () => {
    const ctx = makeCtx();
    ctx.config.min_sentiment_score = 0.3;
    ctx.signals = [{ ...signalFor("SOLUSD"), raw_sentiment: 0.2, sentiment: 0.2 }] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_signal_sources", source_count: 0 })
    );
  });

  it("ignores stale current signals when confirming BUY research", () => {
    const ctx = makeCtx();
    ctx.config.max_entry_research_age_minutes = 30;
    ctx.signals = [{ ...signalFor("SOLUSD"), timestamp: Date.now() - 31 * 60 * 1000 }] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "insufficient_signal_sources", source_count: 0 })
    );
  });

  it("skips BUY research when fresh symbol signals have weak consensus", () => {
    const ctx = makeCtx();
    ctx.config.min_sentiment_score = 0.3;
    ctx.signals = [
      signalFor("SOLUSD"),
      { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit", sentiment: -0.4, raw_sentiment: 0.4 },
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({
        reason: "weak_signal_consensus",
        source_count: 1,
        average_sentiment: 0.2,
        bullish_signals: 1,
        bearish_signals: 1,
      })
    );
  });

  it("treats bearish vote imbalance as negative consensus even when sentiment is positive", () => {
    const ctx = makeCtx();
    ctx.config.min_sentiment_score = 0.3;
    ctx.signals = [
      signalFor("SOLUSD"),
      {
        ...signalFor("SOLUSD"),
        source: "reddit",
        source_detail: "reddit",
        sentiment: 0.4,
        raw_sentiment: 0.4,
        bullish: 1,
        bearish: 4,
      },
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({
        reason: "weak_signal_consensus",
        source_count: 1,
        average_sentiment: 0.2,
        bullish_signals: 1,
        bearish_signals: 1,
      })
    );
  });

  it("skips stale BUY research before it can become an entry", () => {
    const ctx = makeCtx();
    ctx.config.max_entry_research_age_minutes = 30;

    const entries = selectEntries(ctx, [{ ...buyResearch, timestamp: Date.now() - 31 * 60 * 1000 }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_quality_gate",
      expect.objectContaining({ reason: "stale_research", age_minutes: 31 })
    );
  });

  it("skips symbols blocked by poor recent journal performance", () => {
    const ctx = makeCtx(
      {},
      {
        "SOL/USD": {
          symbol: "SOL/USD",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -120,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_poor_recent_performance",
      expect.objectContaining({ symbol: "SOLUSD", trades: 4, win_rate: 0.25, total_pnl_usd: -120 })
    );
  });

  it("limits entry candidates by configuration", () => {
    const ctx = makeCtx();
    ctx.config.entry_candidate_limit = 1;
    ctx.signals = [signalFor("AAA"), signalFor("BBB")] as never;

    const entries = selectEntries(
      ctx,
      [
        { ...buyResearch, symbol: "AAA", confidence: 0.95 },
        { ...buyResearch, symbol: "BBB", confidence: 0.9 },
      ],
      [],
      account
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.symbol).toBe("AAA");
  });

  it("prioritizes stronger setup quality when the entry limit is tight", () => {
    const ctx = makeCtx();
    ctx.config.entry_candidate_limit = 1;
    ctx.signals = [
      signalFor("AAA"),
      signalFor("BBB"),
      { ...signalFor("BBB"), source: "reddit", source_detail: "reddit" },
    ] as never;
    const higherConfidenceThinSetup = {
      ...buyResearch,
      symbol: "AAA",
      confidence: 0.95,
      entry_quality: "good" as const,
      catalysts: ["breakout"],
    };
    const lowerConfidenceStrongerSetup = {
      ...buyResearch,
      symbol: "BBB",
      confidence: 0.9,
      entry_quality: "excellent" as const,
      catalysts: ["earnings revision", "relative strength"],
    };

    const entries = selectEntries(ctx, [higherConfidenceThinSetup, lowerConfidenceStrongerSetup], [], account);

    expect(getEntrySelectionScore(ctx, lowerConfidenceStrongerSetup)).toBeGreaterThan(
      getEntrySelectionScore(ctx, higherConfidenceThinSetup)
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.symbol).toBe("BBB");
    expect(entries[0]?.metadata).toEqual(expect.objectContaining({ entry_selection_score: expect.any(Number) }));
  });

  it("skips researched BUYs below the minimum entry selection score", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_selection_score = 1.2;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_low_selection_score",
      expect.objectContaining({
        symbol: "SOLUSD",
        min_entry_selection_score: 1.2,
      })
    );
  });

  it("logs when a researched BUY is too small to submit", () => {
    const ctx = makeCtx();

    const entries = selectEntries(ctx, [buyResearch], [], { ...account, cash: 10 });

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_notional_too_small",
      expect.objectContaining({
        symbol: "SOLUSD",
        min_notional: 100,
        cash: 10,
      })
    );
  });

  it("attaches review metadata to entry candidates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T13:45:00.000Z"));
    const ctx = makeCtx();
    const research = { ...buyResearch, timestamp: Date.now() };

    const entries = selectEntries(ctx, [research], [], account);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual(
      expect.objectContaining({
        entry_path: "strategy_select_entries",
        portfolio_bucket: "crypto",
        confidence: 0.9,
        research_confidence: 0.9,
        research_confirmed: true,
        entry_quality: "good",
        red_flag_count: 0,
        catalyst_count: 1,
        source_count: 1,
        signal_sources: 1,
        signal_source_details: 1,
        signal_consensus_average: 0.8,
        signal_consensus_bullish: 1,
        signal_consensus_bearish: 0,
        signal_consensus_state: "aligned",
        entry_timestamp: "2026-06-05T13:45:00.000Z",
        entry_session: "open_30m",
        entry_weekday: "Fri",
        entry_hour_et: 9,
        entry_minute_et: 45,
      })
    );
    const featureKeys = getEntryFeatureKeysFromMetadata(entries[0]?.metadata);
    expect(featureKeys).toContain("portfolio_bucket:crypto");
    expect(featureKeys).toContain("signal_consensus:aligned");
    expect(featureKeys).toContain("entry_selection_score:1.05-1.14");
    expect(featureKeys).toContain("research_confirmation:confirmed");
    expect(featureKeys).toContain("entry_quality:good");
    expect(featureKeys).toContain("red_flags:0");
    expect(featureKeys).toContain("catalysts:1");
    expect(featureKeys).toContain("entry_session:open_30m");
    expect(featureKeys).toContain("entry_weekday:Fri");
  });

  it("derives ET entry-session metadata from the decision timestamp", () => {
    expect(getEntrySessionMetadata(new Date("2026-06-05T19:45:00.000Z").getTime())).toEqual(
      expect.objectContaining({
        entry_timestamp: "2026-06-05T19:45:00.000Z",
        entry_session: "close_30m",
        entry_weekday: "Fri",
        entry_hour_et: 15,
        entry_minute_et: 45,
      })
    );
  });

  it("tags unconfirmed recommendation metadata for adaptive performance blocks", () => {
    const featureKeys = getEntryFeatureKeysFromMetadata({
      entry_path: "llm_recommendation_unresearched",
      confidence: 0.95,
      entry_quality: "fair",
      red_flag_count: 1,
      catalyst_count: 0,
      source_count: 2,
      research_confirmed: false,
      entry_price_change_pct: 6.4,
      entry_spread_pct: 1.3,
    });

    expect(featureKeys).toContain("research_confirmation:unconfirmed");
    expect(featureKeys).toContain("entry_quality:fair");
    expect(featureKeys).toContain("red_flags:1");
    expect(featureKeys).toContain("catalysts:0");
    expect(featureKeys).toContain("entry_price_change:5%+");
    expect(featureKeys).toContain("entry_spread:0.80%..2%");
  });

  it("only allows risky quality, red-flag, and catalyst features to become adaptive blocks", () => {
    expect(isAdaptiveBlockableEntryFeature("entry_quality:excellent")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_quality:good")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_quality:fair")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_path:strategy_select_entries")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_path:premarket_plan")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_path:llm_recommendation_unresearched")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("red_flags:0")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("red_flags:1")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("catalysts:0")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("catalysts:1")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_selection_score:0.85-0.94")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_session:open_30m")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_session:midday")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_weekday:Fri")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_price_change:0%..2%")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_price_change:2%..5%")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_price_change:5%+")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_spread:0.25%..0.80%")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("entry_spread:0.80%..2%")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("entry_spread:2%+")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("portfolio_bucket:technology")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("portfolio_bucket:crypto")).toBe(true);
    expect(isAdaptiveBlockableEntryFeature("portfolio_bucket:individual:XYZ")).toBe(false);
    expect(isAdaptiveBlockableEntryFeature("portfolio_bucket:unknown")).toBe(false);
  });

  it("does not block all strategy entries from an overly broad entry-path feature", () => {
    const ctx = makeCtx(
      {},
      {},
      {
        "entry_path:strategy_select_entries": {
          feature: "entry_path:strategy_select_entries",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -180,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(1);
    expect(ctx.log).not.toHaveBeenCalledWith("System", "entry_skipped_poor_feature_performance", expect.anything());
  });

  it("ignores stale adaptive blocks for healthy baseline feature keys", () => {
    const ctx = makeCtx(
      {},
      {},
      {
        "red_flags:0": {
          feature: "red_flags:0",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -180,
          updatedAt: new Date().toISOString(),
        },
        "catalysts:1": {
          feature: "catalysts:1",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -180,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(1);
    expect(ctx.log).not.toHaveBeenCalledWith("System", "entry_skipped_poor_feature_performance", expect.anything());
  });

  it("skips entries matching a risky poor quality feature block", () => {
    const ctx = makeCtx(
      {},
      {},
      {
        "entry_quality:fair": {
          feature: "entry_quality:fair",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -180,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    const fairResearch = {
      ...buyResearch,
      entry_quality: "fair" as const,
      confidence: 0.95,
    };
    ctx.config.min_entry_quality = "fair";
    const entries = selectEntries(ctx, [fairResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_poor_feature_performance",
      expect.objectContaining({
        symbol: "SOLUSD",
        feature: "entry_quality:fair",
        trades: 4,
        win_rate: 0.25,
      })
    );
  });

  it("skips entries matching a weak portfolio bucket feature block", () => {
    const ctx = makeCtx(
      {},
      {},
      {
        "portfolio_bucket:technology": {
          feature: "portfolio_bucket:technology",
          trades: 4,
          wins: 1,
          losses: 3,
          winRate: 0.25,
          totalPnlUsd: -220,
          updatedAt: new Date().toISOString(),
        },
      }
    );
    ctx.signals = [signalFor("NVDA")] as never;

    const entries = selectEntries(ctx, [{ ...buyResearch, symbol: "NVDA" }], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_poor_feature_performance",
      expect.objectContaining({
        symbol: "NVDA",
        feature: "portfolio_bucket:technology",
        trades: 4,
        win_rate: 0.25,
      })
    );
  });

  it("scales low-confidence position size down when enabled", () => {
    const ctx = makeCtx();
    ctx.config.min_analyst_confidence = 0.6;
    ctx.config.llm_size_conviction_scaling = true;
    ctx.config.market_regime_enabled = false;
    ctx.config.single_source_entry_min_confidence = 0.6;
    ctx.config.min_entry_selection_score = 0;
    ctx.config.llm_size_low_confidence_multiplier = 0.5;
    ctx.config.position_size_pct_of_cash = 20;

    const entries = selectEntries(ctx, [{ ...buyResearch, confidence: 0.6 }], [], account);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.notional).toBe(600);
  });

  it("does not treat a single-symbol signal as the whole market regime", () => {
    const ctx = makeCtx();
    ctx.config.market_regime_enabled = true;
    ctx.config.regime_low_threshold = 0.5;
    ctx.config.regime_position_size_reduction = 0.5;
    ctx.config.position_size_pct_of_cash = 20;
    ctx.signals = [
      {
        symbol: "SOLUSD",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.4,
        volume: 10,
        reason: "weak tape",
        timestamp: Date.now(),
        raw_sentiment: 0.4,
        freshness: 1,
        source_weight: 1,
      },
    ];

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(1);
    expect(ctx.log).not.toHaveBeenCalledWith(
      "System",
      "entry_skipped_market_regime",
      expect.objectContaining({ symbol: "SOLUSD" })
    );
  });

  it("skips ordinary entries when weak signals span enough market-regime breadth", () => {
    const ctx = makeCtx();
    ctx.config.market_regime_enabled = true;
    ctx.config.regime_low_threshold = 0.5;
    ctx.config.regime_position_size_reduction = 0.5;
    ctx.config.position_size_pct_of_cash = 20;
    ctx.signals = [
      {
        symbol: "SOLUSD",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.4,
        volume: 10,
        reason: "weak tape",
        timestamp: Date.now(),
        raw_sentiment: 0.4,
        freshness: 1,
        source_weight: 1,
      },
      {
        symbol: "AAPL",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.35,
        volume: 10,
        reason: "weak tape",
        timestamp: Date.now(),
        raw_sentiment: 0.35,
        freshness: 1,
        source_weight: 1,
      },
      {
        symbol: "JPM",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.35,
        volume: 10,
        reason: "weak tape",
        timestamp: Date.now(),
        raw_sentiment: 0.35,
        freshness: 1,
        source_weight: 1,
      },
    ];

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_market_regime",
      expect.objectContaining({
        symbol: "SOLUSD",
        reason: "weak_market_regime",
        average_sentiment: 0.3667,
      })
    );
  });

  it("does not let stale signals drive the market regime gate", () => {
    const ctx = makeCtx();
    ctx.config.market_regime_enabled = true;
    ctx.config.regime_low_threshold = 0.5;
    ctx.config.max_entry_research_age_minutes = 30;
    ctx.signals = [
      {
        ...signalFor("SOLUSD"),
        sentiment: 0.4,
        raw_sentiment: 0.4,
        timestamp: Date.now() - 31 * 60 * 1000,
      },
      signalFor("SOLUSD"),
    ] as never;

    const entries = selectEntries(ctx, [buyResearch], [], account);

    expect(entries).toHaveLength(1);
    expect(ctx.log).not.toHaveBeenCalledWith(
      "System",
      "entry_skipped_market_regime",
      expect.objectContaining({ symbol: "SOLUSD" })
    );
  });

  it("blocks exceptional unresearched recommendations without fresh signal sources", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.max_entry_research_age_minutes = 30;
    ctx.signals = [{ ...signalFor("SOLUSD"), timestamp: Date.now() - 31 * 60 * 1000 }] as never;

    const gate = evaluateUnresearchedRecommendationBuy(ctx, "SOLUSD", 0.96);

    expect(gate).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "insufficient_signal_sources",
        sourceCount: 0,
        minSources: 1,
      })
    );
  });

  it("blocks unresearched recommendations with only one source below the single-source confidence threshold", () => {
    const ctx = makeCtx();
    ctx.config.min_entry_signal_sources = 1;
    ctx.config.single_source_entry_min_confidence = 0.82;

    const gate = evaluateUnresearchedRecommendationBuy(ctx, "SOLUSD", 0.78);

    expect(gate).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "single_source_low_confidence",
        sourceCount: 1,
        requiredConfidence: 0.82,
      })
    );
  });

  it("allows exceptional excellent entries in weak market regime with reduced size", () => {
    const ctx = makeCtx();
    ctx.config.market_regime_enabled = true;
    ctx.config.regime_low_threshold = 0.5;
    ctx.config.regime_position_size_reduction = 0.5;
    ctx.config.exceptional_entry_confidence = 0.9;
    ctx.config.position_size_pct_of_cash = 20;
    ctx.signals = [
      {
        symbol: "SOLUSD",
        source: "stocktwits",
        source_detail: "stocktwits",
        sentiment: 0.4,
        volume: 10,
        reason: "weak tape",
        timestamp: Date.now(),
        raw_sentiment: 0.4,
        freshness: 1,
        source_weight: 1,
      },
      { ...signalFor("AAPL"), sentiment: 0.35, raw_sentiment: 0.35 },
      { ...signalFor("JPM"), sentiment: 0.35, raw_sentiment: 0.35 },
    ];

    const entries = selectEntries(ctx, [{ ...buyResearch, confidence: 0.95, entry_quality: "excellent" }], [], account);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.notional).toBe(950);
  });

  it("allows timing bypass only for exceptional excellent research with aligned signals", () => {
    const ctx = makeCtx();
    ctx.config.exceptional_entry_confidence = 0.9;
    ctx.config.regime_low_threshold = 0.5;
    ctx.signals = [signalFor("SOLUSD"), { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit" }] as never;

    expect(evaluateEntryTimingBypass(ctx, "SOLUSD", 0.95, "excellent")).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: "exceptional_research_with_aligned_signals",
        consensusState: "aligned",
      })
    );

    expect(evaluateEntryTimingBypass(ctx, "SOLUSD", 0.95, "good")).toEqual(
      expect.objectContaining({ allowed: false, quality: "good" })
    );
    expect(evaluateEntryTimingBypass(ctx, "SOLUSD", 0.89, "excellent")).toEqual(
      expect.objectContaining({ allowed: false, confidence: 0.89 })
    );
  });

  it("does not bypass timing when fresh consensus is weak or mixed", () => {
    const ctx = makeCtx();
    ctx.config.exceptional_entry_confidence = 0.9;
    ctx.config.min_sentiment_score = 0.3;
    ctx.signals = [
      signalFor("SOLUSD"),
      { ...signalFor("SOLUSD"), source: "reddit", source_detail: "reddit", sentiment: -0.4, raw_sentiment: 0.4 },
    ] as never;

    expect(evaluateEntryTimingBypass(ctx, "SOLUSD", 0.95, "excellent")).toEqual(
      expect.objectContaining({
        allowed: false,
        consensusState: "weak_mixed",
        bullishSignals: 1,
        bearishSignals: 1,
      })
    );
  });

  it("skips entries that would over-concentrate a portfolio bucket", () => {
    const ctx = makeCtx();
    ctx.config.portfolio_risk_enabled = true;
    ctx.config.max_positions_per_sector = 2;
    ctx.signals = [signalFor("NVDA")] as never;

    const entries = selectEntries(
      ctx,
      [{ ...buyResearch, symbol: "NVDA", confidence: 0.9 }],
      [{ symbol: "AAPL" }, { symbol: "MSFT" }] as never,
      account
    );

    expect(inferPortfolioBucket("NVDA")).toBe("technology");
    expect(entries).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      "System",
      "entry_skipped_portfolio_bucket",
      expect.objectContaining({ symbol: "NVDA", bucket: "technology", current_count: 2, max_count: 2 })
    );
  });

  it("uses individual buckets for unknown symbols instead of broad blocking", () => {
    const ctx = makeCtx();
    ctx.config.portfolio_risk_enabled = true;
    ctx.config.max_positions_per_sector = 1;

    const result = evaluatePortfolioBucket(ctx, "XYZ", [{ symbol: "ABC" }] as never, []);

    expect(result.blocked).toBe(false);
    expect(result.bucket).toBe("individual:XYZ");
  });
});
