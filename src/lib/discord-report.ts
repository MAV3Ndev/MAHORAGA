import type { Account, DailyReportBucket, DailyReportTrade, Position } from "../core/types";

const DAILY_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DAILY_REPORT_BUCKET_MS = 60_000;
export const DAILY_REPORT_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface DailyReportSummary {
  periodStartMs: number;
  periodEndMs: number;
  totalEvents: number;
  dataGatherCycles: number;
  analystRuns: number;
  premarketPlans: number;
  breakingNewsAlerts: number;
  errors: number;
  researchedSignals: number;
  buyVerdicts: number;
  skipVerdicts: number;
  waitVerdicts: number;
  executedBuys: number;
  executedSells: number;
  executedBuyNotional: number;
  topSymbols: Array<{ symbol: string; count: number }>;
  recentTrades: Array<{
    side: "BUY" | "SELL";
    symbol: string;
    timestamp: string;
    reason?: string;
    notional?: number;
  }>;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function createDailyReportBucket(bucketStartMs: number): DailyReportBucket {
  return {
    bucket_start_ms: bucketStartMs,
    total_events: 0,
    data_gather_cycles: 0,
    analyst_runs: 0,
    premarket_plans: 0,
    breaking_news_alerts: 0,
    errors: 0,
    researched_signals: 0,
    buy_verdicts: 0,
    skip_verdicts: 0,
    wait_verdicts: 0,
    executed_buys: 0,
    executed_sells: 0,
    executed_buy_notional: 0,
    symbol_counts: {},
    recent_trades: [],
  };
}

export function getDailyReportBucketStart(timestampMs: number): number {
  return Math.floor(timestampMs / DAILY_REPORT_BUCKET_MS) * DAILY_REPORT_BUCKET_MS;
}

export function pruneDailyReportBuckets(
  buckets: Record<string, DailyReportBucket>,
  nowMs = Date.now(),
  retentionMs = DAILY_REPORT_RETENTION_MS
): boolean {
  let changed = false;
  const cutoff = nowMs - retentionMs;

  for (const [key, bucket] of Object.entries(buckets)) {
    if (!bucket || bucket.bucket_start_ms < cutoff) {
      delete buckets[key];
      changed = true;
    }
  }

  return changed;
}

function getZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(epochMs));
  const readPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type)?.value;
    return part ? Number.parseInt(part, 10) : 0;
  };

  return {
    year: readPart("year"),
    month: readPart("month"),
    day: readPart("day"),
    hour: readPart("hour"),
    minute: readPart("minute"),
  };
}

export function parseDailyReportTime(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(TIME_PATTERN);
  if (!match) return null;

  const hours = Number.parseInt(match[1] || "", 10);
  const minutes = Number.parseInt(match[2] || "", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function getDailyReportDateKey(epochMs: number, timeZone: string): string {
  const parts = getZonedParts(epochMs, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function shouldSendDailyReport(
  nowMs: number,
  lastSentAt: number | null | undefined,
  scheduledTime: string,
  timeZone: string
): boolean {
  const scheduledMinutes = parseDailyReportTime(scheduledTime);
  if (scheduledMinutes == null) return false;

  const nowParts = getZonedParts(nowMs, timeZone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  if (nowMinutes < scheduledMinutes) return false;

  if (typeof lastSentAt === "number" && Number.isFinite(lastSentAt)) {
    const nowKey = getDailyReportDateKey(nowMs, timeZone);
    const lastSentKey = getDailyReportDateKey(lastSentAt, timeZone);
    if (nowKey === lastSentKey) return false;
  }

  return true;
}

export function summarizeDailyActivityWindow(
  buckets: Record<string, DailyReportBucket>,
  periodStartMs: number,
  periodEndMs: number
): DailyReportSummary {
  const symbolCounts = new Map<string, number>();
  const recentTrades: DailyReportTrade[] = [];
  let totalEvents = 0;
  let dataGatherCycles = 0;
  let analystRuns = 0;
  let premarketPlans = 0;
  let breakingNewsAlerts = 0;
  let errors = 0;
  let researchedSignals = 0;
  let buyVerdicts = 0;
  let skipVerdicts = 0;
  let waitVerdicts = 0;
  let executedBuys = 0;
  let executedSells = 0;
  let executedBuyNotional = 0;

  for (const bucket of Object.values(buckets)) {
    if (!bucket || bucket.bucket_start_ms < periodStartMs || bucket.bucket_start_ms >= periodEndMs) {
      continue;
    }

    totalEvents += bucket.total_events;
    dataGatherCycles += bucket.data_gather_cycles;
    analystRuns += bucket.analyst_runs;
    premarketPlans += bucket.premarket_plans;
    breakingNewsAlerts += bucket.breaking_news_alerts;
    errors += bucket.errors;
    researchedSignals += bucket.researched_signals;
    buyVerdicts += bucket.buy_verdicts;
    skipVerdicts += bucket.skip_verdicts;
    waitVerdicts += bucket.wait_verdicts;
    executedBuys += bucket.executed_buys;
    executedSells += bucket.executed_sells;
    executedBuyNotional += bucket.executed_buy_notional;

    for (const [symbol, count] of Object.entries(bucket.symbol_counts || {})) {
      symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + count);
    }

    if (Array.isArray(bucket.recent_trades)) {
      recentTrades.push(
        ...bucket.recent_trades.filter((trade) => trade.timestamp >= periodStartMs && trade.timestamp < periodEndMs)
      );
    }
  }

  const topSymbols = Array.from(symbolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([symbol, count]) => ({ symbol, count }));

  recentTrades.sort((a, b) => b.timestamp - a.timestamp);

  return {
    periodStartMs,
    periodEndMs,
    totalEvents,
    dataGatherCycles,
    analystRuns,
    premarketPlans,
    breakingNewsAlerts,
    errors,
    researchedSignals,
    buyVerdicts,
    skipVerdicts,
    waitVerdicts,
    executedBuys,
    executedSells,
    executedBuyNotional,
    topSymbols,
    recentTrades: recentTrades.slice(0, 5).map((trade) => ({
      side: trade.side,
      symbol: trade.symbol,
      timestamp: new Date(trade.timestamp).toISOString(),
      reason: trade.reason,
      notional: trade.notional,
    })),
  };
}

export function summarizeDailyActivity(
  buckets: Record<string, DailyReportBucket>,
  nowMs = Date.now()
): DailyReportSummary {
  return summarizeDailyActivityWindow(buckets, nowMs - DAILY_REPORT_WINDOW_MS, nowMs);
}

export function formatDailyReportEmbed(
  summary: DailyReportSummary,
  account: Account | null,
  positions: Position[],
  previousSummary?: DailyReportSummary
) {
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  const formatDeltaNumber = (current: number, previous?: number) => {
    if (typeof previous !== "number") return null;
    const delta = current - previous;
    return `${delta >= 0 ? "+" : ""}${delta}`;
  };
  const formatDeltaCurrency = (current: number, previous?: number) => {
    if (typeof previous !== "number") return null;
    const delta = current - previous;
    if (delta === 0) return "$0";
    return `${delta > 0 ? "+" : "-"}${formatCurrency(Math.abs(delta))}`;
  };
  const formatDeltaPercent = (current: number, previous?: number) => {
    if (typeof previous !== "number" || previous <= 0) return null;
    const delta = ((current - previous) / previous) * 100;
    if (delta === 0) return "0.00%";
    return `${delta > 0 ? "+" : ""}${delta.toFixed(2)}%`;
  };
  const withDelta = (label: string, current: number, previous?: number) => {
    const delta = formatDeltaNumber(current, previous);
    return delta == null ? `${label} ${current}` : `${label} ${current} (Δ ${delta})`;
  };
  const portfolioDayChange =
    account && account.last_equity > 0
      ? `\nDay change ${formatDeltaCurrency(account.equity, account.last_equity)} / ${formatDeltaPercent(
          account.equity,
          account.last_equity
        )}`
      : "";

  const topSymbolsText =
    summary.topSymbols.length > 0
      ? summary.topSymbols.map(({ symbol, count }) => `${symbol} (${count})`).join(", ")
      : "None";

  const recentTradesText =
    summary.recentTrades.length > 0
      ? summary.recentTrades
          .map((trade) => {
            const reason = trade.reason ? ` • ${String(trade.reason).slice(0, 80)}` : "";
            const size =
              trade.side === "BUY" && typeof trade.notional === "number" ? ` • ${formatCurrency(trade.notional)}` : "";
            return `${trade.side} ${trade.symbol}${size}${reason}`;
          })
          .join("\n")
      : "No executed trades in the last 24 hours.";

  return {
    title: "📊 MAHORAGA Daily Report",
    color: 0x3b82f6,
    description: `Summary for the last 24 hours ending <t:${Math.floor(summary.periodEndMs / 1000)}:f>.`,
    fields: [
      {
        name: "Executed Trades",
        value:
          `BUY ${summary.executedBuys} / SELL ${summary.executedSells}` +
          (previousSummary
            ? `\nΔ BUY ${formatDeltaNumber(summary.executedBuys, previousSummary.executedBuys)} / SELL ${formatDeltaNumber(
                summary.executedSells,
                previousSummary.executedSells
              )}`
            : "") +
          (summary.executedBuyNotional > 0 || previousSummary
            ? `\nBuy notional ${formatCurrency(summary.executedBuyNotional)}${
                previousSummary
                  ? ` (Δ ${formatDeltaCurrency(summary.executedBuyNotional, previousSummary.executedBuyNotional)})`
                  : ""
              }`
            : ""),
        inline: true,
      },
      {
        name: "Research Outcomes",
        value:
          `BUY ${summary.buyVerdicts} / SKIP ${summary.skipVerdicts} / WAIT ${summary.waitVerdicts}` +
          (previousSummary
            ? `\nΔ BUY ${formatDeltaNumber(summary.buyVerdicts, previousSummary.buyVerdicts)} / SKIP ${formatDeltaNumber(
                summary.skipVerdicts,
                previousSummary.skipVerdicts
              )} / WAIT ${formatDeltaNumber(summary.waitVerdicts, previousSummary.waitVerdicts)}`
            : "") +
          `\n${withDelta("Researched", summary.researchedSignals, previousSummary?.researchedSignals)}`,
        inline: true,
      },
      {
        name: "Live Portfolio",
        value: account
          ? `${positions.length} positions\nEquity ${formatCurrency(account.equity)}${portfolioDayChange}\nCash ${formatCurrency(account.cash)}`
          : `${positions.length} positions\nAccount snapshot unavailable`,
        inline: true,
      },
      {
        name: "Bot Activity",
        value: `${withDelta("Data cycles", summary.dataGatherCycles, previousSummary?.dataGatherCycles)}\n${withDelta(
          "Analyst runs",
          summary.analystRuns,
          previousSummary?.analystRuns
        )}\n${withDelta("Premarket plans", summary.premarketPlans, previousSummary?.premarketPlans)}`,
        inline: true,
      },
      {
        name: "Alerts",
        value: `${withDelta("Breaking news", summary.breakingNewsAlerts, previousSummary?.breakingNewsAlerts)}\n${withDelta(
          "Errors",
          summary.errors,
          previousSummary?.errors
        )}\n${withDelta("Tracked events", summary.totalEvents, previousSummary?.totalEvents)}`,
        inline: true,
      },
      {
        name: "Top Symbols",
        value: topSymbolsText,
        inline: true,
      },
      {
        name: "Recent Trades",
        value: recentTradesText,
        inline: false,
      },
    ],
    timestamp: new Date(summary.periodEndMs).toISOString(),
    footer: { text: "MAHORAGA • Discord daily report" },
  };
}
