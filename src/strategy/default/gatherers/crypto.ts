/**
 * Crypto momentum gatherer — price-based signals from Alpaca crypto snapshots.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";

async function gatherCrypto(ctx: StrategyContext): Promise<Signal[]> {
  if (!ctx.config.crypto_enabled) return [];

  const signals: Signal[] = [];
  const symbols = ctx.config.crypto_symbols || ["BTC/USD", "ETH/USD", "SOL/USD"];
  const alpaca = createAlpacaProviders(ctx.env);

  for (const symbol of symbols) {
    try {
      const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol);
      if (!snapshot) continue;

      const price = snapshot.latest_trade?.price || 0;
      const prevClose = snapshot.prev_daily_bar?.c || 0;

      if (!price || !prevClose) continue;

      const momentum = ((price - prevClose) / prevClose) * 100;
      const threshold = ctx.config.crypto_momentum_threshold || 2.0;
      const hasSignificantMove = Math.abs(momentum) >= threshold;
      const isBullish = momentum > 0;
      if (!hasSignificantMove) continue;

      const rawSentiment = Math.min(Math.abs(momentum) / 5, 1) * (isBullish ? 1 : -1);
      const qualityScore = Math.min(1, Math.abs(momentum) / (threshold * 2));

      signals.push({
        symbol,
        source: "crypto",
        source_detail: "crypto_momentum",
        sentiment: rawSentiment * 0.8,
        raw_sentiment: rawSentiment,
        volume: snapshot.daily_bar?.v || 0,
        freshness: 1.0,
        source_weight: 0.8,
        quality_score: qualityScore,
        reason: `Crypto: ${momentum >= 0 ? "+" : ""}${momentum.toFixed(2)}% (24h)`,
        bullish: isBullish ? 1 : 0,
        bearish: isBullish ? 0 : 1,
        isCrypto: true,
        momentum,
        price,
        timestamp: Date.now(),
      });

      await ctx.sleep(200);
    } catch (error) {
      ctx.log("Crypto", "error", { symbol, message: String(error) });
    }
  }

  ctx.log("Crypto", "gathered_signals", { count: signals.length });
  return signals;
}

export const cryptoGatherer: Gatherer = {
  name: "crypto",
  gather: gatherCrypto,
};
