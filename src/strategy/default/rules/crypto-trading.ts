/**
 * Crypto trading rules — momentum-based crypto entry/exit via Alpaca.
 *
 * These are standalone helpers used by the core harness for crypto-specific logic.
 * The main selectEntries/selectExits handle stocks; crypto has its own flow
 * because it trades 24/7 outside of market hours.
 */

import type { Position, ResearchResult } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import { getCryptoSymbolAliases, isCryptoSymbol, normalizeCryptoSymbol } from "../helpers/crypto";
import type { StrategyContext } from "../../types";

/**
 * Research a crypto symbol for BUY/SKIP/WAIT verdict.
 * Includes retry logic for rate limit (429) errors.
 */
export async function researchCrypto(
  ctx: StrategyContext,
  symbol: string,
  momentum: number,
  sentiment: number
): Promise<ResearchResult | null> {
  ctx.log("Crypto", "research_start", { symbol, momentum, sentiment, has_llm: !!ctx.llm });

  if (!ctx.llm) {
    ctx.log("Crypto", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
    return null;
  }

  const alpaca = createAlpacaProviders(ctx.env);
  const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol).catch(() => null);
  const price = snapshot?.latest_trade?.price || 0;
  const dailyChange = snapshot
    ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100
    : 0;

  const prompt = `Should we BUY this cryptocurrency based on momentum and market conditions?

SYMBOL: ${symbol}
PRICE: $${price.toFixed(2)}
24H CHANGE: ${dailyChange.toFixed(2)}%
MOMENTUM SCORE: ${(momentum * 100).toFixed(0)}%
SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish

Evaluate if this is a good entry. Consider:
- Is the momentum sustainable or a trap?
- Any major news/events affecting this crypto?
- Risk/reward at current price level?

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "brief reason",
  "red_flags": ["any concerns"],
  "catalysts": ["positive factors"]
}`;

  const MAX_RETRIES = 3;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await ctx.llm.complete({
        model: ctx.config.llm_model,
        messages: [
          {
            role: "system",
            content:
              "You are a crypto analyst. Be skeptical of FOMO. Crypto is volatile - only recommend BUY for strong setups. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      });

      const usage = response.usage;
      if (usage) {
        ctx.trackLLMCost(ctx.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
      }

      const content = response.content || "{}";

      ctx.log("Crypto", "research_raw_response", {
        symbol,
        content_preview: content.substring(0, 200),
        content_length: content.length,
      });
      let analysis: {
        verdict: "BUY" | "SKIP" | "WAIT";
        confidence: number;
        entry_quality: "excellent" | "good" | "fair" | "poor";
        reasoning: string;
        red_flags?: string[];
        catalysts?: string[];
      };

      try {
        // Strip markdown code blocks and normalize whitespace
        let cleaned = content
          .replace(/```json\s*/gi, "")
          .replace(/```\s*$/gi, "")
          .replace(/```\s*/gi, "")
          .replace(/^[\n\r]+/, "")
          .trim();

        // Try to extract JSON object if content has extra text
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleaned = jsonMatch[0];
        }

        analysis = JSON.parse(cleaned);
      } catch (parseError) {
        ctx.log("Crypto", "research_parse_error", {
          symbol,
          attempt,
          content_preview: content.substring(0, 100),
          error: String(parseError),
        });
        // If parse fails, treat as SKIP with low confidence
        return {
          symbol,
          verdict: "SKIP",
          confidence: 0.1,
          entry_quality: "poor",
          reasoning: "LLM returned invalid JSON: " + content.substring(0, 50),
          red_flags: ["JSON parse failed"],
          catalysts: [],
          timestamp: Date.now(),
        };
      }

      // Validate verdict (case-insensitive)
      const receivedVerdict = analysis.verdict;
      const normalizedVerdict = receivedVerdict ? String(receivedVerdict).toUpperCase().trim() : null;
      if (!normalizedVerdict || !["BUY", "SKIP", "WAIT"].includes(normalizedVerdict)) {
        ctx.log("Crypto", "research_invalid_verdict", {
          symbol,
          received_verdict: receivedVerdict,
          received_type: typeof receivedVerdict,
          received_confidence: analysis.confidence,
          received_fields: Object.keys(analysis),
        });
        analysis.verdict = "SKIP";
        analysis.confidence = 0.1;
      } else {
        analysis.verdict = normalizedVerdict as "BUY" | "SKIP" | "WAIT";
      }

      const result: ResearchResult = {
        symbol,
        verdict: analysis.verdict,
        confidence: Math.max(0, Math.min(1, analysis.confidence || 0)),
        entry_quality: analysis.entry_quality || "fair",
        reasoning: analysis.reasoning || "No reasoning provided",
        red_flags: analysis.red_flags || [],
        catalysts: analysis.catalysts || [],
        timestamp: Date.now(),
      };

      ctx.log("Crypto", "researched", {
        symbol,
        verdict: result.verdict,
        confidence: result.confidence,
        quality: result.entry_quality,
        attempt,
      });

      return result;
    } catch (error) {
      lastError = String(error);
      const isRateLimit = lastError.includes("429") || lastError.includes("rate_limit");

      ctx.log("Crypto", "research_retry", {
        symbol,
        attempt,
        max_retries: MAX_RETRIES,
        is_rate_limit: isRateLimit,
        error: lastError.substring(0, 100),
      });

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        // Exponential backoff: 1s, 2s, 4s
        const backoffMs = Math.min(4000, 1000 * 2 ** attempt);
        await ctx.sleep(backoffMs);
        continue;
      }

      ctx.log("Crypto", "research_error", { symbol, error: lastError, attempt });
      return null;
    }
  }

  return null;
}

/**
 * Run crypto-specific trading loop: check exits, then entries.
 * Called from the core harness when crypto_enabled is true.
 */
export async function runCryptoTrading(ctx: StrategyContext, positions: Position[]): Promise<void> {
  if (!ctx.config.crypto_enabled) return;

  const cryptoPositions = positions.filter((p) => isCryptoSymbol(p.symbol, ctx.config.crypto_symbols || []));
  const heldCrypto = new Set(cryptoPositions.flatMap((p) => getCryptoSymbolAliases(p.symbol)));

  // Check exits
  for (const pos of cryptoPositions) {
    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    if (plPct >= ctx.config.crypto_take_profit_pct) {
      ctx.log("Crypto", "take_profit", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await ctx.broker.sell(pos.symbol, `Crypto take profit at +${plPct.toFixed(1)}%`);
      continue;
    }

    if (plPct <= -ctx.config.crypto_stop_loss_pct) {
      ctx.log("Crypto", "stop_loss", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await ctx.broker.sell(pos.symbol, `Crypto stop loss at ${plPct.toFixed(1)}%`);
    }
  }

  // Check entries
  const maxCryptoPositions = Math.min(ctx.config.crypto_symbols?.length || 3, 3);
  if (cryptoPositions.length >= maxCryptoPositions) return;

  const cryptoSignals = ctx.signals
    .filter((s) => s.isCrypto)
    .filter((s) => !heldCrypto.has(s.symbol))
    .filter((s) => s.sentiment > 0)
    .sort((a, b) => (b.momentum || 0) - (a.momentum || 0));

  ctx.log("Crypto", "run_start", {
    total_signals: ctx.signals.length,
    crypto_signals: cryptoSignals.length,
    held_crypto: Array.from(heldCrypto),
    has_llm: !!ctx.llm,
    crypto_enabled: ctx.config.crypto_enabled,
  });

  const CRYPTO_RESEARCH_TTL_MS = 300_000;

  for (const signal of cryptoSignals.slice(0, 2)) {
    if (cryptoPositions.length >= maxCryptoPositions) break;

    const cachedResearch = ctx.state.get<ResearchResult>(`cryptoResearch_${signal.symbol}`);
    const cacheAge = cachedResearch ? Date.now() - cachedResearch.timestamp : null;
    // Cache is valid if: has cache AND (fresh OR not a failure)
    const isFailure = cachedResearch && (cachedResearch.verdict === "SKIP" && cachedResearch.confidence < 0.2);
    const isCacheFresh = cachedResearch && cacheAge !== null && cacheAge < CRYPTO_RESEARCH_TTL_MS && !isFailure;

    ctx.log("Crypto", "research_cache_check", {
      symbol: signal.symbol,
      has_cache: !!cachedResearch,
      cache_age_ms: cacheAge,
      is_fresh: isCacheFresh,
      is_failure: isFailure,
      cached_verdict: cachedResearch?.verdict,
      cached_confidence: cachedResearch?.confidence,
    });

    let research: ResearchResult | null = cachedResearch ?? null;

    if (!cachedResearch || !isCacheFresh) {
      research = await researchCrypto(ctx, signal.symbol, signal.momentum || 0, signal.sentiment);
      // Only cache successful results (BUY or SKIP with reasonable confidence)
      if (research && (research.verdict === "BUY" || research.confidence >= 0.2)) {
        ctx.state.set(`cryptoResearch_${signal.symbol}`, research);
      }
    }

    if (!research || research.verdict !== "BUY") {
      ctx.log("Crypto", "research_skip", {
        symbol: signal.symbol,
        verdict: research?.verdict || "NO_RESEARCH",
        confidence: research?.confidence || 0,
      });
      continue;
    }

    if (research.confidence < ctx.config.min_analyst_confidence) {
      ctx.log("Crypto", "low_confidence", { symbol: signal.symbol, confidence: research.confidence });
      continue;
    }

    const account = await ctx.broker.getAccount();
    const sizePct = Math.min(20, ctx.config.position_size_pct_of_cash);
    const positionSize = Math.min(
      account.cash * (sizePct / 100) * research.confidence,
      ctx.config.crypto_max_position_value
    );

    if (positionSize < 10) {
      ctx.log("Crypto", "buy_skipped", { symbol: signal.symbol, reason: "Position too small" });
      continue;
    }

    const result = await ctx.broker.buy(signal.symbol, positionSize, `Crypto momentum: ${research.reasoning}`);
    if (result) {
      for (const alias of getCryptoSymbolAliases(signal.symbol)) {
        heldCrypto.add(alias);
      }
      cryptoPositions.push({ symbol: normalizeCryptoSymbol(signal.symbol) } as Position);
      break;
    }
  }
}
