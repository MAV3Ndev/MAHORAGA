/**
 * Portfolio Risk Management — sector concentration limits.
 *
 * Limits maximum positions per sector to prevent over-concentration.
 */

import type { Position } from "../../../core/types";

export interface SectorAllocation {
  sector: string;
  positions: string[];
  count: number;
}

export interface PortfolioRiskResult {
  allowed: boolean;
  reason: string;
  sectorAllocations: SectorAllocation[];
  overConcentratedSectors: string[];
}

/**
 * Check if adding a new position would create sector over-concentration.
 *
 * @param symbol Symbol to add
 * @param sectorMap Map of symbols to their sectors
 * @param positions Current positions
 * @param config Configuration with max_positions_per_sector
 */
export function checkPortfolioRisk(
  symbol: string,
  sectorMap: Record<string, string>,
  positions: Position[],
  config: {
    portfolio_risk_enabled: boolean;
    max_positions_per_sector: number;
  }
): PortfolioRiskResult {
  if (!config.portfolio_risk_enabled) {
    return {
      allowed: true,
      reason: "Portfolio risk disabled",
      sectorAllocations: [],
      overConcentratedSectors: [],
    };
  }

  // Build current sector allocations
  const sectorCounts: Record<string, string[]> = {};
  for (const pos of positions) {
    const sector = sectorMap[pos.symbol] ?? "unknown";
    if (!sectorCounts[sector]) {
      sectorCounts[sector] = [];
    }
    sectorCounts[sector].push(pos.symbol);
  }

  // Check proposed addition
  const proposedSector = sectorMap[symbol] ?? "unknown";
  if (proposedSector === "unknown") {
    return {
      allowed: true,
      reason: 'Sector unknown - concentration limit skipped until sector data is available',
      sectorAllocations: Object.entries(sectorCounts).map(([sector, symbols]) => ({
        sector,
        positions: symbols,
        count: symbols.length,
      })),
      overConcentratedSectors: [],
    };
  }

  const currentCount = sectorCounts[proposedSector]?.length ?? 0;

  if (currentCount >= config.max_positions_per_sector) {
    const overConcentrated = Object.entries(sectorCounts)
      .filter(([, symbols]) => symbols.length >= config.max_positions_per_sector)
      .map(([sector]) => sector);

    return {
      allowed: false,
      reason: `Sector "${proposedSector}" would exceed max ${config.max_positions_per_sector} positions`,
      sectorAllocations: Object.entries(sectorCounts).map(([sector, symbols]) => ({
        sector,
        positions: symbols,
        count: symbols.length,
      })),
      overConcentratedSectors: overConcentrated,
    };
  }

  // Add proposed symbol to allocation
  if (!sectorCounts[proposedSector]) {
    sectorCounts[proposedSector] = [];
  }
  sectorCounts[proposedSector].push(symbol);

  return {
    allowed: true,
    reason: `Sector "${proposedSector}" has ${currentCount}/${config.max_positions_per_sector} positions`,
    sectorAllocations: Object.entries(sectorCounts).map(([sector, symbols]) => ({
      sector,
      positions: symbols,
      count: symbols.length,
    })),
    overConcentratedSectors: [],
  };
}
