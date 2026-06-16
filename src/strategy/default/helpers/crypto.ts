import {
  areEquivalentAssetSymbols,
  compactCryptoSymbol,
  getCryptoSymbolAliases,
  isCryptoSymbol,
  normalizeCryptoSymbol,
} from "../../../core/asset-symbols";

export {
  areEquivalentAssetSymbols,
  compactCryptoSymbol,
  getCryptoSymbolAliases,
  isCryptoSymbol,
  normalizeCryptoSymbol,
};

export function isConfiguredCryptoSymbol(symbol: string, configuredSymbols: string[] = []): boolean {
  const normalized = normalizeCryptoSymbol(symbol);
  return configuredSymbols.some((configured) => normalizeCryptoSymbol(configured) === normalized);
}

export function isStockTwitsCryptoSymbol(symbol: string, configuredSymbols: string[] = []): boolean {
  if (isConfiguredCryptoSymbol(symbol, configuredSymbols)) return true;
  return getCryptoSymbolAliases(symbol).some((alias) => alias.includes(".X") || alias.endsWith("USD"));
}
