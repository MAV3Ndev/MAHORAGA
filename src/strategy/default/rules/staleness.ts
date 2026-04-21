/**
 * Staleness detection — identifies positions that have lost momentum.
 *
 * Scored 0-100 based on:
 * - Time held (vs max hold days)
 * - Price action (P&L vs targets)
 * - Social volume decay (vs entry volume)
 */

import type { AgentConfig, PositionEntry } from "../../../core/types";

export interface StalenessResult {
  isStale: boolean;
  reason: string;
  staleness_score: number;
}

export function analyzeStaleness(
  _symbol: string,
  currentPrice: number,
  currentSocialVolume: number,
  entry: PositionEntry | undefined,
  config: AgentConfig
): StalenessResult {
  if (!entry) {
    return { isStale: false, reason: "No entry data", staleness_score: 0 };
  }

  const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
  const holdDays = holdHours / 24;
  const pnlPct = entry.entry_price > 0 ? ((currentPrice - entry.entry_price) / entry.entry_price) * 100 : 0;

  if (holdHours < config.stale_min_hold_hours) {
    return { isStale: false, reason: `Too early (${holdHours.toFixed(1)}h)`, staleness_score: 0 };
  }

  let stalenessScore = 0;
  let timeScore = 0;
  let priceScore = 0;
  let socialScore = 0;
  const staleMidHoldDays = Number.isFinite(config.stale_mid_hold_days) ? config.stale_mid_hold_days : config.stale_max_hold_days;
  const staleMaxHoldDays = Number.isFinite(config.stale_max_hold_days) ? config.stale_max_hold_days : staleMidHoldDays;
  const staleTimeWindowDays = staleMaxHoldDays - staleMidHoldDays;

  // Time-based (max 40 points)
  if (holdDays >= staleMaxHoldDays) {
    timeScore = 40;
  } else if (holdDays >= staleMidHoldDays) {
    timeScore = staleTimeWindowDays > 0
      ? (20 * (holdDays - staleMidHoldDays)) / staleTimeWindowDays
      : 20;
  }
  stalenessScore += timeScore;

  // Price action (max 30 points)
  if (pnlPct < 0) {
    priceScore = Math.min(30, Math.abs(pnlPct) * 3);
  } else if (pnlPct < config.stale_mid_min_gain_pct && holdDays >= staleMidHoldDays) {
    priceScore = 15;
  }
  stalenessScore += priceScore;

  // Social volume decay (max 30 points)
  const volumeRatio = entry.entry_social_volume > 0 ? currentSocialVolume / entry.entry_social_volume : 1;
  if (volumeRatio <= config.stale_social_volume_decay) {
    socialScore = 30;
  } else if (volumeRatio <= 0.5) {
    socialScore = 15;
  }
  stalenessScore += socialScore;

  stalenessScore = Number.isFinite(stalenessScore) ? Math.min(100, stalenessScore) : 0;

  const staleByScore = stalenessScore >= 70;
  const staleByAging = holdDays >= staleMaxHoldDays && pnlPct < config.stale_min_gain_pct;
  const isStale = staleByScore || staleByAging;

  let reason: string;
  if (isStale) {
    if (staleByAging) {
      reason = `Held ${holdDays.toFixed(1)} days with P&L ${pnlPct.toFixed(1)}% below stale target ${config.stale_min_gain_pct.toFixed(1)}%`;
    } else {
      reason = `Score ${stalenessScore}/100 (time ${timeScore.toFixed(0)}, price ${priceScore.toFixed(0)}, social ${socialScore.toFixed(0)})`;
    }
  } else {
    reason = `OK (score ${stalenessScore}/100, hold ${holdDays.toFixed(1)}d, pnl ${pnlPct.toFixed(1)}%)`;
  }

  return {
    isStale,
    reason,
    staleness_score: stalenessScore,
  };
}
