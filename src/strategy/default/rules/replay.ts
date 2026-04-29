export interface ReplayBar {
  symbol: string;
  timestamp: number;
  price: number;
}

export interface ReplayOrder {
  symbol: string;
  timestamp: number;
  side: "BUY" | "SELL";
  notional?: number;
  reason?: string;
}

export interface ReplayTrade {
  symbol: string;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  reason?: string;
}

export interface ReplayResult {
  trades: ReplayTrade[];
  openPositions: Record<string, { quantity: number; avgEntryPrice: number; marketValue: number }>;
  realizedPnl: number;
  endingEquity: number;
}

interface ReplayPosition {
  quantity: number;
  avgEntryPrice: number;
  entryTimestamp: number;
  notional: number;
}

export function replayOrders(initialCash: number, bars: ReplayBar[], orders: ReplayOrder[]): ReplayResult {
  const sortedBars = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const sortedOrders = [...orders].sort((a, b) => a.timestamp - b.timestamp);
  const latestPrices: Record<string, number> = {};
  const positions: Record<string, ReplayPosition> = {};
  const trades: ReplayTrade[] = [];
  let cash = initialCash;
  let realizedPnl = 0;
  let barIndex = 0;

  for (const order of sortedOrders) {
    while (barIndex < sortedBars.length && sortedBars[barIndex]!.timestamp <= order.timestamp) {
      latestPrices[sortedBars[barIndex]!.symbol] = sortedBars[barIndex]!.price;
      barIndex++;
    }

    const price = latestPrices[order.symbol];
    if (!price || price <= 0) continue;

    if (order.side === "BUY") {
      const notional = Math.min(order.notional ?? cash, cash);
      if (notional <= 0) continue;

      const quantity = notional / price;
      const existing = positions[order.symbol];
      if (existing) {
        const combinedQuantity = existing.quantity + quantity;
        existing.avgEntryPrice = (existing.avgEntryPrice * existing.quantity + price * quantity) / combinedQuantity;
        existing.quantity = combinedQuantity;
        existing.notional += notional;
      } else {
        positions[order.symbol] = {
          quantity,
          avgEntryPrice: price,
          entryTimestamp: order.timestamp,
          notional,
        };
      }
      cash -= notional;
      continue;
    }

    const position = positions[order.symbol];
    if (!position) continue;

    const proceeds = position.quantity * price;
    const cost = position.quantity * position.avgEntryPrice;
    const pnl = proceeds - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    cash += proceeds;
    realizedPnl += pnl;
    trades.push({
      symbol: order.symbol,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: order.timestamp,
      entryPrice: position.avgEntryPrice,
      exitPrice: price,
      quantity: position.quantity,
      pnl,
      pnlPct,
      reason: order.reason,
    });
    delete positions[order.symbol];
  }

  for (; barIndex < sortedBars.length; barIndex++) {
    latestPrices[sortedBars[barIndex]!.symbol] = sortedBars[barIndex]!.price;
  }

  const openPositions: ReplayResult["openPositions"] = {};
  let openMarketValue = 0;
  for (const [symbol, position] of Object.entries(positions)) {
    const price = latestPrices[symbol] ?? position.avgEntryPrice;
    const marketValue = position.quantity * price;
    openMarketValue += marketValue;
    openPositions[symbol] = {
      quantity: position.quantity,
      avgEntryPrice: position.avgEntryPrice,
      marketValue,
    };
  }

  return {
    trades,
    openPositions,
    realizedPnl,
    endingEquity: cash + openMarketValue,
  };
}
