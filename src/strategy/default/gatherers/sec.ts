/**
 * SEC EDGAR gatherer — 8-K and other filings from the SEC EDGAR ATOM feed.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { tickerCache } from "../helpers/ticker";

const SEC_FORMS = ["8-K", "4", "13D", "13G", "S-1", "10-Q", "10-K"];
const SEC_COMPANY_TICKERS_CACHE_KEY = "secCompanyTickersCache";
const SEC_COMPANY_TICKERS_CACHE_TTL_MS = 24 * 60 * 60_000;

type SecCompanyTickerEntry = { cik_str: number; ticker: string; title: string };

// ── XML / feed helpers ───────────────────────────────────────────────────────

function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
  const match = xml.match(regex);
  return match ? (match[1] ?? null) : null;
}

function parseSECAtomFeed(xml: string): Array<{
  id: string;
  title: string;
  updated: string;
  form: string;
  company: string;
}> {
  const entries: Array<{
    id: string;
    title: string;
    updated: string;
    form: string;
    company: string;
  }> = [];

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    if (!entryXml) continue;

    const id = extractXmlTag(entryXml, "id") || `sec_${Date.now()}_${Math.random()}`;
    const title = extractXmlTag(entryXml, "title") || "";
    const updated = extractXmlTag(entryXml, "updated") || new Date().toISOString();

    const formMatch = title.match(/\(([A-Z0-9]+(?:-[A-Z0-9]+)?)\)/i);
    const form = formMatch ? (formMatch[1] ?? "") : "";

    const companyMatch = title.match(/^([^(]+)/);
    const company = companyMatch ? (companyMatch[1]?.trim() ?? "") : "";

    if (form && company) {
      entries.push({ id, title, updated, form, company });
    }
  }

  return entries;
}

function calculateSECFreshness(updatedDate: string): number {
  const ageMs = Date.now() - new Date(updatedDate).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 1) return 1.0;
  if (ageHours < 4) return 0.9;
  if (ageHours < 12) return 0.7;
  if (ageHours < 24) return 0.5;
  return 0.3;
}

function classifySECFilingSentiment(entry: { title: string; form: string; company: string }): {
  sentiment: number;
  qualityScore: number;
  label: string;
} {
  const text = `${entry.title} ${entry.company} ${entry.form}`.toLowerCase();
  const bullish =
    /approval|approved|award|contract|agreement|partnership|acquisition|merger|buyback|repurchase|guidance|earnings|fda|strategic/i.test(
      text
    );
  const bearish =
    /bankruptcy|delisting|offering|resignation|investigation|default|impairment|restatement|subpoena|going concern|termination/i.test(
      text
    );

  if (bearish && !bullish) return { sentiment: -0.45, qualityScore: 0.75, label: "bearish" };
  if (bullish && !bearish) return { sentiment: 0.45, qualityScore: 0.8, label: "bullish" };
  if (entry.form === "8-K") return { sentiment: 0.12, qualityScore: 0.45, label: "neutral_8k" };
  return { sentiment: 0.05, qualityScore: 0.35, label: "neutral" };
}

// ── Company name → ticker resolution ─────────────────────────────────────────

const companyToTickerCache = new Map<string, string | null>();

async function getSecCompanyTickers(ctx: StrategyContext): Promise<SecCompanyTickerEntry[]> {
  const cached = ctx.state.get<{ timestamp: number; entries: SecCompanyTickerEntry[] }>(SEC_COMPANY_TICKERS_CACHE_KEY);
  if (cached && Date.now() - cached.timestamp < SEC_COMPANY_TICKERS_CACHE_TTL_MS) {
    return cached.entries;
  }

  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "Mahoraga Trading Bot contact@example.com" },
  });

  if (!response.ok) return cached?.entries || [];

  const data = (await response.json()) as Record<string, SecCompanyTickerEntry>;
  const entries = Object.values(data);
  ctx.state.set(SEC_COMPANY_TICKERS_CACHE_KEY, { timestamp: Date.now(), entries });
  return entries;
}

async function resolveTickerFromCompanyName(ctx: StrategyContext, companyName: string): Promise<string | null> {
  const normalized = companyName.toUpperCase().trim();

  if (companyToTickerCache.has(normalized)) {
    return companyToTickerCache.get(normalized) ?? null;
  }

  try {
    const entries = await getSecCompanyTickers(ctx);

    for (const entry of entries) {
      const entryTitle = entry.title.toUpperCase();
      if (entryTitle === normalized || normalized.includes(entryTitle) || entryTitle.includes(normalized)) {
        companyToTickerCache.set(normalized, entry.ticker);
        return entry.ticker;
      }
    }

    const firstWord = normalized.split(/[\s,]+/)[0];
    for (const entry of entries) {
      if (entry.title.toUpperCase().startsWith(firstWord || "")) {
        companyToTickerCache.set(normalized, entry.ticker);
        return entry.ticker;
      }
    }

    companyToTickerCache.set(normalized, null);
    return null;
  } catch {
    return null;
  }
}

function getSecFormSentiment(form: string): { sentiment: number; sourceWeight: number; detail: string } {
  if (form === "8-K") {
    return { sentiment: 0.3, sourceWeight: SOURCE_CONFIG.weights.sec_8k, detail: "sec_8k" };
  }
  if (form === "4") {
    return { sentiment: 0.24, sourceWeight: SOURCE_CONFIG.weights.sec_4, detail: "sec_form4" };
  }
  if (form === "13D" || form === "13G") {
    return { sentiment: 0.22, sourceWeight: SOURCE_CONFIG.weights.sec_13f, detail: `sec_${form.toLowerCase()}` };
  }
  if (form === "S-1") {
    return { sentiment: 0.18, sourceWeight: SOURCE_CONFIG.weights.sec_major_filing, detail: "sec_s1" };
  }
  if (form === "10-Q" || form === "10-K") {
    return { sentiment: 0.14, sourceWeight: SOURCE_CONFIG.weights.sec_major_filing, detail: `sec_${form.toLowerCase().replace("-", "")}` };
  }
  return { sentiment: 0.12, sourceWeight: SOURCE_CONFIG.weights.sec_major_filing, detail: `sec_${form.toLowerCase().replace("-", "")}` };
}

async function fetchSecFeed(form: string, ctx: StrategyContext): Promise<Array<{
  id: string;
  title: string;
  updated: string;
  form: string;
  company: string;
}>> {
  const response = await fetch(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&count=40&output=atom`,
    {
      headers: {
        "User-Agent": "Mahoraga Trading Bot (contact@example.com)",
        Accept: "application/atom+xml",
      },
    }
  );

  if (!response.ok) {
    ctx.log("SEC", "fetch_error", { form, status: response.status });
    return [];
  }

  return parseSECAtomFeed(await response.text());
}

// ── Gatherer ─────────────────────────────────────────────────────────────────

async function gatherSECFilings(ctx: StrategyContext): Promise<Signal[]> {
  const signals: Signal[] = [];

  try {
    const formResults = await Promise.all(SEC_FORMS.map((form) => fetchSecFeed(form, ctx)));
    const entries = formResults.flat();
    const seen = new Set<string>();

    const alpaca = createAlpacaProviders(ctx.env);

    for (const entry of entries.slice(0, 50)) {
      const dedupeKey = `${entry.company}:${entry.form}:${entry.updated}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const ticker = await resolveTickerFromCompanyName(ctx, entry.company);
      if (!ticker) continue;

      const cached = tickerCache.getCachedValidation(ticker);
      if (cached === false) continue;
      if (cached === undefined) {
        const isValid = await tickerCache.validateWithAlpaca(ticker, alpaca);
        if (!isValid) continue;
      }

      const formSignal = getSecFormSentiment(entry.form);
      const filingSignal = classifySECFilingSentiment(entry);
      const freshness = calculateSECFreshness(entry.updated);
      const rawSentiment =
        Math.abs(filingSignal.sentiment) > Math.abs(formSignal.sentiment)
          ? filingSignal.sentiment
          : formSignal.sentiment;

      const weightedSentiment = rawSentiment * formSignal.sourceWeight * freshness;

      signals.push({
        symbol: ticker,
        source: "sec_edgar",
        source_detail: `${formSignal.detail}:${filingSignal.label}`,
        sentiment: weightedSentiment,
        raw_sentiment: rawSentiment,
        volume: 1,
        freshness,
        source_weight: formSignal.sourceWeight,
        quality_score: filingSignal.qualityScore,
        reason: `SEC ${entry.form}: ${entry.company.slice(0, 50)}`,
        timestamp: Date.now(),
      });
    }

    ctx.log("SEC", "gathered_signals", { count: signals.length, entries: entries.length, forms: SEC_FORMS.join(",") });
  } catch (error) {
    ctx.log("SEC", "error", { message: String(error) });
  }

  return signals;
}

export const secGatherer: Gatherer = {
  name: "sec",
  gather: gatherSECFilings,
};
