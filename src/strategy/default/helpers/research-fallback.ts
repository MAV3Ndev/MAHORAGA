import type { ResearchResult } from "../../../core/types";
import type { StrategyContext } from "../../types";

const STALE_CACHE_FALLBACK_MS = 6 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isLikelyLLMRateLimit(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("429") || message.includes("rate limit") || message.includes("fair usage");
}

export function canReuseStaleResearch(result: ResearchResult | null | undefined, now = Date.now()): boolean {
  if (!result) return false;
  return now - result.timestamp <= STALE_CACHE_FALLBACK_MS;
}

export function buildSignalFallbackResearch(
  ctx: StrategyContext,
  symbol: string,
  sentiment: number,
  sources: string[],
  reason: string
): ResearchResult {
  const sourceCount = new Set(sources.filter(Boolean)).size;
  const bullishSentiment = clamp(sentiment, 0, 1);
  const strongThreshold = Math.max(0.85, ctx.config.min_sentiment_score + 0.25);
  const supportedThreshold = Math.max(0.75, ctx.config.min_sentiment_score + 0.15);
  const watchThreshold = Math.max(0.55, ctx.config.min_sentiment_score);

  let verdict: ResearchResult["verdict"] = "SKIP";
  let confidence = clamp(bullishSentiment * 0.8, 0.2, 0.55);
  let entryQuality: ResearchResult["entry_quality"] = "poor";
  let reasoning = `${reason}; fallback skipped because the signal is not strong enough without LLM confirmation.`;

  if (bullishSentiment >= strongThreshold || (bullishSentiment >= supportedThreshold && sourceCount >= 2)) {
    verdict = "BUY";
    confidence = clamp(
      Math.max(ctx.config.min_analyst_confidence, 0.52 + bullishSentiment * 0.18 + Math.min(sourceCount, 3) * 0.03),
      ctx.config.min_analyst_confidence,
      0.78
    );
    entryQuality = bullishSentiment >= 0.9 ? "good" : "fair";
    reasoning = `${reason}; fallback BUY from strong social sentiment (${bullishSentiment.toFixed(2)}) across ${sourceCount} source(s).`;
  } else if (bullishSentiment >= watchThreshold) {
    verdict = "WAIT";
    confidence = clamp(bullishSentiment * 0.7, 0.35, 0.58);
    entryQuality = "fair";
    reasoning = `${reason}; fallback WAIT because sentiment is constructive but not strong enough for autonomous entry.`;
  }

  return {
    symbol,
    verdict,
    confidence,
    entry_quality: entryQuality,
    reasoning,
    red_flags: ["Fallback research used because the LLM was unavailable or rate-limited."],
    catalysts: sourceCount > 0 ? [`${sourceCount} active source(s) with bullish sentiment`] : [],
    timestamp: Date.now(),
  };
}

export function buildCryptoFallbackResearch(
  ctx: StrategyContext,
  symbol: string,
  momentum: number,
  sentiment: number,
  reason: string
): ResearchResult {
  const bullishMomentum = Math.max(momentum, 0);
  const bullishSentiment = clamp(sentiment, 0, 1);
  const threshold = Math.max(ctx.config.crypto_momentum_threshold || 2, 0.5);

  let verdict: ResearchResult["verdict"] = "SKIP";
  let confidence = clamp(bullishSentiment * 0.7, 0.2, 0.55);
  let entryQuality: ResearchResult["entry_quality"] = "poor";
  let reasoning = `${reason}; fallback skipped because momentum is below the configured crypto threshold.`;

  if (bullishMomentum >= threshold * 1.5 && bullishSentiment >= 0.55) {
    verdict = "BUY";
    confidence = clamp(
      Math.max(
        ctx.config.min_analyst_confidence,
        0.5 + Math.min(bullishMomentum / (threshold * 3), 0.18) + bullishSentiment * 0.12
      ),
      ctx.config.min_analyst_confidence,
      0.8
    );
    entryQuality = bullishMomentum >= threshold * 2 ? "good" : "fair";
    reasoning = `${reason}; fallback BUY from bullish crypto momentum (${bullishMomentum.toFixed(2)}%) and sentiment (${bullishSentiment.toFixed(2)}).`;
  } else if (bullishMomentum >= threshold && bullishSentiment >= 0.35) {
    verdict = "WAIT";
    confidence = clamp(bullishSentiment * 0.75, 0.35, 0.59);
    entryQuality = "fair";
    reasoning = `${reason}; fallback WAIT because momentum is positive but not strong enough for entry without LLM confirmation.`;
  }

  return {
    symbol,
    verdict,
    confidence,
    entry_quality: entryQuality,
    reasoning,
    red_flags: ["Fallback crypto research used because the LLM was unavailable or rate-limited."],
    catalysts:
      bullishMomentum > 0
        ? [`24h momentum ${bullishMomentum.toFixed(2)}%`, `sentiment ${bullishSentiment.toFixed(2)}`]
        : [],
    timestamp: Date.now(),
  };
}
