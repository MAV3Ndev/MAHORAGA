export function limitTimestampedRecord<T extends { timestamp?: number }>(
  records: Record<string, T>,
  maxEntries: number
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(records)
      .sort(([, a], [, b]) => (b?.timestamp || 0) - (a?.timestamp || 0))
      .slice(0, maxEntries)
  );
}

export function filterRecordBySymbols<T>(records: Record<string, T>, symbols: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([symbol]) => symbols.has(symbol)));
}
