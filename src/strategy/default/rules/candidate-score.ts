import type { ResearchResult, Signal } from "../../../core/types";
import type { SignalMomentumData } from "./scoring";

export interface CandidateScoreBreakdown {
  researchScore: number;
  sentimentScore: number;
  signalQualityScore: number;
  momentumScore: number;
  redFlagPenalty: number;
}

export interface CandidateScore {
  symbol: string;
  score: number;
  signals: Signal[];
  sources: string[];
  sentiment: number;
  quality: number;
  breakdown: CandidateScoreBreakdown;
}

export interface CandidateScoreWeights {
  research: number;
  sentiment: number;
  signalQuality: number;
  momentum: number;
}

const DEFAULT_WEIGHTS: CandidateScoreWeights = {
  research: 0.35,
  sentiment: 0.25,
  signalQuality: 0.25,
  momentum: 0.15,
};

export function aggregateSignalsBySymbol(signals: Signal[]): Record<string, Signal[]> {
  const grouped: Record<string, Signal[]> = {};
  for (const signal of signals) {
    grouped[signal.symbol] ??= [];
    grouped[signal.symbol]!.push(signal);
  }
  return grouped;
}

export function getSignalQualityScore(signal: Signal): number {
  const explicitQuality = clamp01(signal.quality_score ?? signal.source_weight ?? 0.5);
  const freshness = clamp01(signal.freshness ?? 0.5);
  const volumeScore = Math.min(1, Math.log10(Math.max(1, signal.volume) + 1) / 2);

  const directionalVotes = (signal.bullish ?? 0) + (signal.bearish ?? 0);
  const agreement =
    directionalVotes > 0 ? Math.abs((signal.bullish ?? 0) - (signal.bearish ?? 0)) / directionalVotes : 0.5;

  return clamp01(explicitQuality * 0.35 + freshness * 0.25 + volumeScore * 0.25 + agreement * 0.15);
}

export function calculateSignalGroupQuality(signals: Signal[]): number {
  if (signals.length === 0) return 0;

  const totalWeight = signals.reduce((sum, signal) => sum + Math.max(1, signal.volume), 0);
  const weightedQuality = signals.reduce(
    (sum, signal) => sum + getSignalQualityScore(signal) * Math.max(1, signal.volume),
    0
  );
  const sourceDiversityBonus = Math.min(0.12, new Set(signals.map((signal) => signal.source)).size * 0.04);

  return clamp01(weightedQuality / Math.max(1, totalWeight) + sourceDiversityBonus);
}

export function calculateCandidateScores(
  research: ResearchResult[],
  signals: Signal[],
  momentumData: Record<string, SignalMomentumData> = {},
  weights: CandidateScoreWeights = DEFAULT_WEIGHTS
): CandidateScore[] {
  const groupedSignals = aggregateSignalsBySymbol(signals);
  const normalizedWeights = normalizeWeights(weights);

  return research
    .map((result) => {
      const symbolSignals = groupedSignals[result.symbol] ?? [];
      const researchScore = getResearchScore(result);
      const sentimentScore = getSentimentScore(result, symbolSignals);
      const signalQualityScore = calculateSignalGroupQuality(symbolSignals);
      const momentumScore = calculateMomentumScore(momentumData[result.symbol]);
      const redFlagPenalty = Math.min(0.35, result.red_flags.length * 0.12);

      const rawScore =
        researchScore * normalizedWeights.research +
        sentimentScore * normalizedWeights.sentiment +
        signalQualityScore * normalizedWeights.signalQuality +
        momentumScore * normalizedWeights.momentum -
        redFlagPenalty;

      const sentiment = getWeightedSentiment(symbolSignals, result.sentiment ?? 0);

      return {
        symbol: result.symbol,
        score: clamp01(rawScore),
        signals: symbolSignals,
        sources: Array.from(new Set(symbolSignals.map((signal) => signal.source))),
        sentiment,
        quality: signalQualityScore,
        breakdown: {
          researchScore,
          sentimentScore,
          signalQualityScore,
          momentumScore,
          redFlagPenalty,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

function normalizeWeights(weights: CandidateScoreWeights): CandidateScoreWeights {
  const total = weights.research + weights.sentiment + weights.signalQuality + weights.momentum;
  if (total <= 0) return DEFAULT_WEIGHTS;

  return {
    research: weights.research / total,
    sentiment: weights.sentiment / total,
    signalQuality: weights.signalQuality / total,
    momentum: weights.momentum / total,
  };
}

export function rankSignalCandidates(
  signals: Signal[],
  minRawSentiment: number,
  minSignalQuality: number,
  limit: number
): CandidateScore[] {
  const groupedSignals = aggregateSignalsBySymbol(signals);

  return Object.entries(groupedSignals)
    .map(([symbol, symbolSignals]) => {
      const quality = calculateSignalGroupQuality(symbolSignals);
      const sentiment = getWeightedSentiment(symbolSignals, 0);
      const rawSentiment = getWeightedRawSentiment(symbolSignals);
      const sentimentScore = clamp01((rawSentiment + 1) / 2);
      const volumeScore = Math.min(
        1,
        Math.log10(symbolSignals.reduce((sum, signal) => sum + signal.volume, 0) + 1) / 2
      );
      const score = clamp01(sentimentScore * 0.45 + quality * 0.4 + volumeScore * 0.15);

      return {
        symbol,
        score,
        signals: symbolSignals,
        sources: Array.from(new Set(symbolSignals.map((signal) => signal.source))),
        sentiment,
        quality,
        breakdown: {
          researchScore: 0,
          sentimentScore,
          signalQualityScore: quality,
          momentumScore: volumeScore,
          redFlagPenalty: 0,
        },
      };
    })
    .filter((candidate) => getWeightedRawSentiment(candidate.signals) >= minRawSentiment)
    .filter((candidate) => candidate.quality >= minSignalQuality)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function getResearchScore(result: ResearchResult): number {
  const qualityScore = {
    excellent: 1,
    good: 0.78,
    fair: 0.55,
    poor: 0.2,
  }[result.entry_quality];

  const verdictScore = result.verdict === "BUY" ? 1 : result.verdict === "WAIT" ? 0.65 : 0.1;
  return clamp01(result.confidence * 0.65 + qualityScore * 0.25 + verdictScore * 0.1);
}

function getSentimentScore(result: ResearchResult, signals: Signal[]): number {
  const sentiment = getWeightedRawSentiment(signals, result.sentiment ?? 0);
  return clamp01((sentiment + 1) / 2);
}

function getWeightedSentiment(signals: Signal[], fallback: number): number {
  if (signals.length === 0) return fallback;

  const totalWeight = signals.reduce(
    (sum, signal) => sum + Math.max(1, signal.volume) * getSignalQualityScore(signal),
    0
  );
  if (totalWeight <= 0) return fallback;

  return (
    signals.reduce(
      (sum, signal) => sum + signal.sentiment * Math.max(1, signal.volume) * getSignalQualityScore(signal),
      0
    ) / totalWeight
  );
}

function getWeightedRawSentiment(signals: Signal[], fallback = 0): number {
  if (signals.length === 0) return fallback;

  const totalWeight = signals.reduce(
    (sum, signal) => sum + Math.max(1, signal.volume) * getSignalQualityScore(signal),
    0
  );
  if (totalWeight <= 0) return fallback;

  return (
    signals.reduce(
      (sum, signal) => sum + signal.raw_sentiment * Math.max(1, signal.volume) * getSignalQualityScore(signal),
      0
    ) / totalWeight
  );
}

function calculateMomentumScore(momentum?: SignalMomentumData): number {
  if (!momentum) return 0.5;

  let score = 0.5;
  if (momentum.priceChange24h !== undefined) {
    if (momentum.priceChange24h >= 5) score += 0.25;
    else if (momentum.priceChange24h >= 2) score += 0.15;
    else if (momentum.priceChange24h <= -5) score -= 0.25;
    else if (momentum.priceChange24h <= -2) score -= 0.15;
  }
  if (momentum.priceChange1h !== undefined) {
    if (momentum.priceChange1h >= 2) score += 0.15;
    else if (momentum.priceChange1h >= 0.5) score += 0.08;
    else if (momentum.priceChange1h <= -2) score -= 0.15;
    else if (momentum.priceChange1h <= -0.5) score -= 0.08;
  }
  if (momentum.volumeChange !== undefined && momentum.volumeChange > 2) score += 0.1;

  return clamp01(score);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
