/**
 * GDELT gatherer — broad market news catalyst detection.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { calculateTimeDecay, detectSentiment } from "../helpers/sentiment";
import { extractTickers, tickerCache } from "../helpers/ticker";

const GDELT_CACHE_KEY = "gdeltNewsCache";
const GDELT_COOLDOWN_KEY = "gdeltNewsCooldownUntil";
const GDELT_CACHE_TTL_MS = 30 * 60_000;
const GDELT_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const GDELT_ERROR_COOLDOWN_MS = 15 * 60_000;

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  sourceCountry?: string;
  domain?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

interface GdeltCache {
  timestamp: number;
  articles: GdeltArticle[];
}

const MARKET_MOVING_TERMS = [
  "earnings",
  "guidance",
  "upgrade",
  "downgrade",
  "merger",
  "acquisition",
  "buyout",
  "fda",
  "approval",
  "investigation",
  "lawsuit",
  "layoffs",
  "bankruptcy",
  "offering",
  "contract",
  "partnership",
  "recall",
  "short seller",
];

function gdeltDateToTimestamp(value?: string): number {
  if (!value) return Date.now();
  const compact = value.replace(/\D/g, "");
  if (compact.length < 14) return Date.now();
  return Date.UTC(
    Number(compact.slice(0, 4)),
    Number(compact.slice(4, 6)) - 1,
    Number(compact.slice(6, 8)),
    Number(compact.slice(8, 10)),
    Number(compact.slice(10, 12)),
    Number(compact.slice(12, 14))
  );
}

async function fetchGdeltArticles(ctx: StrategyContext): Promise<GdeltArticle[]> {
  const cooldownUntil = ctx.state.get<number>(GDELT_COOLDOWN_KEY) ?? 0;
  if (Date.now() < cooldownUntil) {
    ctx.log("GDELT", "cooldown_active", { retry_after_ms: cooldownUntil - Date.now() });
    return [];
  }

  const cached = ctx.state.get<GdeltCache>(GDELT_CACHE_KEY);
  if (cached && Date.now() - cached.timestamp < GDELT_CACHE_TTL_MS) {
    ctx.log("GDELT", "news_cache_hit", { articles: cached.articles.length });
    return cached.articles;
  }

  const query = `(${MARKET_MOVING_TERMS.map((term) => `"${term}"`).join(" OR ")}) sourcecountry:US`;
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    sort: "hybridrel",
    maxrecords: "25",
    timespan: "12h",
  });

  const response = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    ctx.log("GDELT", "fetch_error", { status: response.status });
    ctx.state.set(
      GDELT_COOLDOWN_KEY,
      Date.now() + (response.status === 429 ? GDELT_RATE_LIMIT_COOLDOWN_MS : GDELT_ERROR_COOLDOWN_MS)
    );
    return [];
  }

  const data = (await response.json()) as GdeltResponse;
  const articles = data.articles || [];
  ctx.state.set<GdeltCache>(GDELT_CACHE_KEY, { timestamp: Date.now(), articles });
  ctx.log("GDELT", "news_fetched", { articles: articles.length });
  return articles;
}

async function gatherGdelt(ctx: StrategyContext): Promise<Signal[]> {
  try {
    const articles = await fetchGdeltArticles(ctx);
    const alpaca = createAlpacaProviders(ctx.env);
    const byTicker = new Map<
      string,
      {
        weightedSentiment: number;
        weight: number;
        articles: number;
        title?: string;
        latestSeen: number;
      }
    >();

    for (const article of articles) {
      const title = article.title || "";
      if (!title) continue;
      const lowerTitle = title.toLowerCase();
      const catalystHits = MARKET_MOVING_TERMS.filter((term) => lowerTitle.includes(term)).length;
      if (catalystHits === 0) continue;

      const seenAt = gdeltDateToTimestamp(article.seendate);
      const freshness = calculateTimeDecay(Math.floor(seenAt / 1000));
      const sentiment = detectSentiment(title);
      const fallbackSentiment = catalystHits >= 2 ? 0.22 : 0.16;
      const rawSentiment = Math.abs(sentiment) > 0.05 ? sentiment : fallbackSentiment;

      for (const ticker of extractTickers(title, ctx.config.ticker_blacklist || [])) {
        if (!tickerCache.isKnownSecTicker(ticker)) {
          const cached = tickerCache.getCachedValidation(ticker);
          if (cached === false) continue;
          if (cached === undefined) {
            const isValid = await tickerCache.validateWithAlpaca(ticker, alpaca);
            if (!isValid) continue;
          }
        }

        const weight = freshness * Math.min(2, 0.75 + catalystHits * 0.25);
        const current = byTicker.get(ticker) || {
          weightedSentiment: 0,
          weight: 0,
          articles: 0,
          latestSeen: seenAt,
          title,
        };
        current.weightedSentiment += rawSentiment * weight;
        current.weight += weight;
        current.articles += 1;
        current.latestSeen = Math.max(current.latestSeen, seenAt);
        if (!current.title) current.title = title;
        byTicker.set(ticker, current);
      }
    }

    const sourceWeight = SOURCE_CONFIG.weights.gdelt_news;
    const signals: Signal[] = [];
    for (const [symbol, aggregate] of byTicker) {
      if (aggregate.weight <= 0) continue;
      const rawSentiment = aggregate.weightedSentiment / aggregate.weight;
      const freshness = calculateTimeDecay(Math.floor(aggregate.latestSeen / 1000));
      signals.push({
        symbol,
        source: "gdelt",
        source_detail: "gdelt_market_news",
        sentiment: rawSentiment * sourceWeight * freshness,
        raw_sentiment: rawSentiment,
        volume: aggregate.articles,
        freshness,
        source_weight: sourceWeight,
        reason: `GDELT news catalyst: ${aggregate.title || symbol}`.slice(0, 240),
        timestamp: Date.now(),
      });
    }

    ctx.log("GDELT", "gathered_signals", { count: signals.length, articles: articles.length });
    return signals.slice(0, 20);
  } catch (error) {
    ctx.log("GDELT", "error", { message: String(error).slice(0, 240) });
    return [];
  }
}

export const gdeltGatherer: Gatherer = {
  name: "gdelt",
  gather: gatherGdelt,
};
