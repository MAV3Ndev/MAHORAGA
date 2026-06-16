/**
 * Crypto symbol helpers for the default strategy.
 *
 * Pure functions — no side effects, no state.
 */

/** Normalize a crypto symbol to SYMBOL/QUOTE format (e.g., "BTCUSD" → "BTC/USD"). */
export function normalizeCryptoSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();

  if (normalized.includes("/")) {
    return normalized;
  }

  const stockTwitsMatch = normalized.match(/^([A-Z0-9]{2,15})\.X$/);
  if (stockTwitsMatch) {
    return `${stockTwitsMatch[1]}/USD`;
  }

  const match = normalized.match(/^([A-Z]{2,5})(USD|USDT|USDC)$/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return normalized;
}

/** Check if a symbol is a StockTwits crypto ticker such as BTC.X. */
export function isStockTwitsCryptoSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,15}\.X$/i.test(symbol.trim());
}

/** Check if a crypto symbol is explicitly configured for trading. */
export function isConfiguredCryptoSymbol(symbol: string, cryptoSymbols: string[]): boolean {
  const normalizedInput = normalizeCryptoSymbol(symbol);
  return cryptoSymbols.some((configSymbol) => normalizeCryptoSymbol(configSymbol) === normalizedInput);
}

/** Check if a symbol is a configured crypto symbol. */
export function isCryptoSymbol(symbol: string, cryptoSymbols: string[]): boolean {
  const normalizedInput = normalizeCryptoSymbol(symbol);
  if (isConfiguredCryptoSymbol(symbol, cryptoSymbols)) return true;
  return /^[A-Z]{2,5}\/(USD|USDT|USDC)$/.test(normalizedInput);
}
