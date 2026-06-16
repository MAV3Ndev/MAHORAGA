/**
 * Reddit gatherer — sentiment from r/wallstreetbets, r/stocks, r/investing, r/options.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { calculateTimeDecay, detectSentiment, getEngagementMultiplier, getFlairMultiplier } from "../helpers/sentiment";
import { extractTickers, tickerCache } from "../helpers/ticker";

const REDDIT_SUBREDDITS = ["wallstreetbets", "stocks", "investing", "options"];
const REDDIT_TOKEN_CACHE_KEY = "redditOAuthToken";
const REDDIT_TOKEN_EXPIRY_CACHE_KEY = "redditOAuthTokenExpiresAt";
const REDDIT_TOKEN_REFRESH_SKEW_MS = 60_000;
const REDDIT_COOKIE_ROTATION_KEY = "redditCookieAccountIndex";
const DEFAULT_REDDIT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

type RedditPost = {
  title?: string;
  selftext?: string;
  created_utc?: number;
  ups?: number;
  num_comments?: number;
  link_flair_text?: string;
};

type RedditListingData = {
  data?: {
    children?: Array<{
      data: RedditPost;
    }>;
  };
};

interface RedditCookieCredential {
  cookies: string;
  source: "config_account" | "config" | "env";
  account_index?: number;
  label?: string;
}

function getRedditUserAgent(ctx: StrategyContext): string {
  return ctx.config.reddit_user_agent?.trim() || ctx.env.REDDIT_USER_AGENT?.trim() || DEFAULT_REDDIT_BROWSER_USER_AGENT;
}

function parseCookieParts(cookies: string): string[] {
  return cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.includes("="));
}

function getRedditCookieCredentials(ctx: StrategyContext): RedditCookieCredential[] {
  const accounts =
    ctx.config.reddit_cookie_accounts
      ?.map((account, index) => ({
        cookies: account.cookies.trim(),
        source: "config_account" as const,
        account_index: index,
        label: account.label?.trim() || undefined,
      }))
      .filter((account) => account.cookies) || [];
  if (accounts.length > 0) return accounts;

  const configCookies = ctx.config.reddit_cookies?.trim();
  if (configCookies) return [{ cookies: configCookies, source: "config" }];

  const envCookies = ctx.env.REDDIT_COOKIES?.trim();
  if (envCookies) return [{ cookies: envCookies, source: "env" }];

  return [];
}

function rotateRedditCredentials(
  ctx: StrategyContext,
  credentials: RedditCookieCredential[]
): RedditCookieCredential[] {
  if (credentials.length <= 1) return credentials;
  const start = (ctx.state.get<number>(REDDIT_COOKIE_ROTATION_KEY) ?? 0) % credentials.length;
  return credentials.slice(start).concat(credentials.slice(0, start));
}

function advanceRedditCredential(
  ctx: StrategyContext,
  credentials: RedditCookieCredential[],
  credential: RedditCookieCredential
): void {
  if (credentials.length <= 1) return;
  const currentIndex = credentials.indexOf(credential);
  ctx.state.set(REDDIT_COOKIE_ROTATION_KEY, currentIndex >= 0 ? (currentIndex + 1) % credentials.length : 0);
}

function getRedditCookieHeaders(cookies: string, userAgent: string): HeadersInit {
  return {
    "User-Agent": userAgent,
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookies,
  };
}

async function fetchRedditListingWithCookies(
  subreddit: string,
  cookies: string,
  userAgent: string,
  limit: number
): Promise<
  { ok: true; posts: RedditPost[]; url: string } | { ok: false; status?: number; error: string; url?: string }
> {
  const endpoints = [
    `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`,
    `https://old.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`,
  ];

  let lastError = "";
  let lastStatus: number | undefined;
  let lastUrl: string | undefined;

  for (const url of endpoints) {
    lastUrl = url;
    try {
      const res = await fetch(url, { headers: getRedditCookieHeaders(cookies, userAgent) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastStatus = res.status;
        lastError = text.slice(0, 240) || res.statusText;
        continue;
      }

      const data = (await res.json()) as RedditListingData;
      return { ok: true, posts: data.data?.children?.map((c) => c.data) || [], url };
    } catch (error) {
      lastError = String(error).slice(0, 240);
    }
  }

  return { ok: false, status: lastStatus, error: lastError || "Reddit cookie fetch failed", url: lastUrl };
}

export async function testRedditCookieConnection(
  cookies: string,
  userAgent: string,
  subreddit = "wallstreetbets"
): Promise<{
  ok: boolean;
  cookie_count: number;
  post_count: number;
  status?: number;
  error?: string;
}> {
  const cookieCount = parseCookieParts(cookies).length;
  if (cookieCount === 0) {
    return { ok: false, cookie_count: 0, post_count: 0, error: "Reddit cookies are not configured" };
  }

  const result = await fetchRedditListingWithCookies(
    subreddit,
    cookies,
    userAgent || DEFAULT_REDDIT_BROWSER_USER_AGENT,
    1
  );
  if (!result.ok) {
    return {
      ok: false,
      cookie_count: cookieCount,
      post_count: 0,
      status: result.status,
      error: result.error,
    };
  }

  return { ok: true, cookie_count: cookieCount, post_count: result.posts.length };
}

async function fetchSubredditPostsWithCookieRotation(
  ctx: StrategyContext,
  subreddit: string,
  credentials: RedditCookieCredential[],
  limit: number
): Promise<{ posts: RedditPost[]; source: string; account_index?: number } | null> {
  const userAgent = getRedditUserAgent(ctx);

  for (const credential of rotateRedditCredentials(ctx, credentials)) {
    const result = await fetchRedditListingWithCookies(subreddit, credential.cookies, userAgent, limit);
    if (result.ok) {
      advanceRedditCredential(ctx, credentials, credential);
      return {
        posts: result.posts,
        source: credential.source,
        account_index: credential.account_index,
      };
    }

    ctx.log("Reddit", "cookie_subreddit_fetch_failed", {
      subreddit,
      status: result.status,
      source: credential.source,
      account_index: credential.account_index,
      body: result.error.slice(0, 240),
    });
  }

  return null;
}

async function getRedditAccessToken(ctx: StrategyContext): Promise<string | null> {
  const clientId = ctx.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = ctx.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const cached = ctx.state.get<string>(REDDIT_TOKEN_CACHE_KEY);
  const expiresAt = ctx.state.get<number>(REDDIT_TOKEN_EXPIRY_CACHE_KEY) ?? 0;
  if (cached && Date.now() < expiresAt - REDDIT_TOKEN_REFRESH_SKEW_MS) return cached;

  try {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": getRedditUserAgent(ctx),
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      ctx.log("Reddit", "oauth_error", { status: res.status, body: text.slice(0, 240) });
      return null;
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      ctx.log("Reddit", "oauth_error", { status: res.status, body: "missing access_token" });
      return null;
    }

    const ttlMs = Math.max(60, data.expires_in ?? 3600) * 1000;
    ctx.state.set(REDDIT_TOKEN_CACHE_KEY, data.access_token);
    ctx.state.set(REDDIT_TOKEN_EXPIRY_CACHE_KEY, Date.now() + ttlMs);
    ctx.log("Reddit", "oauth_token_refreshed", { expires_in_seconds: Math.round(ttlMs / 1000) });
    return data.access_token;
  } catch (error) {
    ctx.log("Reddit", "oauth_error", { error: String(error) });
    return null;
  }
}

async function gatherReddit(ctx: StrategyContext): Promise<Signal[]> {
  const cookieCredentials = getRedditCookieCredentials(ctx);
  const accessToken = cookieCredentials.length > 0 ? null : await getRedditAccessToken(ctx);
  const apiBaseUrl = accessToken ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const tickerData = new Map<
    string,
    {
      mentions: number;
      weightedSentiment: number;
      rawSentiment: number;
      totalQuality: number;
      upvotes: number;
      comments: number;
      sources: Set<string>;
      bestFlair: string | null;
      bestFlairMult: number;
      freshestPost: number;
    }
  >();

  for (const sub of REDDIT_SUBREDDITS) {
    const sourceWeight = SOURCE_CONFIG.weights[`reddit_${sub}` as keyof typeof SOURCE_CONFIG.weights] || 0.7;

    try {
      let posts: RedditPost[] = [];
      let authMode = accessToken ? "oauth" : "public";

      if (cookieCredentials.length > 0) {
        const cookieResult = await fetchSubredditPostsWithCookieRotation(ctx, sub, cookieCredentials, 25);
        if (!cookieResult) continue;
        posts = cookieResult.posts;
        authMode = cookieResult.source;
      } else {
        const res = await fetch(`${apiBaseUrl}/r/${sub}/hot.json?limit=25&raw_json=1`, {
          headers: {
            "User-Agent": getRedditUserAgent(ctx),
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          ctx.log("Reddit", "subreddit_fetch_failed", {
            subreddit: sub,
            status: res.status,
            auth_mode: authMode,
            body: text.slice(0, 240),
          });
          continue;
        }
        const data = (await res.json()) as RedditListingData;
        posts = data.data?.children?.map((c) => c.data) || [];
      }

      let tickerMentions = 0;

      for (const post of posts) {
        const text = `${post.title || ""} ${post.selftext || ""}`;
        const tickers = extractTickers(text, ctx.config.ticker_blacklist);
        tickerMentions += tickers.length;
        const rawSentiment = detectSentiment(text);

        const timeDecay = calculateTimeDecay(post.created_utc || Date.now() / 1000);
        const engagementMult = getEngagementMultiplier(post.ups || 0, post.num_comments || 0);
        const flairMult = getFlairMultiplier(post.link_flair_text);
        const qualityScore = timeDecay * engagementMult * flairMult * sourceWeight;

        for (const ticker of tickers) {
          if (!tickerData.has(ticker)) {
            tickerData.set(ticker, {
              mentions: 0,
              weightedSentiment: 0,
              rawSentiment: 0,
              totalQuality: 0,
              upvotes: 0,
              comments: 0,
              sources: new Set(),
              bestFlair: null,
              bestFlairMult: 0,
              freshestPost: 0,
            });
          }
          const d = tickerData.get(ticker)!;
          d.mentions++;
          d.rawSentiment += rawSentiment;
          d.weightedSentiment += rawSentiment * qualityScore;
          d.totalQuality += qualityScore;
          d.upvotes += post.ups || 0;
          d.comments += post.num_comments || 0;
          d.sources.add(sub);

          if (flairMult > d.bestFlairMult) {
            d.bestFlair = post.link_flair_text || null;
            d.bestFlairMult = flairMult;
          }

          if ((post.created_utc || 0) > d.freshestPost) {
            d.freshestPost = post.created_utc || 0;
          }
        }
      }

      ctx.log("Reddit", "subreddit_gathered", {
        subreddit: sub,
        posts: posts.length,
        ticker_mentions: tickerMentions,
        auth_mode: authMode,
      });

      await ctx.sleep(1000);
    } catch (error) {
      ctx.log("Reddit", "subreddit_error", { subreddit: sub, error: String(error) });
    }
  }

  const signals: Signal[] = [];
  const alpaca = createAlpacaProviders(ctx.env);

  for (const [symbol, data] of tickerData) {
    if (data.mentions >= 2) {
      if (!tickerCache.isKnownSecTicker(symbol)) {
        const cached = tickerCache.getCachedValidation(symbol);
        if (cached === false) continue;
        if (cached === undefined) {
          const isValid = await tickerCache.validateWithAlpaca(symbol, alpaca);
          if (!isValid) {
            ctx.log("Reddit", "invalid_ticker_filtered", { symbol });
            continue;
          }
        }
      }

      const avgRawSentiment = data.rawSentiment / data.mentions;
      const avgQuality = data.totalQuality / data.mentions;
      const finalSentiment = data.totalQuality > 0 ? data.weightedSentiment / data.mentions : avgRawSentiment * 0.5;
      const freshness = calculateTimeDecay(data.freshestPost);
      const hasActionableSentiment = Math.abs(avgRawSentiment) >= 0.1 || data.sources.size >= 2;
      if (!hasActionableSentiment || avgQuality < ctx.config.min_signal_quality_score) {
        ctx.log("Reddit", "low_quality_filtered", {
          symbol,
          mentions: data.mentions,
          raw_sentiment: avgRawSentiment.toFixed(3),
          quality: avgQuality.toFixed(3),
        });
        continue;
      }

      signals.push({
        symbol,
        source: "reddit",
        source_detail: `reddit_${Array.from(data.sources).join("+")}`,
        sentiment: finalSentiment,
        raw_sentiment: avgRawSentiment,
        volume: data.mentions,
        upvotes: data.upvotes,
        comments: data.comments,
        quality_score: avgQuality,
        freshness,
        best_flair: data.bestFlair,
        subreddits: Array.from(data.sources),
        source_weight: avgQuality,
        reason: `Reddit(${Array.from(data.sources).join(",")}): ${data.mentions} mentions, ${data.upvotes} upvotes, quality:${(avgQuality * 100).toFixed(0)}%`,
        timestamp: Date.now(),
      });
    }
  }

  ctx.log("Reddit", "gathered_signals", {
    count: signals.length,
    tracked_tickers: tickerData.size,
    auth_mode: cookieCredentials.length > 0 ? "cookie" : accessToken ? "oauth" : "public",
  });

  return signals;
}

export const redditGatherer: Gatherer = {
  name: "reddit",
  gather: gatherReddit,
};
