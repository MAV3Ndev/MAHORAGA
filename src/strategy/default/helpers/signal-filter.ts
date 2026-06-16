import { getCryptoSymbolAliases, isCryptoSymbol, normalizeCryptoSymbol } from "../../../core/asset-symbols";
import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { StrategyContext } from "../../types";
import {
  isBroadMarketProxyTicker,
  isBuiltInTickerBlacklisted,
  isCustomTickerBlacklisted,
  isTickerBlacklisted,
  shouldRescueBuiltInBlacklistedTicker,
  tickerCache,
} from "./ticker";

export async function prepareDefaultDataGathering(): Promise<void> {
  await tickerCache.refreshSecTickersIfNeeded();
}

export async function filterDefaultEligibleSignals(ctx: StrategyContext, signals: Signal[]): Promise<Signal[]> {
  const alpaca = createAlpacaProviders(ctx.env);
  const filtered: Signal[] = [];

  for (const signal of signals) {
    const symbol = signal.symbol?.toUpperCase().trim();
    if (!symbol) continue;

    if (isBroadMarketProxyTicker(symbol)) {
      ctx.log("System", "signal_filtered_broad_market_proxy", { symbol });
      continue;
    }

    if (signal.isCrypto || isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
      if (isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
        filtered.push({ ...signal, symbol: normalizeCryptoSymbol(symbol), isCrypto: true });
      } else {
        ctx.log("System", "signal_filtered_unconfigured_crypto", { symbol });
      }
      continue;
    }

    const customBlacklisted = isCustomTickerBlacklisted(symbol, ctx.config.ticker_blacklist);
    const builtInBlacklisted = isBuiltInTickerBlacklisted(symbol);
    const blacklisted = builtInBlacklisted || customBlacklisted;

    if (tickerCache.isKnownSecTicker(symbol)) {
      if (
        isTickerBlacklisted(symbol, ctx.config.ticker_blacklist) &&
        !shouldRescueBuiltInBlacklistedTicker(symbol, {
          customBlacklist: ctx.config.ticker_blacklist,
          knownSecTicker: true,
        })
      ) {
        ctx.log("System", "signal_filtered_blacklist", { symbol });
        continue;
      }
      if (
        shouldRescueBuiltInBlacklistedTicker(symbol, {
          customBlacklist: ctx.config.ticker_blacklist,
          knownSecTicker: true,
        })
      ) {
        ctx.log("System", "signal_rescued_builtin_blacklist", { symbol, source: "sec" });
      }
      filtered.push({ ...signal, symbol });
      continue;
    }

    if (blacklisted && customBlacklisted) {
      ctx.log("System", "signal_filtered_blacklist", { symbol });
      continue;
    }

    const cached = tickerCache.getCachedValidation(symbol);
    const isValid = cached ?? (await tickerCache.validateWithAlpaca(symbol, alpaca));
    if (!isValid) {
      if (blacklisted) {
        ctx.log("System", "signal_filtered_blacklist", { symbol });
      } else {
        ctx.log("System", "signal_filtered_invalid_ticker", { symbol });
      }
      continue;
    }

    if (
      shouldRescueBuiltInBlacklistedTicker(symbol, {
        customBlacklist: ctx.config.ticker_blacklist,
        alpacaValid: true,
      })
    ) {
      ctx.log("System", "signal_rescued_builtin_blacklist", { symbol, source: "alpaca" });
    }

    filtered.push({ ...signal, symbol });
  }

  return filtered;
}

export function getDefaultTrackedSymbolAliases(symbol: string, cryptoSymbols: string[]): string[] {
  return isCryptoSymbol(symbol, cryptoSymbols) ? getCryptoSymbolAliases(symbol) : [symbol];
}
