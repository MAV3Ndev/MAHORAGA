/**
 * Alpha Vantage gatherer — ticker-level news sentiment catalysts.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { calculateTimeDecay } from "../helpers/sentiment";
import { tickerCache } from "../helpers/ticker";

const ALPHA_VANTAGE_CACHE_KEY = "alphaVantageNewsCache";
const ALPHA_VANTAGE_COOLDOWN_KEY = "alphaVantageNewsCooldownUntil";
const ALPHA_VANTAGE_CACHE_TTL_MS = 30 * 60_000;
const ALPHA_VANTAGE_ERROR_COOLDOWN_MS = 30 * 60_000;
const ALPHA_VANTAGE_NEWS_TOPICS = "financial_markets,earnings,mergers_and_acquisitions,technology";

interface AlphaVantageTickerSentiment {
  ticker?: string;
  relevance_score?: string;
  ticker_sentiment_score?: string;
  ticker_sentiment_label?: string;
}

interface AlphaVantageNewsItem {
  title?: string;
  time_published?: string;
  overall_sentiment_score?: number;
  overall_sentiment_label?: string;
  ticker_sentiment?: AlphaVantageTickerSentiment[];
}

interface AlphaVantageNewsResponse {
  feed?: AlphaVantageNewsItem[];
  Information?: string;
  Note?: string;
  "Error Message"?: string;
}

interface AlphaVantageNewsCache {
  timestamp: number;
  feed: AlphaVantageNewsItem[];
}

function getAlphaVantageApiKey(ctx: StrategyContext): string {
  return ctx.config.alpha_vantage_api_key?.trim() || ctx.env.ALPHA_VANTAGE_API_KEY?.trim() || "";
}

function parseAlphaVantageTime(value?: string): number {
  if (!value || !/^\d{8}T\d{6}$/.test(value)) return Date.now();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(9, 11));
  const minute = Number(value.slice(11, 13));
  const second = Number(value.slice(13, 15));
  return Date.UTC(year, month, day, hour, minute, second);
}

async function fetchAlphaVantageNews(ctx: StrategyContext, apiKey: string): Promise<AlphaVantageNewsItem[]> {
  const cooldownUntil = ctx.state.get<number>(ALPHA_VANTAGE_COOLDOWN_KEY) ?? 0;
  if (Date.now() < cooldownUntil) {
    ctx.log("AlphaVantage", "cooldown_active", { retry_after_ms: cooldownUntil - Date.now() });
    return [];
  }

  const cached = ctx.state.get<AlphaVantageNewsCache>(ALPHA_VANTAGE_CACHE_KEY);
  if (cached && Date.now() - cached.timestamp < ALPHA_VANTAGE_CACHE_TTL_MS) {
    ctx.log("AlphaVantage", "news_cache_hit", { articles: cached.feed.length });
    return cached.feed;
  }

  const params = new URLSearchParams({
    function: "NEWS_SENTIMENT",
    topics: ALPHA_VANTAGE_NEWS_TOPICS,
    sort: "LATEST",
    limit: "100",
    apikey: apiKey,
  });

  const response = await fetch(`https://www.alphavantage.co/query?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    ctx.log("AlphaVantage", "fetch_error", { status: response.status });
    if (response.status === 429 || response.status >= 500) {
      ctx.state.set(ALPHA_VANTAGE_COOLDOWN_KEY, Date.now() + ALPHA_VANTAGE_ERROR_COOLDOWN_MS);
    }
    return [];
  }

  const data = (await response.json()) as AlphaVantageNewsResponse;
  const apiMessage = data.Note || data.Information || data["Error Message"];
  if (apiMessage) {
    ctx.log("AlphaVantage", "api_message", {
      message: apiMessage.slice(0, 240),
    });
    ctx.state.set(ALPHA_VANTAGE_COOLDOWN_KEY, Date.now() + ALPHA_VANTAGE_ERROR_COOLDOWN_MS);
    return [];
  }

  const feed = data.feed || [];
  if (feed.length > 0) {
    ctx.state.set<AlphaVantageNewsCache>(ALPHA_VANTAGE_CACHE_KEY, { timestamp: Date.now(), feed });
  }
  ctx.log("AlphaVantage", "news_fetched", { articles: feed.length });
  return feed;
}

async function gatherAlphaVantage(ctx: StrategyContext): Promise<Signal[]> {
  const apiKey = getAlphaVantageApiKey(ctx);
  if (!apiKey) {
    ctx.log("AlphaVantage", "disabled", { reason: "missing_api_key" });
    return [];
  }

  try {
    const feed = await fetchAlphaVantageNews(ctx, apiKey);
    const alpaca = createAlpacaProviders(ctx.env);
    const byTicker = new Map<
      string,
      {
        sentimentNumerator: number;
        relevanceTotal: number;
        articles: number;
        titles: string[];
        latestPublished: number;
      }
    >();
    const filterStats = {
      ticker_mentions: 0,
      malformed_ticker: 0,
      blacklisted: 0,
      weak_relevance_or_sentiment: 0,
      invalid_ticker: 0,
      accepted_mentions: 0,
    };

    for (const item of feed) {
      const published = parseAlphaVantageTime(item.time_published);
      for (const tickerSentiment of item.ticker_sentiment || []) {
        filterStats.ticker_mentions += 1;
        const ticker = tickerSentiment.ticker?.trim().toUpperCase();
        if (!ticker || ticker.includes(":") || ticker.includes(".")) {
          filterStats.malformed_ticker += 1;
          continue;
        }
        if (ctx.config.ticker_blacklist?.includes(ticker)) {
          filterStats.blacklisted += 1;
          continue;
        }

        const relevance = Number(tickerSentiment.relevance_score || 0);
        const rawSentiment = Number(tickerSentiment.ticker_sentiment_score ?? item.overall_sentiment_score ?? 0) || 0;
        if (relevance < 0.08 || Math.abs(rawSentiment) < 0.05) {
          filterStats.weak_relevance_or_sentiment += 1;
          continue;
        }

        const cached = tickerCache.getCachedValidation(ticker);
        if (cached === false) {
          filterStats.invalid_ticker += 1;
          continue;
        }
        if (cached === undefined) {
          const isValid = await tickerCache.validateWithAlpaca(ticker, alpaca);
          if (!isValid) {
            filterStats.invalid_ticker += 1;
            continue;
          }
        }
        filterStats.accepted_mentions += 1;

        const freshness = calculateTimeDecay(Math.floor(published / 1000));
        const weight = relevance * freshness;
        const current = byTicker.get(ticker) || {
          sentimentNumerator: 0,
          relevanceTotal: 0,
          articles: 0,
          titles: [],
          latestPublished: published,
        };
        current.sentimentNumerator += rawSentiment * weight;
        current.relevanceTotal += weight;
        current.articles += 1;
        current.latestPublished = Math.max(current.latestPublished, published);
        if (item.title && current.titles.length < 3) current.titles.push(item.title);
        byTicker.set(ticker, current);
      }
    }

    const signals: Signal[] = [];
    for (const [symbol, aggregate] of byTicker) {
      if (aggregate.articles < 1 || aggregate.relevanceTotal <= 0) continue;
      const rawSentiment = aggregate.sentimentNumerator / aggregate.relevanceTotal;
      const freshness = calculateTimeDecay(Math.floor(aggregate.latestPublished / 1000));
      const sourceWeight = SOURCE_CONFIG.weights.alpha_vantage_news;
      signals.push({
        symbol,
        source: "alpha_vantage",
        source_detail: "alpha_vantage_news_sentiment",
        sentiment: rawSentiment * sourceWeight * freshness,
        raw_sentiment: rawSentiment,
        volume: aggregate.articles,
        freshness,
        source_weight: sourceWeight,
        reason:
          `Alpha Vantage news: ${aggregate.articles} article(s), sentiment ${(rawSentiment * 100).toFixed(0)}%. ${aggregate.titles[0] || ""}`.slice(
            0,
            240
          ),
        timestamp: Date.now(),
      });
    }

    ctx.log("AlphaVantage", "gathered_signals", { count: signals.length, articles: feed.length, ...filterStats });
    return signals.slice(0, 20);
  } catch (error) {
    ctx.log("AlphaVantage", "error", { message: String(error).slice(0, 240) });
    return [];
  }
}

export const alphaVantageGatherer: Gatherer = {
  name: "alpha_vantage",
  gather: gatherAlphaVantage,
};
