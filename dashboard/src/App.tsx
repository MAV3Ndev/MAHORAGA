import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DetailDialog } from "./components/DetailDialog";
import { LineChart, PositionTimelineChart, Sparkline } from "./components/LineChart";
import { AnimatedMetricValue, MetricInline } from "./components/Metric";
import { NotificationBell } from "./components/NotificationBell";
import { Panel } from "./components/Panel";
import { SettingsModal } from "./components/SettingsModal";
import { SetupWizard } from "./components/SetupWizard";
import { StatusBar, StatusIndicator } from "./components/StatusIndicator";
import { Tooltip, TooltipContent } from "./components/Tooltip";
import {
  type ConnectionSettings,
  type DesktopUpdateEvent,
  checkDesktopUpdate,
  getDesktopAppVersion,
  getResponseError,
  installDesktopUpdate,
  isDesktopPanel,
  isNativeShell,
  loadConnectionSettings,
  maskBearerToken,
  normalizeApiUrl,
  requestAgent,
  saveConnectionSettings,
  showDesktopNotification,
  subscribeDesktopUpdate,
  subscribeDesktopLifecycle,
} from "./lib/connection";
import type {
  Config,
  LogEntry,
  PortfolioSnapshot,
  Position,
  PositionTimelineHistory,
  PositionTimelinePoint,
  RuntimeSummary,
  Signal,
  SignalResearch,
  Status,
} from "./types";

interface AgentEnvelope<T> {
  ok?: boolean;
  data?: T;
  config?: Config;
  error?: string;
}

type PortfolioPeriod = "5min" | "1H" | "6H" | "1D" | "7D" | "30D";
const PORTFOLIO_PERIOD_OPTIONS = ["5min", "1H", "6H", "1D", "7D", "30D"] as const;
const APY_PERIOD_FALLBACKS: PortfolioPeriod[] = ["30D", "7D", "1D"];
const MARKET_TIME_ZONE = "America/New_York";
const RESUME_REFRESH_THROTTLE_MS = 5000;
const ORDER_NOTIFICATION_KEY_CAP = 240;
const ACTIVITY_FEED_KEY_CAP = 240;
const ACTIVE_STATUS_POLL_MS = 5000;
const HIDDEN_STATUS_POLL_MS = 30000;
const ACTIVE_CLOCK_TICK_MS = 1000;
const HIDDEN_CLOCK_TICK_MS = 60000;
const marketTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const marketWeekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  weekday: "short",
  day: "numeric",
});
const marketMonthDayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  month: "short",
  day: "numeric",
});
const marketHourMinutePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatCompactCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

function formatHoldDuration(startTimestamp: number, endTimestamp: number): string {
  const elapsedMs = Math.max(0, endTimestamp - startTimestamp);
  const elapsedHours = elapsedMs / 3600000;

  if (elapsedHours < 24) {
    return `${elapsedHours.toFixed(elapsedHours >= 10 ? 0 : 1)}h`;
  }

  return `${(elapsedHours / 24).toFixed(elapsedHours >= 24 * 10 ? 0 : 1)}d`;
}

function rememberBoundedKey(target: Set<string>, key: string, maxSize: number): void {
  target.add(key);
  while (target.size > maxSize) {
    const oldest = target.values().next();
    if (oldest.done) break;
    target.delete(oldest.value);
  }
}

function rememberBoundedKeys(target: Set<string>, keys: string[], maxSize: number): void {
  for (const key of keys) {
    rememberBoundedKey(target, key, maxSize);
  }
}

function getAgentColor(agent: string): string {
  const colors: Record<string, string> = {
    Analyst: "text-hud-purple",
    Executor: "text-hud-cyan",
    StockTwits: "text-hud-success",
    SignalResearch: "text-hud-cyan",
    PositionResearch: "text-hud-purple",
    Crypto: "text-hud-warning",
    System: "text-hud-text-dim",
  };
  return colors[agent] || "text-hud-text";
}

function isCryptoSymbol(symbol: string, cryptoSymbols: string[] = []): boolean {
  const upperSymbol = symbol.toUpperCase();
  const matchesConfig = cryptoSymbols.some((cs) => {
    const normalizedConfig = cs.toUpperCase();
    if (upperSymbol === normalizedConfig) return true;
    const baseSymbol = normalizedConfig.split("/")[0];
    const quoteSymbol = normalizedConfig.split("/")[1] || "USD";
    return upperSymbol === `${baseSymbol}${quoteSymbol}`;
  });
  return matchesConfig || /^[A-Z]{2,5}\/(USD|USDT|USDC)$/.test(upperSymbol);
}

function formatCryptoSymbol(symbol: string, cryptoSymbols: string[] = []): string {
  if (symbol.includes("/")) return symbol;
  const upperSymbol = symbol.toUpperCase();
  for (const cs of cryptoSymbols) {
    const baseSymbol = cs.split("/")[0].toUpperCase();
    if (upperSymbol.startsWith(baseSymbol)) {
      const quote = upperSymbol.slice(baseSymbol.length);
      if (quote.length >= 3 && ["USD", "USDT", "USDC"].includes(quote)) {
        return `${baseSymbol}/${quote}`;
      }
    }
  }
  const match = upperSymbol.match(/^([A-Z]{2,5})(USD|USDT|USDC)$/);
  if (match) return `${match[1]}/${match[2]}`;
  return symbol;
}

function getVerdictColor(verdict: string): string {
  if (verdict === "BUY") return "text-hud-success";
  if (verdict === "SKIP") return "text-hud-error";
  return "text-hud-warning";
}

function getQualityColor(quality: string): string {
  if (quality === "excellent") return "text-hud-success";
  if (quality === "good") return "text-hud-primary";
  if (quality === "fair") return "text-hud-warning";
  return "text-hud-error";
}

function getSentimentColor(score: number): string {
  if (score >= 0.3) return "text-hud-success";
  if (score <= -0.2) return "text-hud-error";
  return "text-hud-warning";
}

function getSafeSentiment(score: number | undefined): number | null {
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

type EntryDiagnostic = {
  state: "active" | "blocked" | "idle";
  label: string;
  detail: string;
  blockerLabel: string;
  blockerCount: number;
  lastBuyLabel: string;
  hints: string[];
  pipeline: {
    researchBuy: number;
    researchTotal: number;
    researchFreshBuy: number;
    strategyCandidates: number;
    analystBuy: number;
    analystBuyAboveThreshold: number;
    missedEntryEvaluated: number;
    missedEntryWouldHaveWon: number;
    missedEntryWouldHaveLost: number;
    topMissedEntryReason: {
      reason: string;
      evaluated: number;
      wouldHaveWon: number;
      wouldHaveLost: number;
    } | null;
  };
};

const ENTRY_BLOCKER_PATTERNS = [
  "buy_blocked",
  "buy_rejected",
  "buy_skipped",
  "entry_skipped",
  "llm_buy_skipped",
  "premarket_buy_skipped",
  "options_buy_rejected",
  "options_buy_skipped",
] as const;

function asLogString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asLogNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatElapsedFromNow(timestamp: string, now: number): string {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return "UNKNOWN";
  const minutes = Math.max(0, Math.round((now - parsed) / 60000));
  if (minutes < 1) return "JUST NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}H AGO`;
  return `${Math.round(hours / 24)}D AGO`;
}

function getEntryDiagnosticHint(action: string, reason: string | null): string | null {
  if (action.includes("no_signals")) return "No fresh signals are reaching the entry loop.";
  if (action.includes("no_capacity")) return "Position capacity is full or pending orders are reserving slots.";
  if (action.includes("timing_gate")) return "Entry timing is rejecting candidates.";
  if (action.includes("recent_sell_cooldown")) return "Recent sell cooldown is blocking re-entry.";
  if (action.includes("notional_too_small")) return "Cash or position sizing is below the minimum order size.";
  if (action.includes("portfolio_bucket")) return "Portfolio concentration rules are blocking the symbol group.";
  if (action.includes("poor_recent_performance")) return "Adaptive performance blocks are filtering weak symbols.";
  if (action.includes("poor_feature_performance")) return "Adaptive feature blocks are filtering weak setups.";
  if (reason === "low_confidence") return "LLM confidence is below the configured entry threshold.";
  if (reason === "low_entry_quality") return "Entry quality is below the configured minimum.";
  if (reason === "insufficient_catalysts") return "Research lacks enough catalysts for the configured gate.";
  if (reason === "insufficient_signal_sources") return "Not enough independent fresh signal sources confirm the idea.";
  if (reason === "weak_signal_consensus") return "Fresh signals are mixed or not bullish enough.";
  if (reason === "stale_research") return "Research is expiring before it can become an order.";
  if (reason === "too_many_red_flags") return "Research red flags exceed the configured limit.";
  return null;
}

function buildEntryDiagnostic(
  logs: LogEntry[],
  signals: Signal[],
  positions: Position[],
  config: Config | undefined,
  isMarketOpen: boolean,
  now: number,
  runtimeSummary?: RuntimeSummary
): EntryDiagnostic {
  const recentLogs = logs.slice(-200);
  const blockers = new Map<string, { action: string; reason: string | null; count: number; symbols: Set<string> }>();
  let buyCount = 0;
  let researchCount = 0;
  let analystCompleteCount = 0;
  let analystSkippedCount = 0;
  let lastBuyTimestamp: string | null = null;

  for (const log of recentLogs) {
    const action = asLogString(log.action) ?? "";
    if (!action) continue;

    if (
      action === "buy_executed" ||
      action === "buy_submitted" ||
      action === "options_buy_executed" ||
      action === "options_buy_submitted" ||
      action === "buy_outcome_deferred" ||
      action === "options_outcome_deferred"
    ) {
      buyCount += 1;
      lastBuyTimestamp = log.timestamp;
    }
    if (action === "signal_researched") researchCount += 1;
    if (action === "analysis_complete") analystCompleteCount += 1;
    if (action === "analyst_skipped") analystSkippedCount += 1;

    if (ENTRY_BLOCKER_PATTERNS.some((pattern) => action.includes(pattern))) {
      const reason = asLogString(log.reason) ?? asLogString(log.sell_reason) ?? asLogString(log.violation) ?? "unknown";
      const key = `${action}:${reason}`;
      const bucket = blockers.get(key) ?? { action, reason, count: 0, symbols: new Set<string>() };
      bucket.count += 1;
      const symbol = asLogString(log.symbol) ?? asLogString(log.requested_symbol) ?? asLogString(log.contract);
      if (symbol) bucket.symbols.add(symbol.toUpperCase());
      blockers.set(key, bucket);
    }
  }

  const serverPipeline = runtimeSummary?.entry_pipeline;
  const serverBlocker = serverPipeline?.dominant_entry_blocker;
  const topBlocker =
    [...blockers.values()].sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))[0] ??
    (serverBlocker?.action
      ? {
          action: serverBlocker.action,
          reason: serverBlocker.reason ?? null,
          count: serverBlocker.count ?? 0,
          symbols: new Set(serverBlocker.symbols ?? []),
        }
      : undefined);
  const hints = new Set<string>();

  if (!isMarketOpen) hints.add("Market is closed; equity buys wait for the next open window.");
  if (signals.length === 0) hints.add("No active signals are visible in the current status payload.");
  if (config && positions.length >= config.max_positions) hints.add("Open positions are at the configured limit.");
  if (analystSkippedCount > 0 && analystCompleteCount === 0) hints.add("Analyst loop has skipped recently.");
  if (researchCount === 0) hints.add("No recent signal research is visible in the activity window.");
  if (topBlocker) {
    const hint = getEntryDiagnosticHint(topBlocker.action, topBlocker.reason);
    if (hint) hints.add(hint);
  }
  for (const hint of serverPipeline?.diagnosis_hints ?? []) {
    if (hint === "analyst_not_running_or_market_closed") hints.add("Analyst is not running or the market is closed.");
    else if (hint === "no_signal_research_candidates") hints.add("Signal research found no eligible candidates.");
    else if (hint === "no_recent_signal_research") hints.add("No recent signal research is visible on the Worker.");
    else if (hint === "researched_buy_not_converting_to_strategy_entries") {
      hints.add("BUY research is not converting into strategy entries.");
    } else if (hint === "strategy_entries_created_but_not_executed") {
      hints.add("Strategy entries exist but are not reaching filled buy orders.");
    } else if (hint === "analyst_buy_recommendations_below_confidence_threshold") {
      hints.add("Analyst BUY recommendations are below the confidence threshold.");
    } else if (hint === "check_data_gatherers_and_signal_sources")
      hints.add("Check data gatherers and signal sources.");
    else if (hint === "max_positions_or_pending_orders_are_full")
      hints.add("Position capacity or pending orders are full.");
    else if (hint === "min_analyst_confidence_may_be_too_strict_for_current_signals") {
      hints.add("The analyst confidence threshold may be too strict for current signals.");
    } else if (hint === "min_entry_quality_may_be_too_strict") {
      hints.add("The minimum entry quality may be too strict.");
    } else if (hint === "min_entry_catalysts_may_be_too_strict") {
      hints.add("The catalyst requirement may be too strict.");
    } else if (hint === "signals_are_mixed_or_bearish") hints.add("Signals are mixed or bearish.");
    else if (hint === "research_cache_is_stale_before_entry") hints.add("Research is expiring before entry.");
    else if (hint === "entry_timing_gate_is_blocking_entries") hints.add("Entry timing is blocking candidates.");
    else if (hint === "recent_sell_cooldown_is_blocking_reentry")
      hints.add("Recent sell cooldown is blocking re-entry.");
    else if (hint === "cash_or_position_sizing_is_too_small") hints.add("Cash or position sizing is too small.");
    else hints.add(hint.replace(/_/g, " "));
  }

  const blockerLabel = topBlocker
    ? topBlocker.reason && topBlocker.reason !== "unknown"
      ? `${humanizeAction(topBlocker.action)}: ${topBlocker.reason}`
      : humanizeAction(topBlocker.action)
    : "No blocker in recent logs";

  const topBlockerConfidence = topBlocker
    ? (recentLogs
        .filter((log) => log.action === topBlocker.action)
        .map((log) => asLogNumber(log.confidence))
        .find((value): value is number => value !== null) ?? null)
    : null;

  const serverBuyCount =
    (serverPipeline?.buys_executed ?? 0) + (serverPipeline?.buys_submitted ?? 0) + (serverPipeline?.buys_deferred ?? 0);
  const researchTotal = serverPipeline?.signal_researched ?? researchCount;
  const researchBuy =
    serverPipeline?.signal_research_buy ??
    recentLogs.filter((log) => log.action === "signal_researched" && asLogString(log.verdict) === "BUY").length;
  const freshResearchBuy = serverPipeline?.researched_buy_available ?? researchBuy;
  const strategyCandidates = serverPipeline?.strategy_entry_candidates ?? 0;
  const analystBuy = serverPipeline?.analyst_buy_recommendations ?? 0;
  const analystBuyAboveThreshold = serverPipeline?.analyst_buy_recommendations_above_threshold ?? 0;
  const missedEntryEvaluated = serverPipeline?.missed_entry_evaluated ?? 0;
  const missedEntryWouldHaveWon = serverPipeline?.missed_entry_would_have_won ?? 0;
  const missedEntryWouldHaveLost = serverPipeline?.missed_entry_would_have_lost ?? 0;
  const topMissedEntryReason =
    serverPipeline?.missed_entry_reasons
      ?.filter((reason) => (reason.evaluated ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.would_have_won ?? 0) - (a.would_have_won ?? 0) ||
          (b.evaluated ?? 0) - (a.evaluated ?? 0) ||
          (a.reason ?? "").localeCompare(b.reason ?? "")
      )[0] ?? null;
  if (missedEntryEvaluated > 0 && missedEntryWouldHaveWon > missedEntryWouldHaveLost) {
    hints.add("Skipped candidates are later moving favorably; inspect missed entry gates.");
  }
  const effectiveBuyCount = Math.max(buyCount, serverBuyCount);
  const state: EntryDiagnostic["state"] =
    effectiveBuyCount > 0 ? "active" : topBlocker || hints.size > 0 ? "blocked" : "idle";
  const label = state === "active" ? "BUY FLOW ACTIVE" : state === "blocked" ? "ENTRY GATED" : "WAITING";
  const detail =
    state === "active"
      ? `${effectiveBuyCount} buy event${effectiveBuyCount === 1 ? "" : "s"} in recent logs`
      : topBlockerConfidence !== null
        ? `Top blocker confidence ${(topBlockerConfidence * 100).toFixed(0)}%`
        : `${signals.length} signal${signals.length === 1 ? "" : "s"}, ${positions.length}/${config?.max_positions ?? 0} positions`;

  return {
    state,
    label,
    detail,
    blockerLabel,
    blockerCount: topBlocker?.count ?? 0,
    lastBuyLabel: lastBuyTimestamp ? formatElapsedFromNow(lastBuyTimestamp, now) : "NONE",
    hints: [...hints].slice(0, 3),
    pipeline: {
      researchBuy,
      researchTotal,
      researchFreshBuy: freshResearchBuy,
      strategyCandidates,
      analystBuy,
      analystBuyAboveThreshold,
      missedEntryEvaluated,
      missedEntryWouldHaveWon,
      missedEntryWouldHaveLost,
      topMissedEntryReason: topMissedEntryReason
        ? {
            reason: topMissedEntryReason.reason ?? "unknown",
            evaluated: topMissedEntryReason.evaluated ?? 0,
            wouldHaveWon: topMissedEntryReason.would_have_won ?? 0,
            wouldHaveLost: topMissedEntryReason.would_have_lost ?? 0,
          }
        : null,
    },
  };
}

function getPeriodStartTimestamp(period: PortfolioPeriod, endTimestamp: number): number {
  if (period === "5min") return endTimestamp - 5 * 60 * 1000;
  if (period === "1H") return endTimestamp - 60 * 60 * 1000;
  if (period === "6H") return endTimestamp - 6 * 60 * 60 * 1000;
  if (period === "1D") return endTimestamp - 24 * 60 * 60 * 1000;
  if (period === "7D") return endTimestamp - 7 * 24 * 60 * 60 * 1000;
  return endTimestamp - 30 * 24 * 60 * 60 * 1000;
}

function getMarketHourMinuteParts(timestamp: number): { hour: number; minute: number } {
  const parts = marketHourMinutePartsFormatter.formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function getPortfolioHistoryQueries(
  period: PortfolioPeriod
): Array<{ period: string; timeframe: string; intraday?: string }> {
  if (period === "5min" || period === "1H") {
    return [
      { period: "1D", timeframe: "1Min", intraday: "extended_hours" },
      { period: "1D", timeframe: "1Min", intraday: "market_hours" },
      { period: "1D", timeframe: "1Min", intraday: "continuous" },
    ];
  }

  if (period === "6H") {
    return [
      { period: "1D", timeframe: "5Min", intraday: "extended_hours" },
      { period: "1D", timeframe: "5Min", intraday: "market_hours" },
      { period: "1D", timeframe: "5Min", intraday: "continuous" },
      { period: "1D", timeframe: "15Min", intraday: "continuous" },
    ];
  }

  if (period === "1D") {
    return [
      { period: "1D", timeframe: "15Min", intraday: "extended_hours" },
      { period: "1D", timeframe: "15Min", intraday: "market_hours" },
      { period: "1D", timeframe: "15Min", intraday: "continuous" },
      { period: "2D", timeframe: "15Min", intraday: "continuous" },
    ];
  }

  if (period === "7D") return [{ period: "7D", timeframe: "15Min", intraday: "continuous" }];
  return [{ period: "30D", timeframe: "1D", intraday: "continuous" }];
}

function isOrderExecutionLog(log: LogEntry): boolean {
  const isBuyExecution = /(^|_)buy_executed$/i.test(log.action);
  const isSellExecution = /(^|_)sell_executed$/i.test(log.action);

  if (isBuyExecution) return true;
  if (isSellExecution) return log.agent === "PolicyBroker";
  return false;
}

function getLogNotificationKey(log: LogEntry): string {
  return `${log.timestamp}|${log.agent}|${log.action}|${log.symbol || ""}`;
}

function buildOrderNotification(log: LogEntry): { title: string; body: string } {
  const side = /sell_executed$/i.test(log.action) ? "SELL" : "BUY";
  const symbol = log.symbol || "UNKNOWN";
  const parts = [`${symbol} order executed`, `Source: ${log.agent}`];
  const reason = typeof log.reason === "string" && log.reason.trim() ? log.reason.trim() : null;

  if (reason) {
    parts.push(reason);
  }

  return {
    title: `${side} Executed`,
    body: parts.join("\n"),
  };
}

function getActivityLogKey(log: LogEntry): string {
  return `${log.timestamp}|${log.agent}|${log.action}|${String(log.symbol ?? "")}`;
}

async function fetchPortfolioHistory(
  connection: ConnectionSettings,
  period: PortfolioPeriod = "1D"
): Promise<PortfolioSnapshot[]> {
  let bestHistory: PortfolioSnapshot[] = [];
  let bestSpanMs = -1;

  for (const query of getPortfolioHistoryQueries(period)) {
    const intraday = query.intraday ? `&intraday_reporting=${query.intraday}` : "";
    const response = await requestAgent<AgentEnvelope<{ snapshots?: PortfolioSnapshot[] }>>(
      `/history?period=${query.period}&timeframe=${query.timeframe}${intraday}`,
      { connection }
    );

    if (response.ok && response.data?.ok && response.data.data?.snapshots) {
      const history = response.data.data.snapshots;
      const spanMs = history.length > 1 ? history[history.length - 1]!.timestamp - history[0]!.timestamp : 0;

      const shouldReplace = spanMs > bestSpanMs || (spanMs === bestSpanMs && history.length > bestHistory.length);

      if (shouldReplace) {
        bestHistory = history;
        bestSpanMs = spanMs;
      }
    }
  }

  return bestHistory;
}

async function fetchBestApyHistory(connection: ConnectionSettings): Promise<PortfolioSnapshot[]> {
  for (const period of APY_PERIOD_FALLBACKS) {
    const history = await fetchPortfolioHistory(connection, period);
    if (history.length > 1) {
      return history;
    }
  }

  return [];
}

function getPositionTimelineQuery(period: PortfolioPeriod): { period: string; timeframe: string } {
  if (period === "5min") return { period: "5Min", timeframe: "1Min" };
  if (period === "1H") return { period: "1H", timeframe: "1Min" };
  if (period === "6H") return { period: "6H", timeframe: "5Min" };
  if (period === "1D") return { period: "1D", timeframe: "15Min" };
  if (period === "7D") return { period: "7D", timeframe: "1Hour" };
  return { period: "30D", timeframe: "1Day" };
}

async function fetchPositionTimelineHistory(
  connection: ConnectionSettings,
  period: PortfolioPeriod
): Promise<Record<string, PositionTimelineHistory>> {
  const query = getPositionTimelineQuery(period);
  const response = await requestAgent<AgentEnvelope<{ histories?: Record<string, PositionTimelineHistory> }>>(
    `/position-history?period=${query.period}&timeframe=${query.timeframe}`,
    { connection }
  );

  if (response.ok && response.data?.ok && response.data.data?.histories) {
    return response.data.data.histories;
  }

  return {};
}

function normalizePortfolioSnapshots(
  snapshots: PortfolioSnapshot[],
  currentEquity: number | undefined,
  startingEquity: number,
  nowTimestamp: number
): PortfolioSnapshot[] {
  const deduped = Array.from(
    new Map(
      snapshots
        .filter((snapshot) => Number.isFinite(snapshot.timestamp) && Number.isFinite(snapshot.equity))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((snapshot) => [snapshot.timestamp, snapshot] as const)
    ).values()
  );

  if (deduped.length === 0 || !Number.isFinite(currentEquity) || !currentEquity || currentEquity <= 0) {
    return deduped;
  }

  const currentPl = currentEquity - startingEquity;
  const currentPlPct = startingEquity > 0 ? currentPl / startingEquity : 0;
  const currentSnapshot: PortfolioSnapshot = {
    timestamp: nowTimestamp,
    equity: currentEquity,
    pl: currentPl,
    pl_pct: currentPlPct,
  };

  const next = [...deduped];
  const last = next[next.length - 1];
  if (!last) return [currentSnapshot];

  if (nowTimestamp - last.timestamp > 5 * 60 * 1000) {
    next.push(currentSnapshot);
    return next;
  }

  next[next.length - 1] = currentSnapshot;
  return next;
}

function calculateRollingApy(history: PortfolioSnapshot[]): number | null {
  const positiveHistory = history.filter((snapshot) => snapshot.equity > 0);
  if (positiveHistory.length < 2) return null;

  const firstSnapshot = positiveHistory[0];
  const latestSnapshot = positiveHistory[positiveHistory.length - 1];
  const elapsedDays = (latestSnapshot.timestamp - firstSnapshot.timestamp) / 86400000;
  if (elapsedDays < 14) return null;

  const growthRatio = latestSnapshot.equity / firstSnapshot.equity;
  if (!Number.isFinite(growthRatio) || growthRatio <= 0) return null;

  const annualizedReturn = growthRatio ** (365 / elapsedDays) - 1;
  if (!Number.isFinite(annualizedReturn)) return null;

  return Math.max(annualizedReturn * 100, -99.9);
}

function sliceTimelinePoints(
  points: PositionTimelinePoint[],
  startTimestamp: number,
  endTimestamp: number
): PositionTimelinePoint[] {
  const sorted = [...points]
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.change_pct))
    .sort((a, b) => a.timestamp - b.timestamp);

  const inRange = sorted.filter((point) => point.timestamp >= startTimestamp && point.timestamp <= endTimestamp);
  const previousPoint = [...sorted].reverse().find((point) => point.timestamp < startTimestamp);

  if (previousPoint) {
    inRange.unshift({
      ...previousPoint,
      timestamp: startTimestamp,
    });
  }

  return inRange.filter((point, index, items) => index === 0 || items[index - 1]!.timestamp !== point.timestamp);
}

function getTimelineDomain(
  histories: Record<string, PositionTimelineHistory>,
  symbols: string[],
  startTimestamp: number,
  endTimestamp: number
): { start: number; end: number } {
  const visiblePoints = symbols.slice(0, 5).flatMap((position) => {
    const history = histories[position];
    if (!history) return [];
    return sliceTimelinePoints(history.points, startTimestamp, endTimestamp);
  });

  if (visiblePoints.length < 2) {
    return { start: startTimestamp, end: endTimestamp };
  }

  const minVisibleTimestamp = Math.min(...visiblePoints.map((point) => point.timestamp));
  const maxVisibleTimestamp = Math.max(...visiblePoints.map((point) => point.timestamp));
  return {
    start: Math.min(startTimestamp, minVisibleTimestamp),
    end: Math.min(endTimestamp, Math.max(maxVisibleTimestamp, startTimestamp + 60_000)),
  };
}

function buildNumericSeriesSignature(values: number[]): string {
  return `${values.length}:${values.map((value) => (Number.isFinite(value) ? value.toFixed(2) : "x")).join("|")}`;
}

function buildTimelineSeriesSignature(
  series: Array<{
    label: string;
    points: Array<{ timestamp: number; value: number }>;
  }>
): string {
  return series
    .map((item) => {
      const pointSignature = item.points.map((point) => `${point.timestamp}:${point.value.toFixed(3)}`).join("|");
      return `${item.label}:${pointSignature}`;
    })
    .join("~");
}

function useChangeToken(signature: string): number {
  const previousSignatureRef = useRef<string | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (previousSignatureRef.current !== null && previousSignatureRef.current !== signature) {
      setToken((current) => current + 1);
    }
    previousSignatureRef.current = signature;
  }, [signature]);

  return token;
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getLogDetailEntries(log: LogEntry): Array<{ key: string; value: string }> {
  const hiddenKeys = new Set(["timestamp", "agent", "action", "symbol"]);
  return Object.entries(log)
    .filter(([key, value]) => !hiddenKeys.has(key) && value !== undefined)
    .map(([key, value]) => ({
      key,
      value: formatDetailValue(value),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function hashSymbol(symbol: string): number {
  return symbol.split("").reduce((accumulator, char, index) => accumulator + char.charCodeAt(0) * (index + 1), 0);
}

function estimateEntryPrice(position: Position, storedEntryPrice?: number): number {
  if (typeof storedEntryPrice === "number" && Number.isFinite(storedEntryPrice) && storedEntryPrice > 0) {
    return storedEntryPrice;
  }

  if (
    typeof position.avg_entry_price === "number" &&
    Number.isFinite(position.avg_entry_price) &&
    position.avg_entry_price > 0
  ) {
    return position.avg_entry_price;
  }

  if (
    typeof position.cost_basis === "number" &&
    Number.isFinite(position.cost_basis) &&
    position.cost_basis > 0 &&
    position.qty > 0
  ) {
    const derivedFromCostBasis = position.cost_basis / position.qty;
    if (Number.isFinite(derivedFromCostBasis) && derivedFromCostBasis > 0) {
      return derivedFromCostBasis;
    }
  }

  if (position.qty > 0) {
    const estimatedCostBasis = position.market_value - position.unrealized_pl;
    const derivedEntryPrice = estimatedCostBasis / position.qty;
    if (Number.isFinite(derivedEntryPrice) && derivedEntryPrice > 0) {
      return derivedEntryPrice;
    }
  }

  return position.current_price;
}

function generatePositionPriceHistory(position: Position, storedEntryPrice?: number, points: number = 20): number[] {
  const startPrice = estimateEntryPrice(position, storedEntryPrice);
  const finalChangePct =
    typeof position.unrealized_plpc === "number" && Number.isFinite(position.unrealized_plpc)
      ? position.unrealized_plpc * 100
      : startPrice > 0
        ? position.side === "short"
          ? ((startPrice - position.current_price) / startPrice) * 100
          : ((position.current_price - startPrice) / startPrice) * 100
        : 0;
  const drift = finalChangePct;
  const symbolSeed = hashSymbol(position.symbol);
  const phase = (symbolSeed % 360) * (Math.PI / 180);
  const amplitude = Math.max(Math.abs(drift) * 0.1, 0.18);

  const trendSeries = Array.from({ length: points }, (_, index) => {
    const progress = index / Math.max(points - 1, 1);
    const baseLine = drift * progress;
    const primaryWave = Math.sin(progress * Math.PI * 1.1 + phase) * amplitude * 0.45;
    const secondaryWave = Math.sin(progress * Math.PI * 2.4 + phase * 0.6) * amplitude * 0.12;
    const directionalBias = drift === 0 ? 0 : Math.sign(drift) * amplitude * 0.08 * progress;
    return baseLine + primaryWave + secondaryWave + directionalBias;
  });

  trendSeries[0] = 0;
  trendSeries[trendSeries.length - 1] = finalChangePct;
  return trendSeries;
}

function buildSparklineFromTimeline(
  timelineHistory: PositionTimelineHistory | undefined,
  points: number = 20
): number[] | null {
  if (!timelineHistory || timelineHistory.points.length < 2) return null;

  const source = [...timelineHistory.points]
    .filter((point) => Number.isFinite(point.change_pct))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (source.length < 2) return null;
  if (source.length <= points) return source.map((point) => point.change_pct);

  return Array.from({ length: points }, (_, index) => {
    const sampleIndex = Math.round((index / Math.max(points - 1, 1)) * (source.length - 1));
    return source[sampleIndex]!.change_pct;
  });
}

export default function App() {
  const nativeShell = isNativeShell();
  const desktopPanel = isDesktopPanel();
  const desktopShell = !nativeShell;
  const appUpdateShell = desktopPanel || nativeShell;
  const viewportLockedShell = nativeShell || desktopPanel;
  const [connection, setConnection] = useState<ConnectionSettings>({ apiUrl: "", bearerToken: "" });
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [busyAction, setBusyAction] = useState<"enable" | "disable" | "trigger" | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateEvent | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [selectedResearchSymbol, setSelectedResearchSymbol] = useState<string | null>(null);
  const [selectedPositionSymbol, setSelectedPositionSymbol] = useState<string | null>(null);
  const [selectedActivityLog, setSelectedActivityLog] = useState<LogEntry | null>(null);
  const [time, setTime] = useState(new Date());
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioSnapshot[]>([]);
  const [apyHistory, setApyHistory] = useState<PortfolioSnapshot[]>([]);
  const [portfolioPeriod, setPortfolioPeriod] = useState<PortfolioPeriod>("1D");
  const [positionTimelinePeriod, setPositionTimelinePeriod] = useState<PortfolioPeriod>("7D");
  const [positionTimelineHistory, setPositionTimelineHistory] = useState<Record<string, PositionTimelineHistory>>({});
  const [showRemoteLinkDetails, setShowRemoteLinkDetails] = useState(false);
  const [showPortfolioDetails, setShowPortfolioDetails] = useState(false);
  const [isWindowVisible, setIsWindowVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [resumeSyncToken, setResumeSyncToken] = useState(0);
  const [showStartupSequence, setShowStartupSequence] = useState(() => desktopPanel);
  const seenOrderNotificationKeysRef = useRef<Set<string>>(new Set());
  const orderNotificationsPrimedRef = useRef(false);
  const seenActivityFeedKeysRef = useRef<Set<string>>(new Set());
  const [newActivityFeedKeys, setNewActivityFeedKeys] = useState<Set<string>>(new Set());
  const lastResumeRefreshAtRef = useRef(0);
  const statusRequestInFlightRef = useRef(false);
  const portfolioHistoryInFlightRef = useRef(false);
  const apyHistoryInFlightRef = useRef(false);
  const positionTimelineInFlightRef = useRef(false);
  const remoteLinkExpanded = nativeShell ? showRemoteLinkDetails : true;
  const portfolioDetailsExpanded = nativeShell ? showPortfolioDetails : true;
  const periodButtonClass = nativeShell
    ? "flex min-h-10 items-center rounded-lg border px-3 transition-colors"
    : desktopPanel
      ? "hud-control-chip flex min-h-7 items-center rounded-[3px] border px-2.5 text-[11px] font-medium transition-colors"
      : "flex min-h-8 items-center rounded-md border px-2.5 text-[11px] transition-colors";
  const remoteLinkActionClass = nativeShell
    ? "hud-button"
    : desktopPanel
      ? "hud-button hud-toolbar-button h-7 min-h-0 rounded-[3px] px-3 py-1 text-[10px] tracking-[0.12em]"
      : "hud-button h-8 min-h-0 rounded-lg px-3 py-1.5 text-[10px] tracking-[0.1em]";

  useEffect(() => {
    const bootstrapConnection = async () => {
      const savedConnection = await loadConnectionSettings();
      setConnection(savedConnection);
      setShowSetup(!savedConnection.apiUrl || !savedConnection.bearerToken);
      setConnectionLoaded(true);
    };

    bootstrapConnection();
  }, []);

  useEffect(() => {
    if (!appUpdateShell) return;

    let cancelled = false;
    void getDesktopAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });

    const unsubscribe = subscribeDesktopUpdate((event) => {
      setUpdateStatus(event);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [appUpdateShell]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("native-shell", nativeShell);
    root.classList.toggle("desktop-panel", desktopPanel);

    return () => {
      root.classList.remove("native-shell");
      root.classList.remove("desktop-panel");
    };
  }, [desktopPanel, nativeShell]);

  useEffect(() => {
    if (!desktopPanel) return;

    const timer = window.setTimeout(() => {
      setShowStartupSequence(false);
    }, 1700);

    return () => window.clearTimeout(timer);
  }, [desktopPanel]);

  useEffect(() => {
    const requestResumeRefresh = () => {
      const now = Date.now();
      if (now - lastResumeRefreshAtRef.current < RESUME_REFRESH_THROTTLE_MS) return;
      lastResumeRefreshAtRef.current = now;
      setResumeSyncToken((current) => current + 1);
    };

    const handleVisibilityChange = () => {
      setIsWindowVisible(!document.hidden);
      if (!document.hidden) {
        requestResumeRefresh();
      }
    };

    const handleWindowFocus = () => {
      setIsWindowVisible(true);
      requestResumeRefresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    const unsubscribeDesktopLifecycle = subscribeDesktopLifecycle(() => {
      requestResumeRefresh();
    });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      unsubscribeDesktopLifecycle?.();
    };
  }, []);

  useEffect(() => {
    void resumeSyncToken;
    const fetchStatus = async () => {
      if (statusRequestInFlightRef.current) return;
      statusRequestInFlightRef.current = true;
      try {
        const response = await requestAgent<AgentEnvelope<Status>>("/status", { connection });
        if (response.ok && response.data?.ok && response.data.data) {
          setStatus(response.data.data);
          setError(null);
          setLastSyncAt(Date.now());
        } else {
          setError(getResponseError(response.data, "Failed to fetch status"));
        }
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : "Connection failed - is the agent running?");
      } finally {
        statusRequestInFlightRef.current = false;
      }
    };

    if (connectionLoaded && connection.apiUrl && connection.bearerToken && !showSetup) {
      fetchStatus();
      const interval = setInterval(fetchStatus, isWindowVisible ? ACTIVE_STATUS_POLL_MS : HIDDEN_STATUS_POLL_MS);
      const timeInterval = setInterval(
        () => setTime(new Date()),
        isWindowVisible ? ACTIVE_CLOCK_TICK_MS : HIDDEN_CLOCK_TICK_MS
      );

      return () => {
        clearInterval(interval);
        clearInterval(timeInterval);
      };
    }
  }, [connection, connectionLoaded, isWindowVisible, showSetup, resumeSyncToken]);

  useEffect(() => {
    void resumeSyncToken;
    if (!connectionLoaded || !connection.apiUrl || !connection.bearerToken || showSetup) return;
    if (!isWindowVisible) return;

    const loadPortfolioHistory = async () => {
      if (portfolioHistoryInFlightRef.current) return;
      portfolioHistoryInFlightRef.current = true;
      try {
        const history = await fetchPortfolioHistory(connection, portfolioPeriod);
        if (history.length > 0) {
          setPortfolioHistory(history);
        }
      } catch {
        // Keep the latest successful history rendered.
      } finally {
        portfolioHistoryInFlightRef.current = false;
      }
    };

    loadPortfolioHistory();
    const historyInterval = setInterval(loadPortfolioHistory, 60000);
    return () => clearInterval(historyInterval);
  }, [connection, connectionLoaded, isWindowVisible, showSetup, portfolioPeriod, resumeSyncToken]);

  useEffect(() => {
    void resumeSyncToken;
    if (!connectionLoaded || !connection.apiUrl || !connection.bearerToken || showSetup) return;
    if (!isWindowVisible) return;

    const loadApyHistory = async () => {
      if (apyHistoryInFlightRef.current) return;
      apyHistoryInFlightRef.current = true;
      try {
        const history = await fetchBestApyHistory(connection);
        if (history.length > 1) {
          setApyHistory(history);
        }
      } catch {
        // Keep the latest successful APY history rendered.
      } finally {
        apyHistoryInFlightRef.current = false;
      }
    };

    loadApyHistory();
    const apyInterval = setInterval(loadApyHistory, 300000);
    return () => clearInterval(apyInterval);
  }, [connection, connectionLoaded, isWindowVisible, showSetup, resumeSyncToken]);

  useEffect(() => {
    void resumeSyncToken;
    if (!connectionLoaded || !connection.apiUrl || !connection.bearerToken || showSetup) return;
    if (!isWindowVisible) return;

    const loadPositionTimelineHistory = async () => {
      if (positionTimelineInFlightRef.current) return;
      positionTimelineInFlightRef.current = true;
      try {
        const history = await fetchPositionTimelineHistory(connection, positionTimelinePeriod);
        setPositionTimelineHistory(history);
      } catch {
        // Keep the latest successful timeline rendered.
      } finally {
        positionTimelineInFlightRef.current = false;
      }
    };

    loadPositionTimelineHistory();
    const interval = setInterval(loadPositionTimelineHistory, 60000);
    return () => clearInterval(interval);
  }, [connection, connectionLoaded, isWindowVisible, positionTimelinePeriod, showSetup, resumeSyncToken]);

  const handleSaveConfig = async (config: Config) => {
    const response = await requestAgent<AgentEnvelope<Config>>("/config", {
      method: "POST",
      body: config,
      connection,
    });

    if (response.ok && status) {
      setStatus({
        ...status,
        config: response.data?.data || response.data?.config || status.config,
      });
      setError(null);
      return;
    }

    throw new Error(getResponseError(response.data, "Failed to save configuration"));
  };

  const handleSaveConnection = async (nextConnection: ConnectionSettings) => {
    const candidateConnection = {
      apiUrl: normalizeApiUrl(nextConnection.apiUrl),
      bearerToken: nextConnection.bearerToken.trim(),
    };

    const response = await requestAgent<AgentEnvelope<Status>>("/status", { connection: candidateConnection });
    if (!response.ok || !response.data?.ok || !response.data.data) {
      throw new Error(getResponseError(response.data, "Unable to reach MAHORAGA with the provided credentials"));
    }

    const savedConnection = await saveConnectionSettings(candidateConnection);
    setConnection(savedConnection);
    setError(null);
    setShowSetup(false);
    setStatus(response.data.data);
    setLastSyncAt(Date.now());
  };

  const handleAgentAction = async (action: "enable" | "disable" | "trigger") => {
    setBusyAction(action);

    try {
      const response = await requestAgent<AgentEnvelope<Status | { enabled?: boolean }>>(`/${action}`, {
        method: "POST",
        connection,
      });

      if (!response.ok) {
        throw new Error(getResponseError(response.data, `Failed to ${action} agent`));
      }

      const refreshedStatus = await requestAgent<AgentEnvelope<Status>>("/status", { connection });
      if (refreshedStatus.ok && refreshedStatus.data?.ok && refreshedStatus.data.data) {
        setStatus(refreshedStatus.data.data);
        setLastSyncAt(Date.now());
        setError(null);
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Failed to ${action} agent`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCheckUpdate = async () => {
    setUpdateBusy(true);
    try {
      const result = await checkDesktopUpdate(false);
      if (result) setUpdateStatus(result);
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleInstallUpdate = async () => {
    setUpdateBusy(true);
    try {
      const result = await installDesktopUpdate();
      if (result) setUpdateStatus(result);
    } finally {
      setUpdateBusy(false);
    }
  };

  // Derived state (must stay above early returns per React hooks rules)
  const account = status?.account;
  const positions = status?.positions || [];
  const signals = status?.signals || [];
  const logs = status?.logs || [];
  const config = status?.config;
  const isMarketOpen = status?.clock?.is_open ?? false;
  const isAgentEnabled = status?.enabled ?? false;
  const nextOpenMs = status?.clock?.next_open ? new Date(status.clock.next_open).getTime() : null;

  const startingEquity = config?.starting_equity || 100000;
  const unrealizedPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const totalPl = account ? account.equity - startingEquity : 0;
  const realizedPl = totalPl - unrealizedPl;
  const totalPlPct = account ? (totalPl / startingEquity) * 100 : 0;
  const syncTimeLabel = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString("en-US", { hour12: false }) : "PENDING";
  const updateAvailable =
    updateStatus?.state === "available" ||
    updateStatus?.state === "downloaded" ||
    updateStatus?.state === "downloading" ||
    updateStatus?.state === "installing";
  const updateProgressLabel =
    updateStatus?.state === "downloading" && typeof updateStatus.progress === "number"
      ? `${updateStatus.progress}%`
      : null;
  const updateStateLabel = updateStatus
    ? updateStatus.state === "available"
      ? `v${updateStatus.update?.version || updateStatus.latestVersion || "NEW"}`
      : updateStatus.state === "not-available"
        ? "CURRENT"
        : updateStatus.state === "downloading"
          ? updateProgressLabel || "DOWNLOADING"
          : updateStatus.state === "downloaded"
            ? "READY"
            : updateStatus.state === "installing"
              ? "INSTALLING"
              : updateStatus.state === "error"
                ? "ERROR"
                : "CHECKING"
    : appVersion
      ? `v${appVersion}`
      : "UNKNOWN";
  const totalPlStateLabel = totalPl >= 0 ? "Ahead Of Baseline" : "Below Baseline";
  const headerStatusItems: Array<{
    label: string;
    value: string;
    status?: "active" | "warning" | "error" | "inactive";
  }> = [
    {
      label: "AGENT",
      value: isAgentEnabled ? "ONLINE" : "OFFLINE",
      status: isAgentEnabled ? "active" : "inactive",
    },
    {
      label: "POSITIONS",
      value: `${positions.length}/${config?.max_positions || 5}`,
    },
    {
      label: "SYNC",
      value: syncTimeLabel,
      status: error ? "warning" : "active",
    },
  ];

  // Color palette for position lines (distinct colors for each stock)
  const positionColors = ["cyan", "purple", "yellow", "blue", "green"] as const;
  const nowTimestamp = time.getTime();
  const timeUntilNextOpenMs =
    !isMarketOpen && nextOpenMs && nextOpenMs > nowTimestamp ? nextOpenMs - nowTimestamp : null;
  const autoOpenCountdownSeconds =
    timeUntilNextOpenMs !== null && timeUntilNextOpenMs > 0 && timeUntilNextOpenMs <= 5000
      ? Math.ceil(timeUntilNextOpenMs / 1000)
      : null;
  const activeOpenCountdownSeconds = autoOpenCountdownSeconds;

  const normalizedPortfolioHistory = useMemo(() => {
    return normalizePortfolioSnapshots(portfolioHistory, account?.equity, startingEquity, nowTimestamp);
  }, [account?.equity, nowTimestamp, portfolioHistory, startingEquity]);

  const visiblePortfolioHistory = useMemo(() => {
    const periodStart = getPeriodStartTimestamp(portfolioPeriod, nowTimestamp);
    return normalizedPortfolioHistory.filter((snapshot) => snapshot.timestamp >= periodStart);
  }, [normalizedPortfolioHistory, nowTimestamp, portfolioPeriod]);

  const rollingApy = useMemo(() => {
    const source = apyHistory.length > 1 ? apyHistory : normalizedPortfolioHistory;
    return calculateRollingApy(source);
  }, [apyHistory, normalizedPortfolioHistory]);

  // Generate mock price histories for positions (stable per session via useMemo)
  const positionPriceHistories = useMemo(() => {
    const histories: Record<string, number[]> = {};
    positions.forEach((pos) => {
      const timelineHistory = positionTimelineHistory[pos.symbol];
      histories[pos.symbol] =
        buildSparklineFromTimeline(timelineHistory) ??
        generatePositionPriceHistory(pos, status?.positionEntries?.[pos.symbol]?.entry_price);
    });
    return histories;
  }, [positionTimelineHistory, positions, status?.positionEntries]);

  // Chart data derived from portfolio history
  const portfolioChartData = useMemo(() => {
    return visiblePortfolioHistory.map((s) => s.equity);
  }, [visiblePortfolioHistory]);

  const visibleSignals = useMemo(() => signals.slice(0, 20), [signals]);
  const visibleLogs = useMemo(() => logs.slice(-50).reverse(), [logs]);
  const entryDiagnostic = useMemo(
    () => buildEntryDiagnostic(logs, signals, positions, config, isMarketOpen, nowTimestamp, status?.runtimeSummary),
    [config, isMarketOpen, logs, nowTimestamp, positions, signals, status?.runtimeSummary]
  );
  const signalResearchEntries = useMemo(
    () =>
      Object.entries(status?.signalResearch || {})
        .sort(([, a], [, b]) => b.timestamp - a.timestamp)
        .slice(0, 12),
    [status?.signalResearch]
  );
  const signalResearchTotal = Object.keys(status?.signalResearch || {}).length;
  const adaptivePerformance = status?.adaptivePerformance;
  const adaptiveBlockRows = useMemo(() => {
    const symbols = adaptivePerformance?.symbols ?? [];
    const features = adaptivePerformance?.features ?? [];
    return [
      ...symbols.map((block) => ({ ...block, type: "SYMBOL" })),
      ...features.map((block) => ({ ...block, type: "FEATURE" })),
    ].slice(0, 6);
  }, [adaptivePerformance]);
  const positionTimelineReferenceTimestamp = useMemo(() => {
    const timestamps = Object.values(positionTimelineHistory)
      .flatMap((history) => history.points.map((point) => point.timestamp))
      .filter((timestamp) => Number.isFinite(timestamp));

    return timestamps.length > 0 ? Math.max(...timestamps) : nowTimestamp;
  }, [nowTimestamp, positionTimelineHistory]);

  const positionTimelineSymbols = useMemo(() => {
    return Object.values(positionTimelineHistory)
      .sort((a, b) => {
        const aOpen = a.status !== "SOLD";
        const bOpen = b.status !== "SOLD";
        if (aOpen !== bOpen) return aOpen ? -1 : 1;
        const aLast = a.exit_time ?? a.points[a.points.length - 1]?.timestamp ?? 0;
        const bLast = b.exit_time ?? b.points[b.points.length - 1]?.timestamp ?? 0;
        return bLast - aLast;
      })
      .map((history) => history.symbol);
  }, [positionTimelineHistory]);

  const portfolioChartLabels = useMemo(() => {
    return visiblePortfolioHistory.map((s) => {
      if (
        portfolioPeriod === "5min" ||
        portfolioPeriod === "1H" ||
        portfolioPeriod === "6H" ||
        portfolioPeriod === "1D"
      ) {
        return marketTimeFormatter.format(new Date(s.timestamp));
      }
      if (portfolioPeriod === "7D") {
        return marketWeekdayFormatter.format(new Date(s.timestamp));
      }
      return marketMonthDayFormatter.format(new Date(s.timestamp));
    });
  }, [portfolioPeriod, visiblePortfolioHistory]);

  useEffect(() => {
    if (!orderNotificationsPrimedRef.current) {
      if (!status) return;
      rememberBoundedKeys(
        seenOrderNotificationKeysRef.current,
        logs.filter(isOrderExecutionLog).map((log) => getLogNotificationKey(log)),
        ORDER_NOTIFICATION_KEY_CAP
      );
      orderNotificationsPrimedRef.current = true;
      return;
    }

    const executedOrderLogs = logs.filter(isOrderExecutionLog);
    if (executedOrderLogs.length === 0) return;

    const newExecutedOrders = executedOrderLogs
      .filter((log) => !seenOrderNotificationKeysRef.current.has(getLogNotificationKey(log)))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (newExecutedOrders.length === 0) return;

    newExecutedOrders.forEach((log) => {
      rememberBoundedKey(seenOrderNotificationKeysRef.current, getLogNotificationKey(log), ORDER_NOTIFICATION_KEY_CAP);
      const notification = buildOrderNotification(log);
      void showDesktopNotification(notification.title, notification.body);
    });
  }, [logs, status]);

  useEffect(() => {
    const visibleKeys = visibleLogs.map(getActivityLogKey);

    if (seenActivityFeedKeysRef.current.size === 0) {
      rememberBoundedKeys(seenActivityFeedKeysRef.current, visibleKeys, ACTIVITY_FEED_KEY_CAP);
      return;
    }

    const freshKeys = visibleKeys.filter((key) => !seenActivityFeedKeysRef.current.has(key));
    if (freshKeys.length === 0) return;

    rememberBoundedKeys(seenActivityFeedKeysRef.current, freshKeys, ACTIVITY_FEED_KEY_CAP);
    setNewActivityFeedKeys(new Set(freshKeys));

    const timeoutId = window.setTimeout(() => {
      setNewActivityFeedKeys(new Set());
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [visibleLogs]);

  useEffect(() => {
    let frameId: number | null = null;

    const applyMouseGlowPosition = (clientX: number, clientY: number) => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        document.documentElement.style.setProperty("--mouse-glow-x", `${clientX}px`);
        document.documentElement.style.setProperty("--mouse-glow-y", `${clientY}px`);
        document.documentElement.style.setProperty("--mouse-glow-opacity", "1");
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      applyMouseGlowPosition(event.clientX, event.clientY);
    };

    const handlePointerLeave = () => {
      document.documentElement.style.setProperty("--mouse-glow-opacity", "0");
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  const { marketMarkers, marketHoursZone } = useMemo(() => {
    if (portfolioPeriod === "7D" || portfolioPeriod === "30D" || visiblePortfolioHistory.length === 0) {
      return { marketMarkers: undefined, marketHoursZone: undefined };
    }

    const markers: { index: number; label: string; color?: string }[] = [];
    let openIndex = -1;
    let closeIndex = -1;

    visiblePortfolioHistory.forEach((s, i) => {
      const { hour, minute } = getMarketHourMinuteParts(s.timestamp);

      if (hour === 9 && minute >= 30 && minute < 45 && openIndex === -1) {
        openIndex = i;
        markers.push({ index: i, label: "OPEN", color: "var(--color-hud-success)" });
      } else if (hour === 16 && minute === 0 && closeIndex === -1) {
        closeIndex = i;
        markers.push({ index: i, label: "CLOSE", color: "var(--color-hud-error)" });
      }
    });

    const zone = openIndex >= 0 && closeIndex >= 0 ? { openIndex, closeIndex } : undefined;

    return {
      marketMarkers: markers.length > 0 ? markers : undefined,
      marketHoursZone: zone,
    };
  }, [portfolioPeriod, visiblePortfolioHistory]);

  const positionTimelineDomain = useMemo(() => {
    const periodStart = getPeriodStartTimestamp(positionTimelinePeriod, positionTimelineReferenceTimestamp);
    return getTimelineDomain(
      positionTimelineHistory,
      positionTimelineSymbols,
      periodStart,
      positionTimelineReferenceTimestamp
    );
  }, [positionTimelineHistory, positionTimelinePeriod, positionTimelineReferenceTimestamp, positionTimelineSymbols]);

  const positionTimelineSeries = useMemo(() => {
    return positionTimelineSymbols
      .slice(0, 5)
      .map((symbol, idx) => {
        const history = positionTimelineHistory[symbol];
        if (!history || history.points.length < 2) {
          return null;
        }
        const visiblePoints = sliceTimelinePoints(
          history.points,
          positionTimelineDomain.start,
          positionTimelineDomain.end
        );
        if (visiblePoints.length < 2) {
          return null;
        }
        const currentReturn = visiblePoints[visiblePoints.length - 1]?.change_pct ?? 0;
        const isSold = history.status === "SOLD";
        const endTimestamp =
          history.exit_time ?? visiblePoints[visiblePoints.length - 1]?.timestamp ?? history.entry_time;

        return {
          label: symbol,
          variant: positionColors[idx % positionColors.length],
          currentReturn,
          entryTime: history.entry_time,
          endTime: endTimestamp,
          status: isSold ? ("SOLD" as const) : ("OPEN" as const),
          points: visiblePoints.map((point, pointIndex) => ({
            timestamp: point.timestamp,
            value: point.change_pct,
            label:
              pointIndex === 0 &&
              history.entry_time >= positionTimelineDomain.start &&
              Math.abs(point.timestamp - history.entry_time) < 60000
                ? "BUY"
                : pointIndex === visiblePoints.length - 1
                  ? isSold
                    ? "SOLD"
                    : "NOW"
                  : undefined,
          })),
        };
      })
      .filter(Boolean) as Array<{
      label: string;
      variant: (typeof positionColors)[number];
      currentReturn: number;
      entryTime: number;
      endTime: number;
      status: "OPEN" | "SOLD";
      points: Array<{ timestamp: number; value: number; label?: string }>;
    }>;
  }, [
    positionTimelineDomain.end,
    positionTimelineDomain.start,
    positionTimelineHistory,
    positionColors,
    positionTimelineSymbols,
  ]);

  const positionTimelineLegend = useMemo(() => {
    return positionTimelineSeries.map((series) => ({
      ...series,
      holdDuration: formatHoldDuration(series.entryTime, series.status === "SOLD" ? series.endTime : nowTimestamp),
    }));
  }, [nowTimestamp, positionTimelineSeries]);

  const portfolioChartUpdateToken = useChangeToken(buildNumericSeriesSignature(portfolioChartData));
  const positionTimelineUpdateToken = useChangeToken(buildTimelineSeriesSignature(positionTimelineSeries));
  const signalListUpdateToken = useChangeToken(
    visibleSignals.map((sig) => `${sig.symbol}:${sig.source}:${sig.sentiment.toFixed(3)}:${sig.volume}`).join("|")
  );
  const selectedResearch = selectedResearchSymbol ? (status?.signalResearch?.[selectedResearchSymbol] ?? null) : null;
  const selectedResearchSentiment = getSafeSentiment(selectedResearch?.sentiment);
  const selectedPosition = selectedPositionSymbol
    ? (positions.find((position) => position.symbol === selectedPositionSymbol) ?? null)
    : null;
  const selectedPositionEntry = selectedPositionSymbol ? status?.positionEntries?.[selectedPositionSymbol] : null;
  const selectedPositionStaleness = selectedPositionSymbol ? status?.stalenessAnalysis?.[selectedPositionSymbol] : null;
  const selectedPositionStalenessScore =
    typeof selectedPositionStaleness?.score === "number" && Number.isFinite(selectedPositionStaleness.score)
      ? selectedPositionStaleness.score
      : null;
  const selectedPositionEntrySources = Array.isArray(selectedPositionEntry?.entry_sources)
    ? selectedPositionEntry.entry_sources.filter(
        (source): source is string => typeof source === "string" && source.length > 0
      )
    : [];
  const selectedPositionStalenessReasons = Array.isArray(selectedPositionStaleness?.reasons)
    ? selectedPositionStaleness.reasons.filter(
        (reason): reason is string => typeof reason === "string" && reason.length > 0
      )
    : [];
  const selectedPositionPlPct = selectedPosition
    ? (selectedPosition.unrealized_pl / (selectedPosition.market_value - selectedPosition.unrealized_pl)) * 100
    : null;
  const selectedPositionHoldHours = selectedPositionEntry
    ? Math.max(0, Math.floor((Date.now() - selectedPositionEntry.entry_time) / 3600000))
    : null;
  const selectedActivityLogDetails = selectedActivityLog ? getLogDetailEntries(selectedActivityLog) : [];
  const positionsPanel = (
    <Panel
      title="POSITIONS"
      titleRight={`${positions.length}/${config?.max_positions || 5}`}
      className={clsx(
        "overflow-hidden",
        desktopPanel
          ? "h-full min-h-0"
          : desktopShell
            ? "h-[340px] lg:h-[380px]"
            : "h-full min-h-[320px] lg:min-h-[360px]"
      )}
    >
      {positions.length === 0 ? (
        <div className="text-hud-text-dim text-sm py-8 text-center">No open positions</div>
      ) : (
        <div className="hud-scroll-pane hud-data-table-wrap h-full min-h-0 overflow-x-auto overflow-y-auto">
          <table className="hud-data-table w-full">
            <thead>
              <tr className="border-b border-hud-line/50">
                <th className="hud-label text-left py-2 px-2">Symbol</th>
                <th className="hud-label text-right py-2 px-2 hidden sm:table-cell">Qty</th>
                <th className="hud-label text-right py-2 px-2 hidden md:table-cell">Value</th>
                <th className="hud-label text-right py-2 px-2">P&L</th>
                <th className="hud-label text-center py-2 px-2">Trend</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos: Position) => {
                const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;
                const priceHistory = positionPriceHistories[pos.symbol] || [];

                return (
                  <motion.tr
                    key={pos.symbol}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="hud-data-row border-b border-hud-line/20"
                  >
                    <td className="hud-value-sm py-2 px-2">
                      <button
                        type="button"
                        onClick={() => setSelectedPositionSymbol(pos.symbol)}
                        className="cursor-pointer border-b border-dotted border-hud-text-dim hover:text-hud-primary transition-colors text-left"
                      >
                        {isCryptoSymbol(pos.symbol, config?.crypto_symbols) && (
                          <span className="text-hud-warning mr-1">₿</span>
                        )}
                        {isCryptoSymbol(pos.symbol, config?.crypto_symbols)
                          ? formatCryptoSymbol(pos.symbol, config?.crypto_symbols)
                          : pos.symbol}
                      </button>
                    </td>
                    <td className="hud-value-sm text-right py-2 px-2 hidden sm:table-cell">{pos.qty}</td>
                    <td className="hud-value-sm text-right py-2 px-2 hidden md:table-cell">
                      {formatCurrency(pos.market_value)}
                    </td>
                    <td
                      className={clsx(
                        "hud-value-sm text-right py-2 px-2",
                        pos.unrealized_pl >= 0 ? "text-hud-success" : "text-hud-error"
                      )}
                    >
                      <div>{formatCurrency(pos.unrealized_pl)}</div>
                      <div className="text-xs opacity-70">{formatPercent(plPct)}</div>
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex justify-center">
                        <Sparkline data={priceHistory} width={60} height={20} />
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );

  // Early returns (after all hooks)
  if (showStartupSequence) {
    return (
      <div className="hud-startup-screen">
        <div className="hud-startup-screen__grid" aria-hidden="true" />
        <motion.div
          initial={{ opacity: 0, scale: 0.985, filter: "blur(12px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
          className="hud-startup-shell"
        >
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="hud-startup-mark"
          >
            MAHORAGA SENTINEL
          </motion.div>
          <motion.div
            initial={{ opacity: 0, letterSpacing: "0.36em" }}
            animate={{ opacity: 1, letterSpacing: "0.22em" }}
            transition={{ duration: 0.4, delay: 0.16 }}
            className="hud-startup-subtitle"
          >
            Autonomous Tactical Console
          </motion.div>
          <div className="hud-startup-loader">
            <motion.div
              initial={{ scaleX: 0, opacity: 0.55 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={{ duration: 1.05, delay: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="hud-startup-loader__bar"
            />
          </div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: 0.36 }}
            className="hud-startup-meta"
          >
            <span>BOOTSTRAP</span>
            <span>SYNC</span>
            <span>READY</span>
          </motion.div>
        </motion.div>
      </div>
    );
  }

  if (!connectionLoaded) {
    return (
      <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
        <Panel title="BOOTING PANEL" className="max-w-md w-full">
          <div className="text-center py-10 space-y-3">
            <div className="text-hud-primary text-2xl">SYNC</div>
            <p className="text-hud-text-dim text-sm">Loading remote link profile...</p>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: 0.36 }}
            className="hud-startup-meta"
          >
            <span>BOOTSTRAP</span>
            <span>SYNC</span>
            <span>READY</span>
          </motion.div>
        </Panel>
      </div>
    );
  }

  if (showSetup) {
    return <SetupWizard initialConnection={connection} onComplete={handleSaveConnection} />;
  }

  if (error && !status) {
    return (
      <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
        <Panel title="CONNECTION ERROR" className="max-w-xl w-full">
          <div className="py-8 space-y-5">
            <div className="text-center">
              <div className="text-hud-error text-2xl mb-4">LINK LOST</div>
              <p className="text-hud-text-dim text-sm">{error}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-hud-line bg-hud-bg-panel p-4 space-y-2">
                <div className="hud-label text-hud-primary">Target</div>
                <div className="hud-value-sm break-all">{connection.apiUrl || "UNSET"}</div>
              </div>
              <div className="border border-hud-line bg-hud-bg-panel p-4 space-y-2">
                <div className="hud-label text-hud-primary">Bearer</div>
                <div className="hud-value-sm">{maskBearerToken(connection.bearerToken)}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 justify-center">
              <button type="button" className="hud-button" onClick={() => setShowSetup(true)}>
                Edit Connection
              </button>
              <button
                type="button"
                className="hud-button"
                onClick={() => {
                  void handleSaveConnection(connection).catch((retryError) => {
                    setError(retryError instanceof Error ? retryError.message : "Retry failed");
                  });
                }}
              >
                Retry Link
              </button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  if (!connectionLoaded) {
    return (
      <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
        <Panel title="BOOTING PANEL" className="max-w-md w-full">
          <div className="text-center py-10 space-y-3">
            <div className="text-hud-primary text-2xl">SYNC</div>
            <p className="text-hud-text-dim text-sm">Loading remote link profile...</p>
          </div>
        </Panel>
      </div>
    )
  }

  if (showSetup) {
    return <SetupWizard initialConnection={connection} onComplete={handleSaveConnection} />
  }

  if (error && !status) {
    return (
      <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
        <Panel title="CONNECTION ERROR" className="max-w-xl w-full">
          <div className="py-8 space-y-5">
            <div className="text-center">
              <div className="text-hud-error text-2xl mb-4">LINK LOST</div>
              <p className="text-hud-text-dim text-sm">{error}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-hud-line bg-hud-bg-panel p-4 space-y-2">
                <div className="hud-label text-hud-primary">Target</div>
                <div className="hud-value-sm break-all">{connection.apiUrl || 'UNSET'}</div>
              </div>
              <div className="border border-hud-line bg-hud-bg-panel p-4 space-y-2">
                <div className="hud-label text-hud-primary">Bearer</div>
                <div className="hud-value-sm">{maskBearerToken(connection.bearerToken)}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 justify-center">
              <button className="hud-button" onClick={() => setShowSetup(true)}>
                Edit Connection
              </button>
              <button
                className="hud-button"
                onClick={() => {
                  void handleSaveConnection(connection).catch((retryError) => {
                    setError(retryError instanceof Error ? retryError.message : 'Retry failed')
                  })
                }}
              >
                Retry Link
              </button>
            </div>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div
      className={clsx(
        "relative z-[1] min-h-screen overflow-x-hidden bg-hud-bg",
        viewportLockedShell && "h-[100dvh] overflow-hidden"
      )}
      style={viewportLockedShell ? { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" } : undefined}
    >
      {desktopPanel && <div className="hud-pointer-glow" aria-hidden="true" />}
      <div
        className={clsx(
          "mx-auto flex max-w-[1920px] flex-col gap-4 p-3 sm:p-4",
          viewportLockedShell && "h-full max-h-[100dvh] overflow-hidden",
          desktopPanel && "gap-3 px-4 py-3"
        )}
      >
        <div
          className={clsx(
            nativeShell
              ? "fixed inset-x-0 z-40 border-b border-hud-line bg-hud-bg/88 backdrop-blur-xl"
              : desktopPanel
                ? "hud-top-shell shrink-0 rounded-[4px] border border-hud-line/70 bg-hud-bg-panel/72 px-4 py-2.5 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl"
                : "shrink-0 border-b border-hud-line pb-3"
          )}
          style={nativeShell ? { top: 0 } : undefined}
        >
          <div
            className={clsx("max-w-[1920px] mx-auto", nativeShell ? "px-3 pb-2 pt-3 sm:px-4 sm:pb-3" : "")}
            style={nativeShell ? { paddingTop: "calc(env(safe-area-inset-top, 0px) + 10px)" } : undefined}
          >
            {nativeShell ? (
              <header className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="hud-wordmark">SENTINEL</span>
                </div>
                <span className="hud-value-sm font-mono text-hud-text">
                  {time.toLocaleTimeString("en-US", { hour12: false })}
                </span>
              </header>
            ) : (
              <header
                className={clsx(
                  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
                  desktopPanel && "gap-2"
                )}
              >
                <div className={clsx("flex items-center gap-4 md:gap-6", desktopPanel && "hud-title-rail")}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={clsx(
                        "text-xl tracking-tight text-hud-text-bright md:text-2xl",
                        desktopPanel ? "hud-title-mark font-semibold" : "font-light"
                      )}
                    >
                      MAHORAGA SENTINEL
                    </span>
                  </div>
                  <StatusIndicator
                    status={isMarketOpen ? "active" : "inactive"}
                    label={isMarketOpen ? "MARKET OPEN" : "MARKET CLOSED"}
                    pulse={isMarketOpen}
                  />
                </div>
                <div
                  className={clsx(
                    "flex flex-wrap items-center gap-3 md:gap-5",
                    desktopPanel && "gap-x-4 gap-y-2 md:gap-x-4"
                  )}
                >
                  <StatusBar items={headerStatusItems} />
                  <NotificationBell
                    compact
                    overnightActivity={status?.overnightActivity}
                    premarketPlan={status?.premarketPlan}
                  />
                  <span className="hud-value-sm font-mono">{time.toLocaleTimeString("en-US", { hour12: false })}</span>
                </div>
              </header>
            )}
          </div>
        </div>

        {nativeShell && (
          <div className="shrink-0" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 64px)" }} />
        )}

        {desktopPanel && (
          <motion.div
            initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="hud-remote-bar hud-remote-bar--desktop shrink-0"
          >
            <div className="hud-remote-bar__section">
              <span className="hud-label text-hud-primary">REMOTE LINK</span>
              <div className="min-w-0">
                <div className="hud-remote-bar__value truncate font-mono">{connection.apiUrl}</div>
              </div>
            </div>

            <div className="hud-remote-bar__section hud-remote-bar__section--meta">
              <div className="hud-remote-bar__meta">
                <span className="hud-label">Bearer</span>
                <span className="hud-remote-bar__value font-mono">{maskBearerToken(connection.bearerToken)}</span>
              </div>
              <div className="hud-remote-bar__meta">
                <span className="hud-label">Agent</span>
                <span
                  className={clsx("hud-remote-bar__value", isAgentEnabled ? "text-hud-success" : "text-hud-warning")}
                >
                  {isAgentEnabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div className="hud-remote-bar__meta">
                <span className="hud-label">Strategy</span>
                <span className="hud-remote-bar__value">{status?.strategy || "default"}</span>
              </div>
              <div className="hud-remote-bar__meta">
                <span className="hud-label">Latency</span>
                <span className={clsx("hud-remote-bar__value", error ? "text-hud-warning" : "text-hud-primary")}>
                  {error ? "DEGRADED" : "STABLE"}
                </span>
              </div>
              <div className="hud-remote-bar__meta">
                <span className="hud-label">Version</span>
                <span
                  className={clsx(
                    "hud-remote-bar__value",
                    updateStatus?.state === "error"
                      ? "text-hud-warning"
                      : updateAvailable
                        ? "text-hud-success"
                        : "text-hud-primary"
                  )}
                >
                  {updateStateLabel}
                </span>
              </div>
            </div>

            <div className="hud-remote-bar__actions">
              {updateAvailable ? (
                <button
                  type="button"
                  className={remoteLinkActionClass}
                  onClick={() => {
                    void handleInstallUpdate();
                  }}
                  disabled={updateBusy || updateStatus?.state === "installing"}
                >
                  {updateBusy || updateStatus?.state === "downloading" ? "DOWNLOADING..." : "Install Update"}
                </button>
              ) : (
                <button
                  type="button"
                  className={remoteLinkActionClass}
                  onClick={() => {
                    void handleCheckUpdate();
                  }}
                  disabled={updateBusy || updateStatus?.state === "checking"}
                >
                  {updateBusy || updateStatus?.state === "checking" ? "CHECKING..." : "Check Update"}
                </button>
              )}
              <button
                type="button"
                className={remoteLinkActionClass}
                onClick={(event) => {
                  event.currentTarget.blur();
                  setShowSettings(true);
                }}
              >
                Open Config
              </button>
              <button type="button" className={remoteLinkActionClass} onClick={() => setShowSetup(true)}>
                Edit Link
              </button>
              <button
                type="button"
                className={remoteLinkActionClass}
                onClick={() => handleAgentAction(isAgentEnabled ? "disable" : "enable")}
                disabled={busyAction === "enable" || busyAction === "disable"}
              >
                {busyAction === "enable" || busyAction === "disable"
                  ? "WORKING..."
                  : isAgentEnabled
                    ? "Disable Agent"
                    : "Enable Agent"}
              </button>
            </div>
          </motion.div>
        )}

        <div
          className={clsx(
            viewportLockedShell && "min-h-0 flex-1",
            desktopPanel ? "grid gap-3 lg:grid-rows-[minmax(0,1.2fr)_minmax(0,0.8fr)]" : "flex flex-col"
          )}
        >
          <motion.div
            initial={desktopPanel ? { opacity: 0, y: 18, filter: "blur(10px)" } : undefined}
            animate={desktopPanel ? { opacity: 1, y: 0, filter: "blur(0px)" } : undefined}
            transition={desktopPanel ? { duration: 0.42, ease: [0.22, 1, 0.36, 1] } : undefined}
            className={clsx(
              "grid gap-4",
              !desktopPanel && desktopShell && "lg:grid-cols-12 lg:items-start",
              desktopPanel && "min-h-0 h-full lg:grid-cols-12 lg:items-stretch"
            )}
          >
            {!desktopPanel && (
              <div className={clsx("shrink-0 min-h-0", desktopShell && "lg:col-span-4")}>
                <Panel
                  title="REMOTE LINK"
                  titleRight={
                    nativeShell ? (
                      <button
                        type="button"
                        onClick={() => setShowRemoteLinkDetails((current) => !current)}
                        className="flex h-11 w-11 items-center justify-center rounded-xl border border-hud-line/60 bg-hud-bg/55 text-hud-primary transition-transform hover:border-hud-primary/40 hover:text-hud-text"
                        aria-label={remoteLinkExpanded ? "Collapse remote link" : "Expand remote link"}
                      >
                        <svg
                          aria-hidden="true"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={clsx("transition-transform duration-200", remoteLinkExpanded && "rotate-180")}
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    ) : (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          className={remoteLinkActionClass}
                          onClick={(event) => {
                            event.currentTarget.blur();
                            setShowSettings(true);
                          }}
                        >
                          Open Config
                        </button>
                        <button type="button" className={remoteLinkActionClass} onClick={() => setShowSetup(true)}>
                          Edit Link
                        </button>
                        <button
                          type="button"
                          className={remoteLinkActionClass}
                          onClick={() => handleAgentAction(isAgentEnabled ? "disable" : "enable")}
                          disabled={busyAction === "enable" || busyAction === "disable"}
                        >
                          {busyAction === "enable" || busyAction === "disable"
                            ? "WORKING..."
                            : isAgentEnabled
                              ? "Disable Agent"
                              : "Enable Agent"}
                        </button>
                      </div>
                    )
                  }
                  className={clsx("overflow-hidden", desktopPanel && "h-full")}
                >
                  {remoteLinkExpanded &&
                    (nativeShell ? (
                      <div className="grid gap-4">
                        <div
                          className={clsx(
                            "grid gap-3",
                            nativeShell ? "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start" : "grid-cols-1"
                          )}
                        >
                          <div className={clsx("grid gap-3", nativeShell ? "sm:grid-cols-2" : "grid-cols-1")}>
                            <div className="min-w-0 rounded-xl border border-hud-line bg-hud-bg/55 px-4 py-4">
                              <div className="hud-label mb-2">ENDPOINT</div>
                              <div className="hud-value-sm break-all">{connection.apiUrl}</div>
                            </div>
                            <div className="rounded-xl border border-hud-line bg-hud-bg/55 px-4 py-4">
                              <div className="hud-label mb-2">BEARER</div>
                              <div className="hud-value-sm">{maskBearerToken(connection.bearerToken)}</div>
                            </div>
                          </div>

                          {nativeShell && (
                            <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                              {updateAvailable ? (
                                <button
                                  type="button"
                                  className={remoteLinkActionClass}
                                  onClick={() => {
                                    void handleInstallUpdate();
                                  }}
                                  disabled={updateBusy || updateStatus?.state === "installing"}
                                >
                                  {updateBusy || updateStatus?.state === "downloading"
                                    ? "DOWNLOADING..."
                                    : "Install Update"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={remoteLinkActionClass}
                                  onClick={() => {
                                    void handleCheckUpdate();
                                  }}
                                  disabled={updateBusy || updateStatus?.state === "checking"}
                                >
                                  {updateBusy || updateStatus?.state === "checking" ? "CHECKING..." : "Check Update"}
                                </button>
                              )}
                              <button
                                type="button"
                                className={remoteLinkActionClass}
                                onClick={(event) => {
                                  event.currentTarget.blur();
                                  setShowSettings(true);
                                }}
                              >
                                Open Config
                              </button>
                              <button
                                type="button"
                                className={remoteLinkActionClass}
                                onClick={() => setShowSetup(true)}
                              >
                                Edit Link
                              </button>
                              <button
                                type="button"
                                className={remoteLinkActionClass}
                                onClick={() => handleAgentAction(isAgentEnabled ? "disable" : "enable")}
                                disabled={busyAction === "enable" || busyAction === "disable"}
                              >
                                {busyAction === "enable" || busyAction === "disable"
                                  ? "WORKING..."
                                  : isAgentEnabled
                                    ? "Disable Agent"
                                    : "Enable Agent"}
                              </button>
                            </div>
                          )}
                        </div>

                        <div
                          className={clsx("grid gap-3", desktopShell ? "md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}
                        >
                          <div className="rounded-xl border border-hud-line bg-hud-bg/60 px-4 py-4">
                            <div className="hud-label text-hud-primary mb-2">AGENT</div>
                            <div
                              className={clsx("hud-value-sm", isAgentEnabled ? "text-hud-success" : "text-hud-warning")}
                            >
                              {isAgentEnabled ? "ENABLED" : "DISABLED"}
                            </div>
                          </div>
                          <div className="rounded-xl border border-hud-line bg-hud-bg/60 px-4 py-4">
                            <div className="hud-label text-hud-primary mb-2">STRATEGY</div>
                            <div className="hud-value-sm">{status?.strategy || "default"}</div>
                          </div>
                          <div className="rounded-xl border border-hud-line bg-hud-bg/60 px-4 py-4">
                            <div className="hud-label text-hud-primary mb-2">LATENCY</div>
                            <div className="hud-value-sm">{error ? "DEGRADED" : "STABLE"}</div>
                          </div>
                          <div className="rounded-xl border border-hud-line bg-hud-bg/60 px-4 py-4">
                            <div className="hud-label text-hud-primary mb-2">VERSION</div>
                            <div
                              className={clsx(
                                "hud-value-sm",
                                updateStatus?.state === "error"
                                  ? "text-hud-warning"
                                  : updateAvailable
                                    ? "text-hud-success"
                                    : "text-hud-primary"
                              )}
                            >
                              {updateStateLabel}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <div className="flex items-start gap-3">
                            <span className="hud-label w-16 shrink-0 pt-0.5">ENDPOINT</span>
                            <span className="hud-value-sm min-w-0 break-all font-mono">{connection.apiUrl}</span>
                          </div>
                          <div className="flex items-start gap-3">
                            <span className="hud-label w-16 shrink-0 pt-0.5">BEARER</span>
                            <span className="hud-value-sm font-mono">{maskBearerToken(connection.bearerToken)}</span>
                          </div>
                        </div>
                        <div className="grid gap-3 border-t border-hud-line/60 pt-3 md:grid-cols-3">
                          <MetricInline
                            label="AGENT"
                            value={isAgentEnabled ? "ENABLED" : "DISABLED"}
                            valueClassName={isAgentEnabled ? "text-hud-success" : "text-hud-warning"}
                          />
                          <MetricInline label="STRATEGY" value={status?.strategy || "default"} />
                          <MetricInline
                            label="LATENCY"
                            value={error ? "DEGRADED" : "STABLE"}
                            valueClassName={error ? "text-hud-warning" : "text-hud-primary"}
                          />
                        </div>
                      </div>
                    ))}
                </Panel>
              </div>
            )}

            <div
              className={clsx(
                "min-h-0",
                desktopPanel ? "h-full lg:col-span-7" : !desktopPanel && desktopShell && "shrink-0 lg:col-span-8"
              )}
            >
              <Panel
                title="PORTFOLIO OVERVIEW"
                variant={desktopPanel ? "hero" : "default"}
                titleRight={
                  <div className="flex flex-wrap justify-end gap-2">
                    {PORTFOLIO_PERIOD_OPTIONS.map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() => setPortfolioPeriod(p)}
                        className={clsx(
                          periodButtonClass,
                          portfolioPeriod === p
                            ? "border-hud-primary/40 bg-hud-primary/10 text-hud-primary"
                            : "border-hud-line/50 text-hud-text-dim hover:text-hud-text"
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                }
                className={clsx("overflow-hidden", desktopPanel && "h-full")}
              >
                {account ? (
                  <div
                    className={clsx(
                      "grid h-full min-h-0 gap-4",
                      desktopPanel
                        ? "items-start lg:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)]"
                        : "xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]"
                    )}
                  >
                    <div className="flex flex-col gap-3 min-h-0">
                      <div className={clsx("hud-hero-card", desktopPanel && "hud-hero-card--compact")}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="hud-hero-card__eyebrow">Capital State</div>
                            <div className="hud-label text-hud-primary mb-2">Net Liquidation</div>
                          </div>
                          <span className={clsx("hud-hero-pill", totalPl >= 0 ? "is-positive" : "is-negative")}>
                            {totalPlStateLabel}
                          </span>
                        </div>
                        <AnimatedMetricValue
                          value={account.equity}
                          formatter={formatCurrency}
                          className={clsx(
                            "font-semibold tracking-tight text-hud-text-bright",
                            desktopPanel ? "text-[36px] leading-none" : "text-3xl md:text-4xl"
                          )}
                          pulseOnChange
                        />
                      </div>

                      {nativeShell && (
                        <button
                          type="button"
                          onClick={() => setShowPortfolioDetails((current) => !current)}
                          className="flex min-h-[52px] items-center justify-between rounded-xl border border-hud-line/60 bg-hud-bg/45 px-4 py-3 text-left text-hud-text transition-colors hover:border-hud-primary/40"
                        >
                          <span className="hud-label text-hud-primary">Portfolio Details</span>
                          <svg
                            aria-hidden="true"
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={clsx(
                              "transition-transform duration-200",
                              portfolioDetailsExpanded && "rotate-180"
                            )}
                          >
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                      )}

                      {portfolioDetailsExpanded &&
                        (desktopPanel ? (
                          <div className="hud-compact-grid">
                            <div className="hud-compact-grid__item">
                              <div className="hud-label text-hud-primary mb-1">Cash</div>
                              <div className="hud-compact-grid__value">{formatCompactCurrency(account.cash)}</div>
                            </div>
                            <div className="hud-compact-grid__item">
                              <div className="hud-label text-hud-primary mb-1">Buying Power</div>
                              <div className="hud-compact-grid__value">
                                {formatCompactCurrency(account.buying_power)}
                              </div>
                            </div>
                            <div className="hud-compact-grid__item">
                              <div className="hud-label text-hud-primary mb-1">Realized</div>
                              <div
                                className={clsx(
                                  "hud-compact-grid__value",
                                  realizedPl >= 0 ? "text-hud-success" : "text-hud-error"
                                )}
                              >
                                {formatCompactCurrency(realizedPl)}
                              </div>
                            </div>
                            <div className="hud-compact-grid__item">
                              <div className="hud-label text-hud-primary mb-1">Unrealized</div>
                              <div
                                className={clsx(
                                  "hud-compact-grid__value",
                                  unrealizedPl >= 0 ? "text-hud-success" : "text-hud-error"
                                )}
                              >
                                {formatCompactCurrency(unrealizedPl)}
                              </div>
                            </div>
                            <div className="hud-compact-grid__item">
                              <div className="hud-label mb-1">APY</div>
                              <div
                                className={clsx(
                                  "hud-compact-grid__value",
                                  rollingApy !== null
                                    ? rollingApy >= 0
                                      ? "text-hud-success"
                                      : "text-hud-error"
                                    : "text-hud-text-dim"
                                )}
                              >
                                {rollingApy !== null ? formatPercent(rollingApy) : "CALC..."}
                              </div>
                            </div>
                            <div className="hud-compact-grid__item">
                              <div className="hud-label mb-1">Open Risk</div>
                              <div className="hud-compact-grid__value">
                                {positions.length}/{config?.max_positions || 5}
                              </div>
                            </div>
                            <div className="hud-compact-grid__item hud-compact-grid__item--wide">
                              <div className="hud-label mb-1">Sync</div>
                              <div className="hud-compact-grid__value">{syncTimeLabel}</div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="hud-kpi-grid grid-cols-2">
                              <div className="hud-kpi-card">
                                <div className="hud-label text-hud-primary mb-1">Cash</div>
                                <div className="hud-kpi-card__value hud-kpi-card__value--lg">
                                  {formatCompactCurrency(account.cash)}
                                </div>
                              </div>
                              <div className="hud-kpi-card">
                                <div className="hud-label text-hud-primary mb-1">Buying Power</div>
                                <div className="hud-kpi-card__value hud-kpi-card__value--lg">
                                  {formatCompactCurrency(account.buying_power)}
                                </div>
                              </div>
                              <div className="hud-kpi-card">
                                <div className="hud-label text-hud-primary mb-1">Realized</div>
                                <div
                                  className={clsx(
                                    "hud-kpi-card__value hud-kpi-card__value--lg",
                                    realizedPl >= 0 ? "text-hud-success" : "text-hud-error"
                                  )}
                                >
                                  {formatCompactCurrency(realizedPl)}
                                </div>
                              </div>
                              <div className="hud-kpi-card">
                                <div className="hud-label text-hud-primary mb-1">Unrealized</div>
                                <div
                                  className={clsx(
                                    "hud-kpi-card__value hud-kpi-card__value--lg",
                                    unrealizedPl >= 0 ? "text-hud-success" : "text-hud-error"
                                  )}
                                >
                                  {formatCompactCurrency(unrealizedPl)}
                                </div>
                              </div>
                            </div>

                            <div className="hud-kpi-grid grid-cols-1 sm:grid-cols-3">
                              <div className="hud-kpi-card hud-kpi-card--quiet">
                                <div className="hud-label mb-1">APY</div>
                                <div
                                  className={clsx(
                                    "hud-kpi-card__value",
                                    rollingApy !== null
                                      ? rollingApy >= 0
                                        ? "text-hud-success"
                                        : "text-hud-error"
                                      : "text-hud-text-dim"
                                  )}
                                >
                                  {rollingApy !== null ? formatPercent(rollingApy) : "CALC..."}
                                </div>
                              </div>
                              <div className="hud-kpi-card hud-kpi-card--quiet">
                                <div className="hud-label mb-1">Open Risk</div>
                                <div className="hud-kpi-card__value">
                                  {positions.length}/{config?.max_positions || 5}
                                </div>
                              </div>
                              <div className="hud-kpi-card hud-kpi-card--quiet">
                                <div className="hud-label mb-1">Sync</div>
                                <div className="hud-kpi-card__value">{syncTimeLabel}</div>
                              </div>
                            </div>
                          </>
                        ))}
                    </div>

                    <div className="min-h-0 h-full flex flex-col gap-3">
                      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                        <div>
                          <div className="hud-section-kicker">Trajectory</div>
                          <div className="hud-label text-hud-primary mb-1">Equity Curve</div>
                        </div>
                        <div className="hidden md:flex items-center gap-4">
                          <MetricInline label="Portfolio" value={formatCompactCurrency(account.portfolio_value)} />
                          <MetricInline
                            label="Exposure"
                            value={formatPercent(totalPlPct)}
                            color={totalPlPct >= 0 ? "success" : "error"}
                          />
                        </div>
                      </div>

                      <div className="hud-chart-stage flex-1">
                        {portfolioChartData.length > 1 ? (
                          <LineChart
                            height={desktopPanel ? "100%" : 320}
                            viewBoxHeight={desktopPanel ? 520 : 320}
                            series={[
                              { label: "Equity", data: portfolioChartData, variant: totalPl >= 0 ? "green" : "red" },
                            ]}
                            labels={portfolioChartLabels}
                            updateToken={portfolioChartUpdateToken}
                            updateEffect="trace"
                            showArea={true}
                            showGrid={true}
                            showDots={false}
                            formatValue={(v) => `$${(v / 1000).toFixed(1)}k`}
                            markers={marketMarkers}
                            marketHours={marketHoursZone}
                          />
                        ) : (
                          <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                            Collecting performance data...
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-hud-text-dim text-sm">Loading...</div>
                )}
              </Panel>
            </div>

            {desktopPanel && <div className="min-h-0 h-full lg:col-span-5">{positionsPanel}</div>}
          </motion.div>

          <motion.div
            initial={desktopPanel ? { opacity: 0, y: 22, filter: "blur(12px)" } : undefined}
            animate={desktopPanel ? { opacity: 1, y: 0, filter: "blur(0px)" } : undefined}
            transition={desktopPanel ? { duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] } : undefined}
            className={clsx(
              "grid grid-cols-4 gap-4 md:grid-cols-8 lg:grid-cols-12",
              desktopPanel && "min-h-0 h-full gap-3 auto-rows-fr"
            )}
          >
            {!desktopPanel && <div className="col-span-4 md:col-span-4 lg:col-span-4">{positionsPanel}</div>}

            <div className={clsx("col-span-4 md:col-span-8 lg:col-span-3", desktopPanel && "min-h-0 h-full")}>
              <Panel
                title="POSITION TIMELINE"
                titleRight={
                  <div className="flex gap-2">
                    {PORTFOLIO_PERIOD_OPTIONS.map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() => setPositionTimelinePeriod(p)}
                        className={clsx(
                          periodButtonClass,
                          positionTimelinePeriod === p
                            ? "border-hud-primary/40 bg-hud-primary/10 text-hud-primary"
                            : "border-hud-line/50 text-hud-text-dim hover:text-hud-text"
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                }
                className={clsx(
                  "overflow-hidden",
                  desktopPanel
                    ? "h-full min-h-0"
                    : desktopShell
                      ? "h-[340px] lg:h-[380px]"
                      : "h-full min-h-[320px] lg:min-h-[360px]"
                )}
              >
                {positionTimelineSeries.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                    No timeline data to display
                  </div>
                ) : (
                  <div className="h-full min-h-0 flex flex-col">
                    <div className="hud-timeline-legend mb-2 shrink-0 border-b border-hud-line/30 pb-2">
                      {positionTimelineLegend.map((series) => {
                        const isPositive = series.currentReturn >= 0;
                        return (
                          <div key={series.label} className="hud-timeline-legend__item flex items-center gap-1.5">
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: `var(--color-hud-${series.variant})` }}
                            />
                            <span className="text-[13px] font-semibold text-hud-text-bright">{series.label}</span>
                            <span
                              className={clsx(
                                "text-[11px] font-semibold uppercase tracking-[0.14em]",
                                isPositive ? "text-hud-success" : "text-hud-error"
                              )}
                            >
                              {formatPercent(series.currentReturn)}
                            </span>
                            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-hud-text-dim">
                              {series.holdDuration}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex-1 min-h-0 w-full">
                      <PositionTimelineChart
                        height={desktopPanel ? "100%" : 220}
                        viewBoxHeight={desktopPanel ? 420 : 220}
                        series={positionTimelineSeries}
                        xDomainStart={positionTimelineDomain.start}
                        xDomainEnd={positionTimelineDomain.end}
                        updateToken={positionTimelineUpdateToken}
                        formatValue={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
                      />
                    </div>
                  </div>
                )}
              </Panel>
            </div>

            <div className="col-span-4 md:col-span-4 lg:col-span-3">
              <Panel
                title="ACTIVE SIGNALS"
                titleRight={signals.length.toString()}
                className={clsx(
                  "overflow-hidden",
                  desktopPanel
                    ? "h-full min-h-0"
                    : desktopShell
                      ? "h-[340px] lg:h-[380px]"
                      : "h-full min-h-[320px] lg:min-h-[360px]"
                )}
              >
                <div className="hud-live-list hud-scroll-pane hud-list-stack overflow-y-auto h-full space-y-2">
                  <div className="hud-list-card hud-list-card--signal p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div
                          className={clsx(
                            "hud-label",
                            entryDiagnostic.state === "active"
                              ? "text-hud-success"
                              : entryDiagnostic.state === "blocked"
                                ? "text-hud-warning"
                                : "text-hud-text-dim"
                          )}
                        >
                          ENTRY GATE
                        </div>
                        <div className="mt-1 text-[13px] font-semibold leading-none text-hud-text-bright">
                          {entryDiagnostic.label}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="hud-label">LAST BUY</div>
                        <div
                          className={clsx(
                            "mt-1 hud-value-sm",
                            entryDiagnostic.lastBuyLabel === "NONE" ? "text-hud-warning" : "text-hud-success"
                          )}
                        >
                          {entryDiagnostic.lastBuyLabel}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-hud-line/40 pt-2 text-[11px] leading-tight">
                      <span className="min-w-0 truncate text-hud-text-dim">{entryDiagnostic.blockerLabel}</span>
                      <span className="text-right text-hud-text">{entryDiagnostic.blockerCount}</span>
                      <span className="col-span-2 text-hud-text-dim">{entryDiagnostic.detail}</span>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-2 border-t border-hud-line/30 pt-2">
                      <div className="min-w-0">
                        <div className="hud-label truncate">RESEARCH BUY</div>
                        <div className="mt-1 text-[12px] font-semibold tabular-nums text-hud-text">
                          {entryDiagnostic.pipeline.researchBuy}
                          <span className="text-hud-text-dim">/{entryDiagnostic.pipeline.researchTotal}</span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="hud-label truncate">ENTRY CAND</div>
                        <div className="mt-1 text-[12px] font-semibold tabular-nums text-hud-text">
                          {entryDiagnostic.pipeline.strategyCandidates}
                          <span className="text-hud-text-dim">/{entryDiagnostic.pipeline.researchFreshBuy}</span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="hud-label truncate">LLM BUY</div>
                        <div className="mt-1 text-[12px] font-semibold tabular-nums text-hud-text">
                          {entryDiagnostic.pipeline.analystBuyAboveThreshold}
                          <span className="text-hud-text-dim">/{entryDiagnostic.pipeline.analystBuy}</span>
                        </div>
                      </div>
                    </div>

                    {entryDiagnostic.pipeline.missedEntryEvaluated > 0 && (
                      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-hud-line/30 pt-2">
                        <div className="min-w-0">
                          <div className="hud-label truncate">MISSED CHECK</div>
                          <div className="mt-1 text-[12px] font-semibold tabular-nums text-hud-text">
                            {entryDiagnostic.pipeline.missedEntryEvaluated}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="hud-label truncate">WOULD WIN</div>
                          <div
                            className={clsx(
                              "mt-1 text-[12px] font-semibold tabular-nums",
                              entryDiagnostic.pipeline.missedEntryWouldHaveWon >
                                entryDiagnostic.pipeline.missedEntryWouldHaveLost
                                ? "text-hud-warning"
                                : "text-hud-text"
                            )}
                          >
                            {entryDiagnostic.pipeline.missedEntryWouldHaveWon}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="hud-label truncate">WOULD LOSE</div>
                          <div className="mt-1 text-[12px] font-semibold tabular-nums text-hud-text">
                            {entryDiagnostic.pipeline.missedEntryWouldHaveLost}
                          </div>
                        </div>
                      </div>
                    )}

                    {entryDiagnostic.pipeline.topMissedEntryReason && (
                      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 border-t border-hud-line/30 pt-2 text-[11px] leading-tight">
                        <span className="hud-label truncate">TOP MISSED REASON</span>
                        <span className="text-right font-semibold tabular-nums text-hud-text">
                          {entryDiagnostic.pipeline.topMissedEntryReason.wouldHaveWon}/
                          {entryDiagnostic.pipeline.topMissedEntryReason.evaluated}
                        </span>
                        <span className="col-span-2 truncate text-hud-text-dim">
                          {entryDiagnostic.pipeline.topMissedEntryReason.reason.replace(/_/g, " ")}
                        </span>
                      </div>
                    )}

                    {entryDiagnostic.hints.length > 0 && (
                      <div className="mt-2 space-y-1 border-t border-hud-line/30 pt-2">
                        {entryDiagnostic.hints.map((hint) => (
                          <div key={hint} className="text-[10px] leading-snug text-hud-text-dim">
                            {hint}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {signals.length === 0 ? (
                    <div className="text-hud-text-dim text-sm py-4 text-center">Gathering signals...</div>
                  ) : (
                    <AnimatePresence initial={false} mode="popLayout">
                      {visibleSignals.map((sig: Signal, i: number) => (
                        <Tooltip
                          key={`${sig.symbol}-${sig.source}-${i}`}
                          position="right"
                          content={
                            <TooltipContent
                              title={`${sig.symbol} - ${sig.source.toUpperCase()}`}
                              items={[
                                {
                                  label: "Sentiment",
                                  value: `${(sig.sentiment * 100).toFixed(0)}%`,
                                  color: getSentimentColor(sig.sentiment),
                                },
                                { label: "Volume", value: sig.volume },
                                ...(sig.bullish !== undefined
                                  ? [{ label: "Bullish", value: sig.bullish, color: "text-hud-success" }]
                                  : []),
                                ...(sig.bearish !== undefined
                                  ? [{ label: "Bearish", value: sig.bearish, color: "text-hud-error" }]
                                  : []),
                                ...(sig.score !== undefined ? [{ label: "Score", value: sig.score }] : []),
                                ...(sig.upvotes !== undefined ? [{ label: "Upvotes", value: sig.upvotes }] : []),
                                ...(sig.momentum !== undefined
                                  ? [
                                      {
                                        label: "Momentum",
                                        value: `${sig.momentum >= 0 ? "+" : ""}${sig.momentum.toFixed(2)}%`,
                                      },
                                    ]
                                  : []),
                                ...(sig.price !== undefined
                                  ? [{ label: "Price", value: formatCurrency(sig.price) }]
                                  : []),
                              ]}
                              description={sig.reason}
                            />
                          }
                        >
                          <motion.div
                            layout
                            initial={{ opacity: 0, x: -14, filter: "blur(6px)" }}
                            animate={{
                              opacity: 1,
                              x: 0,
                              filter: "blur(0px)",
                              boxShadow:
                                signalListUpdateToken > 0 && i < 2
                                  ? [
                                      "0 0 0 rgba(111,216,255,0)",
                                      "0 0 18px rgba(111,216,255,0.18)",
                                      "0 0 0 rgba(111,216,255,0)",
                                    ]
                                  : "0 0 0 rgba(111,216,255,0)",
                            }}
                            exit={{ opacity: 0, x: 12, filter: "blur(6px)" }}
                            transition={{ delay: i * 0.02 }}
                            className={clsx(
                              "hud-list-card hud-list-card--signal flex items-center justify-between cursor-help px-3 py-2 transition-transform duration-200",
                              i === 0 && signalListUpdateToken > 0 && "hud-live-row-hot",
                              sig.isCrypto && "bg-hud-warning/5"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              {sig.isCrypto && <span className="text-hud-warning text-xs">₿</span>}
                              <span className="hud-value-sm">{sig.symbol}</span>
                              <span className={clsx("hud-label", sig.isCrypto ? "text-hud-warning" : "")}>
                                {sig.source.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              {sig.isCrypto && sig.momentum !== undefined ? (
                                <span
                                  className={clsx(
                                    "hud-label hidden sm:inline",
                                    sig.momentum >= 0 ? "text-hud-success" : "text-hud-error"
                                  )}
                                >
                                  {sig.momentum >= 0 ? "+" : ""}
                                  {sig.momentum.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="hud-label hidden sm:inline">VOL {sig.volume}</span>
                              )}
                              <span className={clsx("hud-value-sm", getSentimentColor(sig.sentiment))}>
                                {(sig.sentiment * 100).toFixed(0)}%
                              </span>
                            </div>
                          </motion.div>
                        </Tooltip>
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              </Panel>
            </div>

            <div className="col-span-4 md:col-span-4 lg:col-span-3">
              <Panel
                title="ACTIVITY FEED"
                titleRight="LIVE"
                className={clsx(
                  "overflow-hidden",
                  desktopPanel
                    ? "h-full min-h-0"
                    : desktopShell
                      ? "h-[340px] lg:h-[380px]"
                      : "h-full min-h-[320px] lg:min-h-[360px]"
                )}
              >
                <div
                  className={clsx(
                    "hud-live-list hud-scroll-pane hud-list-stack overflow-x-hidden overflow-y-auto h-full font-mono text-sm space-y-1",
                    nativeShell && "max-h-[24rem] lg:max-h-none"
                  )}
                >
                  {logs.length === 0 ? (
                    <div className="text-hud-text-dim py-4 text-center">Waiting for activity...</div>
                  ) : (
                    <AnimatePresence initial={false} mode="popLayout">
                      {visibleLogs.map((log: LogEntry) => {
                        const logKey = getActivityLogKey(log);
                        const isNewLog = newActivityFeedKeys.has(logKey);
                        return (
                          <motion.button
                            type="button"
                            key={logKey}
                            layout
                            initial={false}
                            animate={{
                              opacity: isNewLog ? [0, 1] : 1,
                              x: isNewLog ? [-12, 0] : 0,
                              filter: isNewLog ? ["blur(4px)", "blur(0px)"] : "blur(0px)",
                              boxShadow: isNewLog
                                ? [
                                    "0 0 0 rgba(111,216,255,0)",
                                    "0 0 18px rgba(111,216,255,0.14)",
                                    "0 0 0 rgba(111,216,255,0)",
                                  ]
                                : "0 0 0 rgba(111,216,255,0)",
                            }}
                            exit={{ opacity: 0, x: 12, filter: "blur(4px)" }}
                            transition={isNewLog ? { duration: 0.32, ease: [0.22, 1, 0.36, 1] } : { duration: 0.18 }}
                            onClick={() => setSelectedActivityLog(log)}
                            className={clsx(
                              "hud-feed-row hud-list-card hud-list-card--feed min-w-0 flex w-full items-start gap-2 px-3 py-2 text-left",
                              isNewLog && "hud-live-row-hot"
                            )}
                          >
                            <span className="text-hud-text-dim shrink-0 hidden sm:inline w-[52px]">
                              {new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                            </span>
                            <span className={clsx("shrink-0 w-[72px] text-right", getAgentColor(log.agent))}>
                              {log.agent}
                            </span>
                            <span className="text-hud-text flex-1 text-right wrap-break-word">
                              {log.action}
                              {log.symbol && <span className="text-hud-primary ml-1">({log.symbol})</span>}
                            </span>
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  )}
                </div>
              </Panel>
            </div>

            <div className="col-span-4 md:col-span-8 lg:col-span-3">
              <Panel
                title="SIGNAL RESEARCH"
                titleRight={`${signalResearchEntries.length}/${signalResearchTotal}`}
                className={clsx(
                  "overflow-hidden",
                  desktopPanel
                    ? "h-full min-h-0"
                    : desktopShell
                      ? "h-[340px] lg:h-[380px]"
                      : "h-full min-h-[320px] lg:min-h-[360px]"
                )}
              >
                <div className="hud-scroll-pane hud-list-stack overflow-y-auto h-full space-y-2">
                  {adaptivePerformance && (
                    <div className="hud-list-card hud-list-card--research p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="hud-label text-hud-primary">ADAPTIVE BLOCKS</span>
                        <span
                          className={clsx(
                            "hud-value-sm",
                            adaptivePerformance.enabled ? "text-hud-success" : "text-hud-text-dim"
                          )}
                        >
                          {adaptivePerformance.symbol_block_count + adaptivePerformance.feature_block_count}
                        </span>
                      </div>
                      {adaptiveBlockRows.length === 0 ? (
                        <div className="text-xs text-hud-text-dim">
                          {adaptivePerformance.enabled ? "No weak patterns blocked yet" : "Disabled"}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {adaptiveBlockRows.map((block) => (
                            <div
                              key={`${block.type}-${block.key}`}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="hud-label mr-2 text-hud-text-dim">{block.type}</span>
                                <span className="text-hud-text truncate">{block.key}</span>
                              </div>
                              <div className="shrink-0 text-right">
                                <span className="text-hud-warning">{(block.win_rate * 100).toFixed(0)}%</span>
                                <span className="ml-2 text-hud-text-dim">{block.trades}T</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {Object.entries(status?.signalResearch || {}).length === 0 ? (
                    <div className="text-hud-text-dim text-sm py-4 text-center">Researching candidates...</div>
                  ) : (
                    signalResearchEntries.map(([symbol, research]: [string, SignalResearch]) => {
                      const sentiment = getSafeSentiment(research.sentiment);
                      return (
                        <Tooltip
                          key={symbol}
                          position="left"
                          triggerClassName="block w-full"
                          content={
                            <div className="space-y-2 min-w-[200px]">
                              <div className="hud-label text-hud-primary border-b border-hud-line/50 pb-1">
                                {symbol} DETAILS
                              </div>
                              <div className="space-y-1">
                                <div className="flex justify-between">
                                  <span className="text-hud-text-dim">Confidence</span>
                                  <span className="text-hud-text-bright">
                                    {(research.confidence * 100).toFixed(0)}%
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-hud-text-dim">Sentiment</span>
                                  {sentiment !== null ? (
                                    <span className={getSentimentColor(sentiment)}>
                                      {(sentiment * 100).toFixed(0)}%
                                    </span>
                                  ) : (
                                    <span className="text-hud-text-dim">N/A</span>
                                  )}
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-hud-text-dim">Analyzed</span>
                                  <span className="text-hud-text">
                                    {new Date(research.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                                  </span>
                                </div>
                              </div>
                              {research.catalysts.length > 0 && (
                                <div className="pt-1 border-t border-hud-line/30">
                                  <span className="text-[9px] text-hud-text-dim">CATALYSTS:</span>
                                  <ul className="mt-1 space-y-0.5">
                                    {research.catalysts.map((c) => (
                                      <li key={c} className="text-[10px] text-hud-success">
                                        + {c}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {research.red_flags.length > 0 && (
                                <div className="pt-1 border-t border-hud-line/30">
                                  <span className="text-[9px] text-hud-text-dim">RED FLAGS:</span>
                                  <ul className="mt-1 space-y-0.5">
                                    {research.red_flags.map((f) => (
                                      <li key={f} className="text-[10px] text-hud-error">
                                        - {f}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          }
                        >
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            onClick={() => setSelectedResearchSymbol(symbol)}
                            className="hud-list-card hud-list-card--research w-full cursor-pointer p-3 transition-colors"
                          >
                            <div className="flex justify-between items-center mb-1">
                              <span className="hud-value-sm">{symbol}</span>
                              <div className="flex items-center gap-2">
                                <span className={clsx("hud-label", getQualityColor(research.entry_quality))}>
                                  {research.entry_quality.toUpperCase()}
                                </span>
                                <span className={clsx("hud-value-sm font-bold", getVerdictColor(research.verdict))}>
                                  {research.verdict}
                                </span>
                              </div>
                            </div>
                            <p className="text-xs text-hud-text-dim leading-tight mb-1">{research.reasoning}</p>
                            {research.red_flags.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {research.red_flags.slice(0, 2).map((flag) => (
                                  <span key={flag} className="text-xs text-hud-error bg-hud-error/10 px-1 rounded">
                                    {flag.slice(0, 30)}...
                                  </span>
                                ))}
                              </div>
                            )}
                          </motion.div>
                        </Tooltip>
                      );
                    })
                  )}
                </div>
              </Panel>
            </div>
          </motion.div>

          <footer
            className={clsx(
              "shrink-0 border-t border-hud-line pt-3",
              desktopPanel
                ? "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-2"
                : "flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center"
            )}
          >
            <div className={clsx("flex flex-wrap", desktopPanel ? "gap-x-4 gap-y-1.5 text-[11px]" : "gap-4 md:gap-6")}>
              {config && (
                <>
                  <MetricInline label="MAX POS" value={`$${config.max_position_value}`} />
                  <MetricInline label="MIN SENT" value={`${(config.min_sentiment_score * 100).toFixed(0)}%`} />
                  <MetricInline label="TAKE PROFIT" value={`${config.take_profit_pct}%`} />
                  <MetricInline label="STOP LOSS" value={`${config.stop_loss_pct}%`} />
                  <span className="hidden lg:inline text-hud-line">|</span>
                  <MetricInline
                    label="OPTIONS"
                    value={config.options_enabled ? "ON" : "OFF"}
                    valueClassName={config.options_enabled ? "text-hud-purple" : "text-hud-text-dim"}
                  />
                  {config.options_enabled && (
                    <>
                      <MetricInline label="OPT Δ" value={config.options_target_delta?.toFixed(2) || "0.35"} />
                      <MetricInline
                        label="OPT DTE"
                        value={`${config.options_min_dte || 7}-${config.options_max_dte || 45}`}
                      />
                    </>
                  )}
                  <span className="hidden lg:inline text-hud-line">|</span>
                  <MetricInline
                    label="CRYPTO"
                    value={config.crypto_enabled ? "24/7" : "OFF"}
                    valueClassName={config.crypto_enabled ? "text-hud-warning" : "text-hud-text-dim"}
                  />
                  {config.crypto_enabled && (
                    <MetricInline
                      label="SYMBOLS"
                      value={(config.crypto_symbols || ["BTC", "ETH", "SOL"]).map((s) => s.split("/")[0]).join("/")}
                    />
                  )}
                </>
              )}
            </div>
            <div className={clsx("flex items-center", desktopPanel ? "gap-3" : "gap-4")}>
              <span className="hud-label hidden md:inline">AUTONOMOUS TRADING SYSTEM</span>
              <span className={clsx("hud-value-sm", error ? "text-hud-warning" : "text-hud-primary")}>
                {error ? "LINK DEGRADED" : "REMOTE LOCKED"}
              </span>
            </div>
          </footer>
        </div>
      </div>

      <AnimatePresence>
        {activeOpenCountdownSeconds !== null && activeOpenCountdownSeconds > 0 && (
          <motion.div
            key="market-open-countdown"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/55 backdrop-blur-[1px]"
          >
            <div className="flex flex-col items-center gap-4">
              <div className="hud-label text-white/80">MARKET OPENING</div>
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeOpenCountdownSeconds}
                  initial={{ opacity: 0, scale: 0.72, y: 18, filter: "blur(10px)" }}
                  animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 1.2, y: -14, filter: "blur(8px)" }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  className="text-[min(24vw,180px)] font-semibold leading-none tracking-[-0.04em] text-white"
                >
                  {activeOpenCountdownSeconds}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {selectedResearch && selectedResearchSymbol && (
          <motion.div
            key={`research-${selectedResearchSymbol}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <DetailDialog title={`${selectedResearchSymbol} RESEARCH`} onClose={() => setSelectedResearchSymbol(null)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Verdict</div>
                  <div className={clsx("hud-value-md", getVerdictColor(selectedResearch.verdict))}>
                    {selectedResearch.verdict}
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Confidence</div>
                  <div className="hud-value-md text-hud-text-bright">
                    {(selectedResearch.confidence * 100).toFixed(0)}%
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Sentiment</div>
                  <div
                    className={clsx(
                      "hud-value-md",
                      selectedResearchSentiment !== null
                        ? getSentimentColor(selectedResearchSentiment)
                        : "text-hud-text-dim"
                    )}
                  >
                    {selectedResearchSentiment !== null ? `${(selectedResearchSentiment * 100).toFixed(0)}%` : "N/A"}
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Analyzed</div>
                  <div className="hud-value-sm text-hud-text-bright">
                    {new Date(selectedResearch.timestamp).toLocaleString("en-US", { hour12: false })}
                  </div>
                </div>
              </div>

              <div className="border border-hud-line/60 bg-hud-bg/35 p-4">
                <div className="hud-label text-hud-primary mb-3">Reasoning</div>
                <p className="text-sm leading-7 text-hud-text whitespace-pre-wrap">{selectedResearch.reasoning}</p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="border border-hud-line/60 bg-hud-bg/30 p-4">
                  <div className="hud-label text-hud-success mb-3">Catalysts</div>
                  {selectedResearch.catalysts.length > 0 ? (
                    <div className="space-y-2">
                      {selectedResearch.catalysts.map((catalyst) => (
                        <div key={catalyst} className="text-sm leading-6 text-hud-text">
                          + {catalyst}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-hud-text-dim">No catalysts recorded.</div>
                  )}
                </div>

                <div className="border border-hud-line/60 bg-hud-bg/30 p-4">
                  <div className="hud-label text-hud-error mb-3">Red Flags</div>
                  {selectedResearch.red_flags.length > 0 ? (
                    <div className="space-y-2">
                      {selectedResearch.red_flags.map((flag) => (
                        <div key={flag} className="text-sm leading-6 text-hud-text">
                          - {flag}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-hud-text-dim">No red flags recorded.</div>
                  )}
                </div>
              </div>
            </DetailDialog>
          </motion.div>
        )}

        {selectedPosition && selectedPositionSymbol && (
          <motion.div
            key={`position-${selectedPositionSymbol}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <DetailDialog title={`${selectedPositionSymbol} POSITION`} onClose={() => setSelectedPositionSymbol(null)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Quantity</div>
                  <div className="hud-value-md text-hud-text-bright">{selectedPosition.qty}</div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Market Value</div>
                  <div className="hud-value-md text-hud-text-bright">
                    {formatCurrency(selectedPosition.market_value)}
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Unrealized P&L</div>
                  <div
                    className={clsx(
                      "hud-value-md",
                      selectedPosition.unrealized_pl >= 0 ? "text-hud-success" : "text-hud-error"
                    )}
                  >
                    {formatCurrency(selectedPosition.unrealized_pl)}
                  </div>
                  {selectedPositionPlPct !== null && (
                    <div
                      className={clsx(
                        "text-xs mt-1",
                        selectedPositionPlPct >= 0 ? "text-hud-success" : "text-hud-error"
                      )}
                    >
                      {formatPercent(selectedPositionPlPct)}
                    </div>
                  )}
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Current Price</div>
                  <div className="hud-value-md text-hud-text-bright">
                    {formatCurrency(selectedPosition.current_price)}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="border border-hud-line/60 bg-hud-bg/35 p-4 space-y-3">
                  <div className="hud-label text-hud-primary">Position Context</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="hud-label mb-1">Entry Price</div>
                      <div className="hud-value-sm text-hud-text-bright">
                        {selectedPositionEntry && Number.isFinite(selectedPositionEntry.entry_price)
                          ? formatCurrency(selectedPositionEntry.entry_price)
                          : "N/A"}
                      </div>
                    </div>
                    <div>
                      <div className="hud-label mb-1">Hold Time</div>
                      <div className="hud-value-sm text-hud-text-bright">
                        {selectedPositionHoldHours !== null ? `${selectedPositionHoldHours}h` : "N/A"}
                      </div>
                    </div>
                    <div>
                      <div className="hud-label mb-1">Entry Sentiment</div>
                      <div className="hud-value-sm text-hud-text-bright">
                        {selectedPositionEntry && Number.isFinite(selectedPositionEntry.entry_sentiment)
                          ? `${(selectedPositionEntry.entry_sentiment * 100).toFixed(0)}%`
                          : "N/A"}
                      </div>
                    </div>
                    <div>
                      <div className="hud-label mb-1">Side</div>
                      <div className="hud-value-sm text-hud-text-bright uppercase">{selectedPosition.side}</div>
                    </div>
                  </div>

                  <div>
                    <div className="hud-label mb-1">Entry Sources</div>
                    <div className="text-sm leading-6 text-hud-text">
                      {selectedPositionEntrySources.length > 0 ? selectedPositionEntrySources.join(", ") : "N/A"}
                    </div>
                  </div>
                </div>

                <div className="border border-hud-line/60 bg-hud-bg/35 p-4 space-y-3">
                  <div className="hud-label text-hud-primary">Trade Thesis</div>
                  <p className="text-sm leading-7 text-hud-text whitespace-pre-wrap">
                    {selectedPositionEntry?.entry_reason || "No stored entry reason."}
                  </p>

                  {selectedPositionStaleness && (
                    <div className="border-t border-hud-line/40 pt-3">
                      <div className="hud-label mb-2">Staleness Analysis</div>
                      <div className="text-sm mb-2">
                        <span className={selectedPositionStaleness.shouldExit ? "text-hud-error" : "text-hud-text"}>
                          Score{" "}
                          {selectedPositionStalenessScore !== null
                            ? `${(selectedPositionStalenessScore * 100).toFixed(0)}%`
                            : "N/A"}
                        </span>
                      </div>
                      {selectedPositionStalenessReasons.length > 0 && (
                        <div className="space-y-2">
                          {selectedPositionStalenessReasons.map((reason) => (
                            <div key={reason} className="text-sm leading-6 text-hud-text">
                              - {reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </DetailDialog>
          </motion.div>
        )}

        {selectedActivityLog && (
          <motion.div
            key={`activity-${getActivityLogKey(selectedActivityLog)}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <DetailDialog title="ACTIVITY LOG" onClose={() => setSelectedActivityLog(null)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Timestamp</div>
                  <div className="hud-value-sm text-hud-text-bright">
                    {new Date(selectedActivityLog.timestamp).toLocaleString("en-US", { hour12: false })}
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Agent</div>
                  <div className={clsx("hud-value-md", getAgentColor(selectedActivityLog.agent))}>
                    {selectedActivityLog.agent}
                  </div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Action</div>
                  <div className="hud-value-sm text-hud-text-bright break-words">{selectedActivityLog.action}</div>
                </div>
                <div className="border border-hud-line/60 bg-hud-bg/45 p-3">
                  <div className="hud-label mb-1">Symbol</div>
                  <div className="hud-value-md text-hud-primary">{selectedActivityLog.symbol || "N/A"}</div>
                </div>
              </div>

              {selectedActivityLogDetails.length > 0 ? (
                <div className="border border-hud-line/60 bg-hud-bg/35 p-4">
                  <div className="hud-label text-hud-primary mb-3">Metadata</div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {selectedActivityLogDetails.map((entry) => (
                      <div key={entry.key} className="border border-hud-line/40 bg-hud-bg/30 p-3">
                        <div className="hud-label mb-2">{entry.key}</div>
                        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-hud-text">
                          {entry.value}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="border border-hud-line/60 bg-hud-bg/35 p-4">
                  <div className="hud-label text-hud-primary mb-2">Metadata</div>
                  <div className="text-sm text-hud-text-dim">No additional fields recorded for this log entry.</div>
                </div>
              )}
            </DetailDialog>
          </motion.div>
        )}

        {showSettings && config && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <SettingsModal
              config={config}
              connection={connection}
              onSave={handleSaveConfig}
              onSaveConnection={handleSaveConnection}
              onClose={() => setShowSettings(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
