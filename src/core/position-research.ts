import type { Position } from "../providers/types";

export function getPositionResearchCandidates(positions: Position[], marketOpen: boolean): Position[] {
  return positions.filter((position) => {
    if (position.asset_class === "us_option") return false;
    if (marketOpen) return true;
    return position.asset_class === "crypto";
  });
}

export function shouldRunPositionResearch(
  positions: Position[],
  marketOpen: boolean,
  now: number,
  lastRun: number,
  intervalMs: number
): boolean {
  if (now - lastRun < intervalMs) return false;
  return getPositionResearchCandidates(positions, marketOpen).length > 0;
}
