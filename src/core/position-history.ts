import type { Bar, PortfolioHistory, PortfolioHistoryParams } from "../providers/types";

const PORTFOLIO_HISTORY_INTRADAY_REPORTING_VALUES = new Set(["market_hours", "extended_hours", "continuous"]);

export interface PortfolioHistorySnapshot {
  timestamp: number;
  equity: number;
  pl: number;
  pl_pct: number;
}

export interface PortfolioHistoryPayload {
  snapshots: PortfolioHistorySnapshot[];
  base_value: number;
  timeframe: string;
}

export interface PositionHistoryPoint {
  timestamp: number;
  price: number;
  change_pct: number;
}

export interface BuildPositionHistoryPointsParams {
  bars: Pick<Bar, "t" | "c">[];
  side: "long" | "short";
  entryTime: number;
  entryPrice: number;
  terminalTime: number;
  terminalPrice?: number;
}

function getPositionChangePct(side: "long" | "short", entryPrice: number, price: number): number {
  const changePct =
    side === "short" ? ((entryPrice - price) / entryPrice) * 100 : ((price - entryPrice) / entryPrice) * 100;

  return Number.isFinite(changePct) ? changePct : 0;
}

function dedupePositionHistoryPoints(points: PositionHistoryPoint[]): PositionHistoryPoint[] {
  return points
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((point, index, items) => index === 0 || items[index - 1]!.timestamp !== point.timestamp);
}

export function buildPortfolioHistoryParams(searchParams: URLSearchParams): PortfolioHistoryParams {
  const period = searchParams.get("period") || "1M";
  const requestedTimeframe = searchParams.get("timeframe") || "1D";
  const intradayReporting = searchParams.get("intraday_reporting") || "extended_hours";

  return {
    period,
    timeframe: normalizePortfolioHistoryTimeframe(period, requestedTimeframe),
    intraday_reporting: PORTFOLIO_HISTORY_INTRADAY_REPORTING_VALUES.has(intradayReporting)
      ? (intradayReporting as NonNullable<PortfolioHistoryParams["intraday_reporting"]>)
      : "extended_hours",
  };
}

export function buildPortfolioHistoryPayload(history: PortfolioHistory): PortfolioHistoryPayload {
  const snapshots: PortfolioHistorySnapshot[] = [];

  for (let i = 0; i < history.timestamp.length; i += 1) {
    const ts = history.timestamp[i];
    const equity = history.equity[i];
    const pl = history.profit_loss[i];
    const plPct = history.profit_loss_pct[i];

    if (ts === undefined || equity === undefined || pl === undefined || plPct === undefined) {
      continue;
    }

    snapshots.push({
      timestamp: ts * 1000,
      equity,
      pl,
      pl_pct: plPct,
    });
  }

  return {
    snapshots,
    base_value: history.base_value,
    timeframe: history.timeframe,
  };
}

export function buildPositionHistoryPoints({
  bars,
  side,
  entryTime,
  entryPrice,
  terminalTime,
  terminalPrice,
}: BuildPositionHistoryPointsParams): PositionHistoryPoint[] {
  const points = bars
    .map((bar) => {
      const timestamp = new Date(bar.t).getTime();
      if (!Number.isFinite(timestamp)) return null;

      return {
        timestamp,
        price: bar.c,
        change_pct: getPositionChangePct(side, entryPrice, bar.c),
      };
    })
    .filter((point): point is PositionHistoryPoint => point !== null);

  const firstPoint = points[0];
  if (!firstPoint || firstPoint.timestamp > entryTime) {
    points.unshift({
      timestamp: entryTime,
      price: entryPrice,
      change_pct: 0,
    });
  } else if (points.length > 0) {
    points[0] = {
      price: points[0]!.price,
      timestamp: entryTime,
      change_pct: 0,
    };
  }

  if (terminalPrice && points.length > 0) {
    const terminalChange = getPositionChangePct(side, entryPrice, terminalPrice);
    const lastPoint = points[points.length - 1];

    if (!lastPoint || Math.abs(lastPoint.timestamp - terminalTime) > 60_000) {
      points.push({
        timestamp: terminalTime,
        price: terminalPrice,
        change_pct: terminalChange,
      });
    } else {
      lastPoint.timestamp = terminalTime;
      lastPoint.price = terminalPrice;
      lastPoint.change_pct = terminalChange;
    }
  }

  return dedupePositionHistoryPoints(points);
}

export function normalizePortfolioHistoryTimeframe(period: string, timeframe: string): string {
  const normalizedPeriod = period.trim().toUpperCase();
  const normalizedTimeframe = timeframe.trim();
  const dayMatch = normalizedPeriod.match(/^(\d+)D$/);
  const dayCount = dayMatch ? Number.parseInt(dayMatch[1] || "0", 10) : null;

  if (dayCount !== null && Number.isFinite(dayCount) && dayCount >= 30) {
    if (normalizedTimeframe === "1H" || normalizedTimeframe === "1Hour") {
      return "1D";
    }
  }

  return normalizedTimeframe;
}

export function getPeriodStartMs(period: string, nowMs: number): number {
  switch (period) {
    case "5Min":
      return nowMs - 5 * 60 * 1000;
    case "1H":
      return nowMs - 60 * 60 * 1000;
    case "6H":
      return nowMs - 6 * 60 * 60 * 1000;
    case "1D":
      return nowMs - 24 * 60 * 60 * 1000;
    case "7D":
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case "30D":
      return nowMs - 30 * 24 * 60 * 60 * 1000;
    default:
      return nowMs - 7 * 24 * 60 * 60 * 1000;
  }
}

export function getPositionHistoryTimeframeCandidates(period: string, preferredTimeframe: string): string[] {
  const candidates =
    period === "6H"
      ? ["5Min"]
      : period === "5Min" || period === "1H"
        ? [preferredTimeframe, "1Min", "5Min", "15Min"]
        : period === "1D"
          ? [preferredTimeframe, "5Min", "15Min", "1Hour"]
          : period === "7D"
            ? [preferredTimeframe, "15Min", "1Hour", "1Day"]
            : [preferredTimeframe, "1Hour", "1Day"];

  return [...new Set(candidates)];
}

export function getPositionHistoryLimit(period: string, timeframe: string): number {
  if (timeframe === "1Min") return period === "5Min" ? 12 : period === "1H" ? 90 : 400;
  if (timeframe === "5Min") return period === "1D" ? 288 : 500;
  if (timeframe === "15Min") return period === "1D" ? 120 : 400;
  if (timeframe === "1Hour") return period === "30D" ? 500 : 300;
  if (timeframe === "1Day") return 180;
  return period === "1D" ? 120 : period === "7D" ? 240 : 180;
}

export function getPositionHistoryTimeframeMs(timeframe: string): number {
  if (timeframe === "1Min") return 60_000;
  if (timeframe === "5Min") return 5 * 60_000;
  if (timeframe === "15Min") return 15 * 60_000;
  if (timeframe === "1Hour") return 60 * 60_000;
  if (timeframe === "1Day") return 24 * 60 * 60_000;
  return 60 * 60_000;
}
