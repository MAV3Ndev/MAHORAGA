/**
 * Twitter integration — confirmation signals and breaking news detection.
 *
 * Twitter is used for CONFIRMATION only — it boosts/reduces confidence
 * on signals from other sources, doesn't generate signals itself.
 *
 * Enable with TWITTER_BEARER_TOKEN secret or Twitter/X cookies in config/secret.
 */

import { ErrorRateLimitStrategy, Scraper, SearchMode, type Tweet } from "@the-convocation/twitter-scraper";
import type { TwitterConfirmation } from "../../../core/types";
import type { StrategyContext } from "../../types";

const TWITTER_COOKIE_ROTATION_KEY = "twitterCookieAccountIndex";
const TWITTER_SEARCH_CACHE_KEY = "twitterSearchCache";
const TWITTER_SEARCH_CACHE_TTL_MS = 120_000;
const TWITTER_SEARCH_CACHE_MAX_ENTRIES = 100;

interface TwitterCookieCredential {
  cookies: string;
  source: "config_account" | "config" | "env";
  account_index?: number;
  label?: string;
}

interface NormalizedTweet {
  id: string;
  text: string;
  created_at: string;
  author: string;
  author_followers: number;
  retweets: number;
  likes: number;
}

interface TwitterSearchCacheEntry {
  timestamp: number;
  tweets: NormalizedTweet[];
}

// ── Availability ─────────────────────────────────────────────────────────────

export function isTwitterEnabled(ctx: StrategyContext): boolean {
  return !!ctx.env.TWITTER_BEARER_TOKEN || getTwitterCookieCredentials(ctx).length > 0;
}

// ── Twitter API ──────────────────────────────────────────────────────────────

function hashTwitterSearchKey(query: string, maxResults: number): string {
  const input = `${maxResults}:${query}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getTwitterSearchCache(ctx: StrategyContext): Record<string, TwitterSearchCacheEntry> {
  return ctx.state.get<Record<string, TwitterSearchCacheEntry>>(TWITTER_SEARCH_CACHE_KEY) ?? {};
}

function getCachedTwitterSearch(ctx: StrategyContext, cacheKey: string): NormalizedTweet[] | null {
  const cache = getTwitterSearchCache(ctx);
  const cached = cache[cacheKey];
  if (!cached) return null;
  if (Date.now() - cached.timestamp > TWITTER_SEARCH_CACHE_TTL_MS) return null;
  return cached.tweets;
}

function setCachedTwitterSearch(ctx: StrategyContext, cacheKey: string, tweets: NormalizedTweet[]): void {
  const now = Date.now();
  const cache = getTwitterSearchCache(ctx);
  cache[cacheKey] = { timestamp: now, tweets };

  const pruned = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => now - entry.timestamp <= TWITTER_SEARCH_CACHE_TTL_MS)
      .sort(([, a], [, b]) => b.timestamp - a.timestamp)
      .slice(0, TWITTER_SEARCH_CACHE_MAX_ENTRIES)
  );
  ctx.state.set(TWITTER_SEARCH_CACHE_KEY, pruned);
}

function parseTwitterCookieParts(cookies: string): string[] {
  return cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.includes("="));
}

function getTwitterCookieCredentials(ctx: StrategyContext): TwitterCookieCredential[] {
  const accounts =
    ctx.config.twitter_cookie_accounts
      ?.map((account, index) => ({
        cookies: account.cookies.trim(),
        source: "config_account" as const,
        account_index: index,
        label: account.label?.trim() || undefined,
      }))
      .filter((account) => account.cookies) || [];
  if (accounts.length > 0) return accounts;

  const configCookies = ctx.config.twitter_cookies?.trim();
  if (configCookies) return [{ cookies: configCookies, source: "config" }];

  const envCookies = ctx.env.TWITTER_COOKIES?.trim();
  if (envCookies) return [{ cookies: envCookies, source: "env" }];

  return [];
}

function rotateTwitterCredentials(
  ctx: StrategyContext,
  credentials: TwitterCookieCredential[]
): TwitterCookieCredential[] {
  if (credentials.length <= 1) return credentials;
  const start = (ctx.state.get<number>(TWITTER_COOKIE_ROTATION_KEY) ?? 0) % credentials.length;
  return credentials.slice(start).concat(credentials.slice(0, start));
}

function advanceTwitterCredential(
  ctx: StrategyContext,
  credentials: TwitterCookieCredential[],
  credential: TwitterCookieCredential
): void {
  if (credentials.length <= 1) return;
  const currentIndex = credentials.indexOf(credential);
  ctx.state.set(TWITTER_COOKIE_ROTATION_KEY, currentIndex >= 0 ? (currentIndex + 1) % credentials.length : 0);
}

export async function testTwitterCookieConnection(cookies: string): Promise<{
  ok: boolean;
  authenticated: boolean;
  cookie_count: number;
  error?: string;
}> {
  const cookieParts = parseTwitterCookieParts(cookies);
  if (cookieParts.length === 0) {
    return {
      ok: false,
      authenticated: false,
      cookie_count: 0,
      error: "Twitter/X cookies are not configured",
    };
  }

  try {
    const scraper = new Scraper({
      fetch,
      rateLimitStrategy: new ErrorRateLimitStrategy(),
    });
    await scraper.setCookies(cookieParts);
    const authenticated = await scraper.isLoggedIn();
    return {
      ok: authenticated,
      authenticated,
      cookie_count: cookieParts.length,
      error: authenticated ? undefined : "Twitter/X cookie authentication failed",
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      cookie_count: cookieParts.length,
      error: String(error).slice(0, 240),
    };
  }
}

function normalizeScrapedTweet(tweet: Tweet): {
  id: string;
  text: string;
  created_at: string;
  author: string;
  author_followers: number;
  retweets: number;
  likes: number;
} {
  const timestampMs =
    tweet.timeParsed instanceof Date
      ? tweet.timeParsed.getTime()
      : typeof tweet.timestamp === "number"
        ? tweet.timestamp * 1000
        : Date.now();

  return {
    id: tweet.id || "",
    text: tweet.text || "",
    created_at: new Date(timestampMs).toISOString(),
    author: tweet.username || "unknown",
    author_followers: 0,
    retweets: tweet.retweets || 0,
    likes: tweet.likes || 0,
  };
}

async function twitterSearchWithCookies(
  ctx: StrategyContext,
  credential: TwitterCookieCredential,
  query: string,
  maxResults: number
): Promise<{
  ok: boolean;
  tweets: NormalizedTweet[];
}> {
  const cookies = parseTwitterCookieParts(credential.cookies);
  if (cookies.length === 0) return { ok: false, tweets: [] };

  try {
    const scraper = new Scraper({
      fetch,
      rateLimitStrategy: new ErrorRateLimitStrategy(),
    });
    await scraper.setCookies(cookies);

    const tweets: NormalizedTweet[] = [];

    for await (const tweet of scraper.searchTweets(query, Math.min(maxResults, 20), SearchMode.Latest)) {
      if (tweet.text) tweets.push(normalizeScrapedTweet(tweet));
      if (tweets.length >= maxResults) break;
    }

    ctx.log("Twitter", "cookie_search_complete", {
      query: query.slice(0, 120),
      tweet_count: tweets.length,
      source: credential.source,
      account_index: credential.account_index,
    });
    return { ok: true, tweets };
  } catch (error) {
    ctx.log("Twitter", "cookie_search_error", {
      message: String(error).slice(0, 240),
      source: credential.source,
      account_index: credential.account_index,
    });
    return { ok: false, tweets: [] };
  }
}

async function twitterSearchRecent(ctx: StrategyContext, query: string, maxResults = 10): Promise<NormalizedTweet[]> {
  if (!isTwitterEnabled(ctx)) return [];

  const cacheKey = hashTwitterSearchKey(query, maxResults);
  const cached = getCachedTwitterSearch(ctx, cacheKey);
  if (cached) {
    ctx.log("Twitter", "search_cache_hit", {
      query: query.slice(0, 120),
      tweet_count: cached.length,
      ttl_ms: TWITTER_SEARCH_CACHE_TTL_MS,
    });
    return cached;
  }

  const cookieCredentials = getTwitterCookieCredentials(ctx);
  if (cookieCredentials.length > 0) {
    for (const credential of rotateTwitterCredentials(ctx, cookieCredentials)) {
      const result = await twitterSearchWithCookies(ctx, credential, query, maxResults);
      if (result.ok) {
        advanceTwitterCredential(ctx, cookieCredentials, credential);
        setCachedTwitterSearch(ctx, cacheKey, result.tweets);
        return result.tweets;
      }
    }

    if (!ctx.env.TWITTER_BEARER_TOKEN) return [];
  }

  if (!ctx.env.TWITTER_BEARER_TOKEN) return [];

  try {
    const params = new URLSearchParams({
      query,
      max_results: Math.min(maxResults, 10).toString(),
      "tweet.fields": "created_at,public_metrics,author_id",
      expansions: "author_id",
      "user.fields": "username,public_metrics",
    });

    const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
      headers: {
        Authorization: `Bearer ${ctx.env.TWITTER_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      ctx.log("Twitter", "api_error", { status: res.status });
      return [];
    }

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        text: string;
        created_at: string;
        author_id: string;
        public_metrics?: { retweet_count?: number; like_count?: number };
      }>;
      includes?: {
        users?: Array<{
          id: string;
          username: string;
          public_metrics?: { followers_count?: number };
        }>;
      };
    };

    const tweets = (data.data || []).map((tweet) => {
      const user = data.includes?.users?.find((u) => u.id === tweet.author_id);
      return {
        id: tweet.id,
        text: tweet.text,
        created_at: tweet.created_at,
        author: user?.username || "unknown",
        author_followers: user?.public_metrics?.followers_count || 0,
        retweets: tweet.public_metrics?.retweet_count || 0,
        likes: tweet.public_metrics?.like_count || 0,
      };
    });
    setCachedTwitterSearch(ctx, cacheKey, tweets);
    return tweets;
  } catch (error) {
    ctx.log("Twitter", "error", { message: String(error) });
    return [];
  }
}

// ── Confirmation ─────────────────────────────────────────────────────────────

/**
 * Gather Twitter confirmation for a symbol based on existing sentiment.
 * Returns cached result if fresh enough.
 */
export async function gatherTwitterConfirmation(
  ctx: StrategyContext,
  symbol: string,
  existingSentiment: number
): Promise<TwitterConfirmation | null> {
  const MIN_SENTIMENT_FOR_CONFIRMATION = 0.3;
  const CACHE_TTL_MS = 300_000;

  if (!isTwitterEnabled(ctx)) return null;
  if (Math.abs(existingSentiment) < MIN_SENTIMENT_FOR_CONFIRMATION) return null;

  const cacheKey = `twitterConfirmation_${symbol}`;
  const cached = ctx.state.get<TwitterConfirmation>(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  const actionableKeywords = [
    "unusual",
    "flow",
    "sweep",
    "block",
    "whale",
    "breaking",
    "alert",
    "upgrade",
    "downgrade",
  ];
  const query = `$${symbol} (${actionableKeywords.slice(0, 5).join(" OR ")}) -is:retweet lang:en`;
  const tweets = await twitterSearchRecent(ctx, query, 10);

  if (tweets.length === 0) return null;

  let bullish = 0;
  let bearish = 0;
  let totalWeight = 0;
  const highlights: Array<{ author: string; text: string; likes: number }> = [];

  const bullWords = ["buy", "call", "long", "bullish", "upgrade", "beat", "squeeze", "moon", "breakout"];
  const bearWords = ["sell", "put", "short", "bearish", "downgrade", "miss", "crash", "dump", "breakdown"];

  for (const tweet of tweets) {
    const text = tweet.text.toLowerCase();
    const authorWeight = Math.min(1.5, Math.log10(tweet.author_followers + 1) / 5);
    const engagementWeight = Math.min(1.3, 1 + (tweet.likes + tweet.retweets * 2) / 1000);
    const weight = authorWeight * engagementWeight;

    let sentiment = 0;
    for (const w of bullWords) if (text.includes(w)) sentiment += 1;
    for (const w of bearWords) if (text.includes(w)) sentiment -= 1;

    if (sentiment > 0) bullish += weight;
    else if (sentiment < 0) bearish += weight;
    totalWeight += weight;

    if (tweet.likes > 50 || tweet.author_followers > 10000) {
      highlights.push({
        author: tweet.author,
        text: tweet.text.slice(0, 150),
        likes: tweet.likes,
      });
    }
  }

  const twitterSentiment = totalWeight > 0 ? (bullish - bearish) / totalWeight : 0;
  const twitterBullish = twitterSentiment > 0.2;
  const twitterBearish = twitterSentiment < -0.2;
  const existingBullish = existingSentiment > 0;

  const result: TwitterConfirmation = {
    symbol,
    tweet_count: tweets.length,
    sentiment: twitterSentiment,
    confirms_existing: (twitterBullish && existingBullish) || (twitterBearish && !existingBullish),
    highlights: highlights.slice(0, 3),
    timestamp: Date.now(),
  };

  ctx.state.set(cacheKey, result);
  ctx.log("Twitter", "signal_confirmed", {
    symbol,
    sentiment: twitterSentiment.toFixed(2),
    confirms: result.confirms_existing,
    tweet_count: tweets.length,
  });

  return result;
}

// ── Breaking news ────────────────────────────────────────────────────────────

export async function checkTwitterBreakingNews(
  ctx: StrategyContext,
  symbols: string[]
): Promise<
  Array<{
    symbol: string;
    headline: string;
    author: string;
    age_minutes: number;
    is_breaking: boolean;
  }>
> {
  if (!isTwitterEnabled(ctx) || symbols.length === 0) return [];

  const toCheck = symbols.slice(0, 3);
  const newsQuery = `(from:FirstSquawk OR from:DeItaone OR from:Newsquawk) (${toCheck.map((s) => `$${s}`).join(" OR ")}) -is:retweet`;
  const tweets = await twitterSearchRecent(ctx, newsQuery, 5);

  const results: Array<{
    symbol: string;
    headline: string;
    author: string;
    age_minutes: number;
    is_breaking: boolean;
  }> = [];

  const MAX_NEWS_AGE_MS = 1800_000;
  const BREAKING_THRESHOLD_MS = 600_000;

  for (const tweet of tweets) {
    const tweetAge = Date.now() - new Date(tweet.created_at).getTime();
    if (tweetAge > MAX_NEWS_AGE_MS) continue;

    const mentionedSymbol = toCheck.find(
      (s) => tweet.text.toUpperCase().includes(`$${s}`) || tweet.text.toUpperCase().includes(` ${s} `)
    );

    if (mentionedSymbol) {
      results.push({
        symbol: mentionedSymbol,
        headline: tweet.text.slice(0, 200),
        author: tweet.author,
        age_minutes: Math.round(tweetAge / 60000),
        is_breaking: tweetAge < BREAKING_THRESHOLD_MS,
      });
    }
  }

  if (results.length > 0) {
    ctx.log("Twitter", "breaking_news_found", {
      count: results.length,
      symbols: results.map((r) => r.symbol),
    });
  }

  return results;
}
