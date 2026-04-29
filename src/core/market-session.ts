import type { MarketClock } from "./types";

export const SIGNAL_RESEARCH_INTERVAL_MS = 120_000;
export const POSITION_RESEARCH_INTERVAL_MS = 300_000;

export interface MarketSessionState {
  clockNowMs: number;
  nextOpenMs: number;
  nextOpenValid: boolean;
  hasOpenMs: boolean;
  withinOpenExecutionWindow: boolean;
  marketJustOpened: boolean;
  clockStateUnknown: boolean;
}

export function shouldRunInterval(nowMs: number, lastRunMs: number, intervalMs: number): boolean {
  return nowMs - lastRunMs >= intervalMs;
}

export function getClockNowMs(clock: MarketClock, fallbackNowMs: number): number {
  const parsed = new Date(clock.timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : fallbackNowMs;
}

export function buildMarketSessionState(params: {
  clock: MarketClock;
  nowMs: number;
  lastKnownNextOpenMs: number | null;
  lastClockIsOpen: boolean | null;
  marketOpenExecuteWindowMinutes: number;
}): MarketSessionState {
  const clockNowMs = getClockNowMs(params.clock, params.nowMs);
  const nextOpenMs = new Date(params.clock.next_open).getTime();
  const nextOpenValid = Number.isFinite(nextOpenMs);
  const hasOpenMs = typeof params.lastKnownNextOpenMs === "number" && Number.isFinite(params.lastKnownNextOpenMs);
  const openWindowMs = params.marketOpenExecuteWindowMinutes * 60_000;

  return {
    clockNowMs,
    nextOpenMs,
    nextOpenValid,
    hasOpenMs,
    withinOpenExecutionWindow:
      hasOpenMs &&
      clockNowMs >= params.lastKnownNextOpenMs! &&
      clockNowMs - params.lastKnownNextOpenMs! <= openWindowMs,
    marketJustOpened: params.lastClockIsOpen === false && params.clock.is_open,
    clockStateUnknown: params.lastClockIsOpen == null,
  };
}

export function shouldClearPremarketPlan(params: {
  hasPremarketPlan: boolean;
  lastPremarketPlanDayEt: string | null;
  currentEtDay: string;
}): boolean {
  return (
    params.hasPremarketPlan && !!params.lastPremarketPlanDayEt && params.lastPremarketPlanDayEt !== params.currentEtDay
  );
}

export function shouldCreatePremarketPlan(params: {
  clock: MarketClock;
  session: MarketSessionState;
  hasPremarketPlan: boolean;
  premarketPlanWindowMinutes: number;
  lastPremarketPlanDayEt: string | null;
  currentEtDay: string;
}): boolean {
  if (params.clock.is_open || params.hasPremarketPlan || !params.session.nextOpenValid) {
    return false;
  }

  const minutesToOpen = (params.session.nextOpenMs - params.session.clockNowMs) / 60_000;
  return (
    minutesToOpen > 0 &&
    minutesToOpen <= params.premarketPlanWindowMinutes &&
    params.lastPremarketPlanDayEt !== params.currentEtDay
  );
}

export function shouldExecutePremarketPlan(params: {
  hasPremarketPlan: boolean;
  session: MarketSessionState;
}): boolean {
  return (
    params.hasPremarketPlan &&
    ((params.session.hasOpenMs && params.session.withinOpenExecutionWindow) ||
      params.session.marketJustOpened ||
      (!params.session.hasOpenMs && params.session.clockStateUnknown))
  );
}
