export interface RiskSizingInput {
  cash: number;
  maxPositionValue: number;
  confidence: number;
  positionSizePctOfCash: number;
  riskPerTradePct: number;
  stopLossPct: number;
  entryPrice?: number;
  atr?: number;
  regimeMultiplier?: number;
}

export interface RiskSizingResult {
  notional: number;
  cashBudgetNotional: number;
  riskBudgetNotional: number;
  stopDistancePct: number;
  riskBudget: number;
}

export function computeRiskSizedNotional(input: RiskSizingInput): RiskSizingResult {
  const confidence = clamp(input.confidence, 0, 1);
  const regimeMultiplier = clamp(input.regimeMultiplier ?? 1, 0, 1);
  const cashBudgetNotional = input.cash * (input.positionSizePctOfCash / 100) * confidence;
  const riskBudget = input.cash * (input.riskPerTradePct / 100);
  const stopDistancePct = calculateStopDistancePct(input.stopLossPct, input.entryPrice, input.atr);
  const riskBudgetNotional = stopDistancePct > 0 ? riskBudget / (stopDistancePct / 100) : input.maxPositionValue;
  const rawNotional = Math.min(cashBudgetNotional, riskBudgetNotional, input.maxPositionValue);

  return {
    notional: Math.max(0, rawNotional * regimeMultiplier),
    cashBudgetNotional,
    riskBudgetNotional,
    stopDistancePct,
    riskBudget,
  };
}

export function calculateStopDistancePct(stopLossPct: number, entryPrice?: number, atr?: number): number {
  const configuredStop = Math.max(0.01, stopLossPct);
  if (!entryPrice || entryPrice <= 0 || !atr || atr <= 0) return configuredStop;

  const atrPct = (atr / entryPrice) * 100;
  return Math.max(configuredStop, atrPct);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
