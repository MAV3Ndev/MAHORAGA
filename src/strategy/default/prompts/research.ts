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
 * social sentiment and price data.
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

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "brief reason",
  "red_flags": ["any concerns"],
  "catalysts": ["positive factors"]
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
  plPct: number
): PromptTemplate => ({
  system: "You are a position risk analyst. Be concise. Output valid JSON only.",
  user: `Analyze this position for risk and opportunity:

POSITION: ${symbol}
- Shares: ${position.qty}
- Market Value: $${position.market_value.toFixed(2)}
- P&L: $${position.unrealized_pl.toFixed(2)} (${plPct.toFixed(1)}%)
- Current Price: $${position.current_price}

Provide a brief risk assessment and recommendation (HOLD, SELL, or ADD). JSON format:
{
  "recommendation": "HOLD|SELL|ADD",
  "risk_level": "low|medium|high",
  "reasoning": "brief reason",
  "key_factors": ["factor1", "factor2"]
}`,
  maxTokens: 200,
});
