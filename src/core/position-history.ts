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
    period === "5Min" || period === "1H"
      ? [preferredTimeframe, "1Min", "5Min", "15Min"]
      : period === "6H"
        ? [preferredTimeframe, "5Min", "15Min", "1Hour"]
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
