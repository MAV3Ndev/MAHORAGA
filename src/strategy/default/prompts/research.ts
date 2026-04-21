/**
 * Research prompt builders — signal and position analysis.
 *
 * These return PromptTemplate objects. The core harness makes the LLM call.
 */

import type { Position } from "../../../core/types";
import type { PromptTemplate, ResearchPositionPromptBuilder, ResearchSignalPromptBuilder, StrategyContext } from "../../types";

/**
 * Signal research prompt — evaluate whether to BUY a symbol based on
 * social sentiment, technical indicators, and fundamental catalysts.
 */
export const researchSignalPrompt: ResearchSignalPromptBuilder = (
  symbol: string,
  sentiment: number,
  sources: string[],
  price: number,
  ctx
): PromptTemplate => {
  // Extract technical data from state cache if available
  const technicalData = getTechnicalDataFromCache(symbol, ctx);
  const momentumData = getMomentumDataFromCache(symbol, ctx);

  return {
    system:
      "You are a stock research analyst. Be skeptical of hype, but be decisive when the setup is actionable. Use BUY when risk/reward is favorable now, SKIP for bad setups, and WAIT only for watchlist-worthy names that need a better trigger. Output valid JSON only.",
    user: `Should we BUY this stock? Provide a thorough analysis considering social sentiment, technical setup, and catalysts.

SYMBOL: ${symbol}
SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish (sources: ${sources.join(", ")})

CURRENT DATA:
- Price: $${price}
${technicalData}
${momentumData}

EVALUATION CRITERIA:
1. ENTRY QUALITY: Is this a pullback entry or a breakout? RSI 40-55 suggests pullback, >70 overbought
2. CATALYSTS: Any upcoming earnings, FDA decisions, partnerships, or news?
3. TREND: Is price above key SMAs (20, 50)? Is it in an uptrend?
4. MOMENTUM: Recent price action and volume trends
5. RISK: Red flags, dilution, regulatory concerns?

DECISION GUIDANCE:
- Use BUY if the setup is actionable now and the thesis is strong enough to enter immediately
- Use WAIT only if the idea is interesting but the current entry is not good enough yet
- Use SKIP for noisy, low-quality, illiquid, or obviously speculative setups
- Be stricter on meme tokens, non-tradable symbols, and unclear catalysts

Provide your analysis with these exact JSON fields:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "2-3 sentence detailed reasoning",
  "red_flags": ["concern 1", "concern 2"],
  "catalysts": ["catalyst 1", "catalyst 2"],
  "recommended_entry_zone": "Description of ideal entry price range",
  "stop_loss_pct": number (recommended stop loss as % from entry),
  "take_profit_pct": number (recommended take profit as % from entry)
}`,
    model: ctx.config.llm_analyst_model,
    maxTokens: 400,
  };
};

/**
 * Position research prompt — risk assessment for a held position.
 */
export const researchPositionPrompt: ResearchPositionPromptBuilder = (
  symbol: string,
  position: Position,
  plPct: number,
  ctx
): PromptTemplate => {
  // Extract trailing stop and advanced exit info
  const advancedState = ctx.state.get<Record<string, unknown>>("advancedExitState");
  const posAdvanced = advancedState?.[symbol];

  return {
    system: "You are a position risk analyst. Be concise but thorough. Output valid JSON only.",
    user: `Analyze this position for risk and opportunity:

POSITION: ${symbol}
- Shares: ${position.qty}
- Market Value: $${position.market_value.toFixed(2)}
- P&L: $${position.unrealized_pl.toFixed(2)} (${plPct.toFixed(1)}%)
- Current Price: $${position.current_price}
${posAdvanced ? `- Trailing Stop Active: ${(posAdvanced as {trailingActive: boolean}).trailingActive ? "YES" : "NO"}` : ""}
${posAdvanced ? `- Dynamic TP: ${(posAdvanced as {dynamicTpPct: number}).dynamicTpPct?.toFixed(1) ?? "N/A"}%` : ""}

Provide a risk assessment with these exact JSON fields:
{
  "recommendation": "HOLD|SELL|ADD",
  "risk_level": "low|medium|high",
  "reasoning": "2-3 sentence detailed reasoning",
  "key_factors": ["factor 1", "factor 2", "factor 3"],
  "exit_strategy": "Description of recommended exit approach"
}`,
    model: ctx.config.llm_analyst_model,
    maxTokens: 250,
  };
};

/**
 * Get technical data from state cache.
 */
function getTechnicalDataFromCache(symbol: string, ctx: StrategyContext): string {
  interface TechnicalDataCache {
    current_price?: number;
    rsi?: number;
    bb_lower?: number;
    bb_middle?: number;
    sma_20?: number;
    sma_50?: number;
    atr?: number;
  }

  const techCache = ctx.state.get<Record<string, TechnicalDataCache>>("technicalDataCache");
  const tech = techCache?.[symbol];

  if (!tech) {
    return "TECHNICAL DATA: Not available (will use defaults)";
  }

  const lines: string[] = [];
  if (tech.current_price !== undefined) lines.push(`- Current Price: $${tech.current_price.toFixed(2)}`);
  if (tech.rsi !== undefined) lines.push(`- RSI: ${tech.rsi.toFixed(1)}`);
  if (tech.bb_lower !== undefined) lines.push(`- Bollinger Lower: $${tech.bb_lower.toFixed(2)}`);
  if (tech.bb_middle !== undefined) lines.push(`- Bollinger Mid: $${tech.bb_middle.toFixed(2)}`);
  if (tech.sma_20 !== undefined) lines.push(`- SMA 20: $${tech.sma_20.toFixed(2)}`);
  if (tech.sma_50 !== undefined) lines.push(`- SMA 50: $${tech.sma_50.toFixed(2)}`);
  if (tech.atr !== undefined) lines.push(`- ATR: $${tech.atr.toFixed(2)}`);

  if (lines.length === 0) {
    return "TECHNICAL DATA: Not available";
  }

  return "TECHNICAL DATA:\n" + lines.join("\n");
}

/**
 * Get momentum data from state cache.
 */
function getMomentumDataFromCache(symbol: string, ctx: StrategyContext): string {
  interface MomentumDataCache {
    price_change_1h?: number;
    price_change_24h?: number;
    volume_change?: number;
  }

  const momentumCache = ctx.state.get<Record<string, MomentumDataCache>>("momentumDataCache");
  const momentum = momentumCache?.[symbol];

  if (!momentum) {
    return "MOMENTUM DATA: Not available";
  }

  const lines: string[] = [];
  if (momentum.price_change_1h !== undefined) lines.push(`- 1h Price Change: ${momentum.price_change_1h.toFixed(2)}%`);
  if (momentum.price_change_24h !== undefined) lines.push(`- 24h Price Change: ${momentum.price_change_24h.toFixed(2)}%`);
  if (momentum.volume_change !== undefined) lines.push(`- Volume Change: ${momentum.volume_change.toFixed(1)}x`);

  if (lines.length === 0) {
    return "MOMENTUM DATA: Not available";
  }

  return "MOMENTUM DATA:\n" + lines.join("\n");
}
