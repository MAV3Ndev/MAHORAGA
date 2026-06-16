/**
 * Options trading utilities for the default strategy.
 *
 * Used by the core harness when a BuyCandidate has useOptions: true.
 * These are standalone helpers, not part of selectEntries/selectExits.
 */

import { createAlpacaProviders } from "../../../providers/alpaca";
import type { StrategyContext } from "../../types";

export interface OptionsContract {
  symbol: string;
  strike: number;
  expiration: string;
  delta: number;
  mid_price: number;
  max_contracts: number;
}

export interface ParsedOptionSymbol {
  underlying: string;
  expiration: string;
  optionType: "call" | "put";
  strike: number;
}

/**
 * Parse compact OCC-style option symbols such as AAPL260619C00195000.
 */
export function parseOccOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const normalized = symbol.trim().toUpperCase().replace(/\s+/g, "");
  const match = normalized.match(/^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!match) return null;

  const [, underlying, yymmdd, contractType, rawStrike] = match;
  if (!underlying || !yymmdd || !contractType || !rawStrike) return null;

  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = yymmdd.slice(2, 4);
  const day = yymmdd.slice(4, 6);
  const expiration = `${year}-${month}-${day}`;
  const expirationTime = new Date(`${expiration}T00:00:00Z`).getTime();
  const strike = Number(rawStrike) / 1000;

  if (!Number.isFinite(expirationTime) || !Number.isFinite(strike) || strike <= 0) return null;

  return {
    underlying,
    expiration,
    optionType: contractType === "C" ? "call" : "put",
    strike,
  };
}

/**
 * Find the best options contract for a symbol based on direction and delta targets.
 */
export async function findBestOptionsContract(
  ctx: StrategyContext,
  symbol: string,
  direction: "bullish" | "bearish",
  equity: number
): Promise<OptionsContract | null> {
  if (!ctx.config.options_enabled) return null;

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const expirations = await alpaca.options.getExpirations(symbol);

    if (!expirations || expirations.length === 0) {
      ctx.log("Options", "no_expirations", { symbol });
      return null;
    }

    const today = new Date();
    const validExpirations = expirations.filter((exp) => {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return dte >= ctx.config.options_min_dte && dte <= ctx.config.options_max_dte;
    });

    if (validExpirations.length === 0) {
      ctx.log("Options", "no_valid_expirations", { symbol });
      return null;
    }

    const targetDTE = (ctx.config.options_min_dte + ctx.config.options_max_dte) / 2;
    const bestExpiration = validExpirations.reduce((best: string, exp: string) => {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const currentBestDte = Math.ceil((new Date(best).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return Math.abs(dte - targetDTE) < Math.abs(currentBestDte - targetDTE) ? exp : best;
    }, validExpirations[0]!);

    const chain = await alpaca.options.getChain(symbol, bestExpiration);
    if (!chain) {
      ctx.log("Options", "chain_failed", { symbol, expiration: bestExpiration });
      return null;
    }

    const contracts = direction === "bullish" ? chain.calls : chain.puts;
    if (!contracts || contracts.length === 0) {
      ctx.log("Options", "no_contracts", { symbol, direction });
      return null;
    }

    const snapshot = await alpaca.marketData.getSnapshot(symbol).catch(() => null);
    const stockPrice =
      snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
    if (stockPrice === 0) return null;

    const targetStrike =
      direction === "bullish"
        ? stockPrice * (1 - (ctx.config.options_target_delta - 0.5) * 0.2)
        : stockPrice * (1 + (ctx.config.options_target_delta - 0.5) * 0.2);

    const sortedContracts = contracts
      .filter((c) => c.strike > 0)
      .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));

    for (const contract of sortedContracts.slice(0, 5)) {
      const optSnapshot = await alpaca.options.getSnapshot(contract.symbol);
      if (!optSnapshot) continue;

      const delta = optSnapshot.greeks?.delta;
      const absDelta = delta !== undefined ? Math.abs(delta) : null;

      if (absDelta === null || absDelta < ctx.config.options_min_delta || absDelta > ctx.config.options_max_delta) {
        continue;
      }

      const bid = optSnapshot.latest_quote?.bid_price || 0;
      const ask = optSnapshot.latest_quote?.ask_price || 0;
      if (bid === 0 || ask === 0) continue;

      const spreadPct = ((ask - bid) / ask) * 100;
      if (spreadPct > (ctx.config.options_max_spread_pct ?? 8)) continue;

      const midPrice = (bid + ask) / 2;
      const maxCost = equity * ctx.config.options_max_pct_per_trade;
      const maxContracts = Math.floor(maxCost / (midPrice * 100));

      if (maxContracts < 1) continue;

      ctx.log("Options", "contract_selected", {
        symbol,
        contract: contract.symbol,
        strike: contract.strike,
        expiration: bestExpiration,
        delta: delta?.toFixed(3),
        mid_price: midPrice.toFixed(2),
      });

      return {
        symbol: contract.symbol,
        strike: contract.strike,
        expiration: bestExpiration,
        delta: delta!,
        mid_price: midPrice,
        max_contracts: maxContracts,
      };
    }

    return null;
  } catch (error) {
    ctx.log("Options", "error", { symbol, message: String(error) });
    return null;
  }
}
