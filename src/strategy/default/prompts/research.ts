/**
 * Research prompt builders — signal and position analysis.
 *
 * These return PromptTemplate objects. The core harness makes the LLM call.
 */

import type { Position, Signal } from "../../../core/types";
import type { PromptTemplate, ResearchPositionPromptBuilder, ResearchSignalPromptBuilder } from "../../types";

function normalizePromptSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/[\s/._-]/g, "");
}

function formatPercent(value: number | undefined): string {
  return Number.isFinite(value) ? `${((value ?? 0) * 100).toFixed(0)}%` : "n/a";
}

function signalEvidenceLines(symbol: string, signals: Signal[]): string {
  const symbolKey = normalizePromptSymbol(symbol);
  const matching = signals
    .filter((signal) => normalizePromptSymbol(signal.symbol) === symbolKey)
    .sort((a, b) => Math.abs(b.sentiment) * Math.max(1, b.volume) - Math.abs(a.sentiment) * Math.max(1, a.volume))
    .slice(0, 8);

  if (matching.length === 0) {
    return "- No per-source signal details were available for this symbol.";
  }

  return matching
    .map((signal, index) => {
      const votes =
        signal.bullish !== undefined || signal.bearish !== undefined
          ? `, votes=${signal.bullish ?? 0}B/${signal.bearish ?? 0}b`
          : "";
      const quality = signal.quality_score !== undefined ? `, quality=${formatPercent(signal.quality_score)}` : "";
      const freshness = signal.freshness !== undefined ? `, freshness=${formatPercent(signal.freshness)}` : "";
      const reason = signal.reason ? `, reason="${signal.reason.slice(0, 180)}"` : "";
      return `${index + 1}. ${signal.source}:${signal.source_detail} sentiment=${formatPercent(signal.sentiment)}, volume=${signal.volume}${votes}${quality}${freshness}${reason}`;
    })
    .join("\n");
}

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
  const evidence = signalEvidenceLines(symbol, ctx.signals);

  return {
    system:
      "You are a stock research analyst. Be skeptical of hype, but use the provided source evidence instead of treating missing context as proof against the setup. Only recommend BUY for strong, timely setups with clear catalysts, good/excellent entry quality, and no material red flags. Output valid JSON only.",
    user: `Should we BUY this stock based on social sentiment and fundamentals?

SYMBOL: ${symbol}
SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish (sources: ${sources.join(", ")})

CURRENT DATA:
- Price: $${price}
${technicalData}
${momentumData}

SOURCE EVIDENCE:
${evidence}

Evaluate if this is a good entry. Consider:
- Is the sentiment justified by specific catalysts, not only crowd enthusiasm?
- Is it too late, already pumped, illiquid, or vulnerable to reversal?
- Are there red flags such as weak source quality, no clear catalyst, valuation/news risk, or one-sided social hype?
- Treat SEC filings, high-quality Reddit DD, multiple independent sources, or strong fresh StockTwits breadth as possible catalysts only when the evidence lines support them.
- Do not invent catalysts not supported by SOURCE EVIDENCE.
- Do not recommend BUY unless entry_quality is "good" or "excellent".
- A BUY must include at least one concrete catalyst and should have an empty red_flags array.

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
    maxTokens: 250,
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
${posAdvanced ? `- Trailing Stop Active: ${(posAdvanced as { trailingActive: boolean }).trailingActive ? "YES" : "NO"}` : ""}
${posAdvanced ? `- Dynamic TP: ${(posAdvanced as { dynamicTpPct: number }).dynamicTpPct?.toFixed(1) ?? "N/A"}%` : ""}

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
  if (momentum.price_change_24h !== undefined)
    lines.push(`- 24h Price Change: ${momentum.price_change_24h.toFixed(2)}%`);
  if (momentum.volume_change !== undefined) lines.push(`- Volume Change: ${momentum.volume_change.toFixed(1)}x`);

  if (lines.length === 0) {
    return "MOMENTUM DATA: Not available";
  }

  return "MOMENTUM DATA:\n" + lines.join("\n");
}
