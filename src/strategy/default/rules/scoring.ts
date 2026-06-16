/**
 * Composite Scoring System — multi-factor evaluation of signals.
 *
 * Combines sentiment, technical, catalyst, and momentum factors
 * to produce a unified score (0-1).
 */

import type { ResearchResult, Signal } from "../../../core/types";

export interface ScoringWeights {
  sentiment: number;
  technical: number;
  catalyst: number;
  momentum: number;
}

export interface SignalMomentumData {
  priceChange1h?: number;
  priceChange24h?: number;
  volumeChange?: number;
}

export interface ScoredSignal extends ResearchResult {
  compositeScore: number;
  scoringBreakdown: {
    sentimentScore: number;
    technicalScore: number;
    catalystScore: number;
    momentumScore: number;
  };
}

/**
 * Calculate momentum score from price/volume changes.
 */
function calculateMomentumScore(momentum: SignalMomentumData): number {
  let score = 0.5; // neutral baseline

  // 24h price momentum (max 0.3)
  if (momentum.priceChange24h !== undefined) {
    if (momentum.priceChange24h > 5) score += 0.3;
    else if (momentum.priceChange24h > 2) score += 0.2;
    else if (momentum.priceChange24h > 0) score += 0.1;
    else if (momentum.priceChange24h < -5) score -= 0.3;
    else if (momentum.priceChange24h < -2) score -= 0.2;
  }

  // 1h price momentum (max 0.2)
  if (momentum.priceChange1h !== undefined) {
    if (momentum.priceChange1h > 2) score += 0.2;
    else if (momentum.priceChange1h > 0.5) score += 0.1;
    else if (momentum.priceChange1h < -2) score -= 0.2;
    else if (momentum.priceChange1h < -0.5) score -= 0.1;
  }

  // Volume surge (max 0.1)
  if (momentum.volumeChange !== undefined && momentum.volumeChange > 2) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate catalyst score from research result catalysts.
 */
function calculateCatalystScore(catalysts: string[] | undefined): number {
  if (!catalysts || catalysts.length === 0) return 0.3;

  // Strong catalysts boost score
  const strongCatalysts = catalysts.filter((c) =>
    /earnings|FDA| lawsuit|acquisition|merger|partnership|approval|recall/i.test(c)
  );
  const moderateCatalysts = catalysts.filter((c) => /upgrade|downgrade|initiation|coverage|target|forecast/i.test(c));

  let score = 0.4; // base with catalysts
  score += Math.min(0.3, strongCatalysts.length * 0.15);
  score += Math.min(0.3, moderateCatalysts.length * 0.1);

  return Math.min(1, score);
}

/**
 * Apply composite scoring to research results.
 *
 * @param results LLM research results
 * @param signals Raw signals for sentiment scoring
 * @param momentumData Price/volume momentum per symbol
 * @param weights Scoring weights (should sum to 1)
 */
export function applyCompositeScoring(
  results: ResearchResult[],
  signals: Signal[],
  momentumData: Record<string, SignalMomentumData>,
  weights: ScoringWeights
): ScoredSignal[] {
  // Build sentiment score map from signals
  const sentimentScores: Record<string, number> = {};
  for (const sig of signals) {
    const existing = sentimentScores[sig.symbol];
    const score = sig.sentiment;
    if (existing === undefined || Math.abs(score) > Math.abs(existing)) {
      sentimentScores[sig.symbol] = score;
    }
  }

  const scored: ScoredSignal[] = [];

  for (const r of results) {
    // Sentiment score (0-1)
    const rawSentiment = sentimentScores[r.symbol] ?? 0;
    const sentimentScore = (rawSentiment + 1) / 2; // -1..1 → 0..1

    // Technical score derived from entry quality
    let technicalScore = 0.5;
    if (r.entry_quality === "excellent") technicalScore = 0.9;
    else if (r.entry_quality === "good") technicalScore = 0.7;
    else if (r.entry_quality === "fair") technicalScore = 0.5;
    else if (r.entry_quality === "poor") technicalScore = 0.2;

    // Catalyst score
    const catalystScore = calculateCatalystScore(r.catalysts);

    // Momentum score
    const momentumScore = calculateMomentumScore(momentumData[r.symbol] ?? {});

    // Weighted composite
    const compositeScore =
      sentimentScore * weights.sentiment +
      technicalScore * weights.technical +
      catalystScore * weights.catalyst +
      momentumScore * weights.momentum;

    scored.push({
      ...r,
      compositeScore: Math.max(0, Math.min(1, compositeScore)),
      scoringBreakdown: {
        sentimentScore,
        technicalScore,
        catalystScore,
        momentumScore,
      },
    });
  }

  // Re-sort by composite score
  return scored.sort((a, b) => b.compositeScore - a.compositeScore);
}
