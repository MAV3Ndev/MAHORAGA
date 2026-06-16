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
const GDELT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
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

const COMPANY_TICKER_ALIASES: Array<{ symbol: string; patterns: RegExp[] }> = [
  { symbol: "AAPL", patterns: [/\bapple\b/i, /\biphone\b/i] },
  { symbol: "MSFT", patterns: [/\bmicrosoft\b/i, /\bopenai\b/i] },
  { symbol: "NVDA", patterns: [/\bnvidia\b/i] },
  { symbol: "AMD", patterns: [/\badvanced micro devices\b/i, /\bamd\b/i] },
  { symbol: "INTC", patterns: [/\bintel\b/i] },
  { symbol: "AVGO", patterns: [/\bbroadcom\b/i] },
  { symbol: "TSLA", patterns: [/\btesla\b/i] },
  { symbol: "AMZN", patterns: [/\bamazon\b/i, /\baws\b/i] },
  { symbol: "META", patterns: [/\bmeta\b/i, /\bfacebook\b/i, /\binstagram\b/i] },
  { symbol: "GOOGL", patterns: [/\balphabet\b/i, /\bgoogle\b/i, /\byoutube\b/i] },
  { symbol: "NFLX", patterns: [/\bnetflix\b/i] },
  { symbol: "ORCL", patterns: [/\boracle\b/i] },
  { symbol: "CRM", patterns: [/\bsalesforce\b/i] },
  { symbol: "PLTR", patterns: [/\bpalantir\b/i] },
  { symbol: "MU", patterns: [/\bmicron\b/i] },
  { symbol: "SMCI", patterns: [/\bsuper micro\b/i, /\bsupermicro\b/i] },
  { symbol: "JPM", patterns: [/\bjpmorgan\b/i, /\bjp morgan\b/i] },
  { symbol: "BAC", patterns: [/\bbank of america\b/i] },
  { symbol: "C", patterns: [/\bcitigroup\b/i, /\bcitibank\b/i] },
  { symbol: "GS", patterns: [/\bgoldman sachs\b/i] },
  { symbol: "MS", patterns: [/\bmorgan stanley\b/i] },
  { symbol: "WMT", patterns: [/\bwalmart\b/i] },
  { symbol: "TGT", patterns: [/\btarget\b/i] },
  { symbol: "COST", patterns: [/\bcostco\b/i] },
  { symbol: "HD", patterns: [/\bhome depot\b/i] },
  { symbol: "MCD", patterns: [/\bmcdonald'?s\b/i] },
  { symbol: "SBUX", patterns: [/\bstarbucks\b/i] },
  { symbol: "NKE", patterns: [/\bnike\b/i] },
  { symbol: "DIS", patterns: [/\bdisney\b/i] },
  { symbol: "BA", patterns: [/\bboeing\b/i] },
  { symbol: "UBER", patterns: [/\buber\b/i] },
  { symbol: "ABNB", patterns: [/\bairbnb\b/i] },
  { symbol: "DASH", patterns: [/\bdoordash\b/i] },
  { symbol: "PYPL", patterns: [/\bpaypal\b/i] },
  { symbol: "SQ", patterns: [/\bblock\b/i, /\bsquare\b/i] },
  { symbol: "COIN", patterns: [/\bcoinbase\b/i] },
  { symbol: "HOOD", patterns: [/\brobinhood\b/i] },
  { symbol: "F", patterns: [/\bford\b/i] },
  { symbol: "GM", patterns: [/\bgeneral motors\b/i] },
  { symbol: "RIVN", patterns: [/\brivian\b/i] },
  { symbol: "LCID", patterns: [/\blucid\b/i] },
  { symbol: "LLY", patterns: [/\beli lilly\b/i] },
  { symbol: "UNH", patterns: [/\bunitedhealth\b/i, /\bunited health\b/i] },
  { symbol: "PFE", patterns: [/\bpfizer\b/i] },
  { symbol: "MRNA", patterns: [/\bmoderna\b/i] },
  { symbol: "XOM", patterns: [/\bexxon\b/i, /\bexxonmobil\b/i] },
  { symbol: "CVX", patterns: [/\bchevron\b/i] },
  { symbol: "OXY", patterns: [/\boccidental\b/i] },
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

function extractGdeltTickers(title: string, customBlacklist: string[] = []): string[] {
  const symbols = new Set(extractTickers(title, customBlacklist));
  const customSet = new Set(customBlacklist.map((ticker) => ticker.toUpperCase()));

  for (const alias of COMPANY_TICKER_ALIASES) {
    if (customSet.has(alias.symbol)) continue;
    if (alias.patterns.some((pattern) => pattern.test(title))) {
      symbols.add(alias.symbol);
    }
  }

  return Array.from(symbols);
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

  const query = `sourcecountry:US (${MARKET_MOVING_TERMS.map((term) => `"${term}"`).join(" OR ")})`;
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    sort: "datedesc",
    maxrecords: "50",
    timespan: "24h",
  });

  const response = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    ctx.log("GDELT", "fetch_error", { status: response.status, message: body.slice(0, 180) });
    ctx.state.set(
      GDELT_COOLDOWN_KEY,
      Date.now() + (response.status === 429 ? GDELT_RATE_LIMIT_COOLDOWN_MS : GDELT_ERROR_COOLDOWN_MS)
    );
    return [];
  }

  const data = (await response.json()) as GdeltResponse;
  const articles = data.articles || [];
  if (articles.length > 0) {
    ctx.state.set<GdeltCache>(GDELT_CACHE_KEY, { timestamp: Date.now(), articles });
  }
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

      for (const ticker of extractGdeltTickers(title, ctx.config.ticker_blacklist || [])) {
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
