export type TradeOutcome = "win" | "loss" | "scratch";

export interface TradeOutcomeInput {
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryAt?: string | null;
  nowMs?: number;
}

export interface TradeOutcomeResult {
  exitPrice: number;
  pnlUsd: number;
  pnlPct: number;
  holdDurationMins: number;
  outcome: TradeOutcome;
}

export function calculateTradeOutcome(input: TradeOutcomeInput): TradeOutcomeResult | null {
  const entryPrice = Number(input.entryPrice);
  const exitPrice = Number(input.exitPrice);
  const qty = Number(input.qty);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const pnlUsd = (exitPrice - entryPrice) * qty;
  const costBasis = entryPrice * qty;
  const pnlPct = costBasis !== 0 ? (pnlUsd / costBasis) * 100 : 0;
  const entryAtMs = input.entryAt ? new Date(input.entryAt).getTime() : NaN;
  const nowMs = input.nowMs ?? Date.now();
  const holdDurationMins = Number.isFinite(entryAtMs) ? Math.max(0, Math.round((nowMs - entryAtMs) / 60000)) : 0;
  const outcome = pnlUsd > 0 ? "win" : pnlUsd < 0 ? "loss" : "scratch";

  return {
    exitPrice,
    pnlUsd,
    pnlPct,
    holdDurationMins,
    outcome,
  };
}
