import { describe, expect, it, vi } from "vitest";
import { getDefaultPolicyConfig } from "../policy/config";
import {
  computeCappedBuyNotional,
  computeHaltLimitPrice,
  createPolicyBroker,
  isTradingHaltMarketOrderError,
  isWithinExtendedHoursSession,
  shouldBlockEquityEntryNearClose,
} from "./policy-broker";

function createDeps(overrides?: {
  clock?: Partial<{ timestamp: string; is_open: boolean; next_open: string; next_close: string }>;
  position?: Partial<{
    symbol: string;
    asset_class: string;
    side: "long" | "short";
    qty: number;
    current_price: number;
    avg_entry_price: number;
  }>;
  snapshot?: Partial<{ latest_trade: { price: number }; latest_quote: { bid_price: number; ask_price: number } }>;
  openOrders?: Array<{
    id: string;
    symbol: string;
    side: "buy" | "sell";
    qty: string;
    client_order_id: string;
    order_type?: string;
    type?: string;
    stop_price?: string | null;
    limit_price?: string | null;
    status?: string;
  }>;
}) {
  const trading = {
    getAccount: vi.fn(async () => ({
      cash: 10_000,
      buying_power: 10_000,
      daytrading_buying_power: 10_000,
      equity: 10_000,
    })),
    getPositions: vi.fn(async () => []),
    getClock: vi.fn(async () => ({
      timestamp: "2026-04-23T20:15:00Z",
      is_open: false,
      next_open: "2026-04-24T13:30:00Z",
      next_close: "2026-04-23T20:00:00Z",
      ...overrides?.clock,
    })),
    getPosition: vi.fn(async () => ({
      symbol: "SKLZ",
      asset_class: "us_equity",
      side: "long",
      qty: 10,
      current_price: 7,
      avg_entry_price: 10,
      ...overrides?.position,
    })),
    createOrder: vi.fn(async (params) => ({
      status: "accepted",
      order_type: params.type,
      type: params.type,
      ...params,
    })),
    closePosition: vi.fn(async () => ({ status: "accepted" })),
    listOrders: vi.fn(async () => overrides?.openOrders ?? []),
    cancelOrder: vi.fn(async () => {}),
    getAsset: vi.fn(async () => ({ exchange: "NASDAQ" })),
  };

  const marketData = {
    getSnapshot: vi.fn(async () => ({
      latest_trade: { price: 7, ...overrides?.snapshot?.latest_trade },
      latest_quote: { bid_price: 6.8, ask_price: 7.2, ...overrides?.snapshot?.latest_quote },
    })),
    getBars: vi.fn(async () => []),
    getCryptoSnapshot: vi.fn(async () => null),
  };

  return {
    trading,
    marketData,
    options: {},
    deps: {
      alpaca: { trading, marketData, options: {} } as never,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: null,
      log: vi.fn(),
      cryptoSymbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
      allowedExchanges: ["NASDAQ"],
      equityEntryCutoffMinutesBeforeClose: 15,
      afterHoursExitLimitBufferPct: 0.25,
      defaultStopLossPct: 5,
      onBuy: vi.fn(),
      onSell: vi.fn(),
    },
  };
}

describe("policy broker helpers", () => {
  it("detects Alpaca trading halt market order rejections", () => {
    const error =
      'MahoragaError: Alpaca validation error: market order rejected due to trading halt on symbol: "TMCR", please place a limit order instead';

    expect(isTradingHaltMarketOrderError(error)).toBe(true);
    expect(isTradingHaltMarketOrderError("some other broker error")).toBe(false);
  });

  it("computes a buffered limit price from the reference price", () => {
    expect(computeHaltLimitPrice(10)).toBe(10.2);
    expect(computeHaltLimitPrice(0)).toBeNull();
    expect(computeHaltLimitPrice(Number.NaN)).toBeNull();
  });

  it("caps equity buys by the tighter of buying power and day trading buying power", () => {
    expect(computeCappedBuyNotional(5000, { buying_power: 4000, daytrading_buying_power: 2500 }, false)).toEqual({
      adjustedNotional: 2500,
      cap: 2500,
    });
  });

  it("ignores day trading buying power for crypto buys", () => {
    expect(computeCappedBuyNotional(5000, { buying_power: 4000, daytrading_buying_power: 2500 }, true)).toEqual({
      adjustedNotional: 4000,
      cap: 4000,
    });
  });

  it("detects extended-hours windows in New York time", () => {
    expect(isWithinExtendedHoursSession("2026-04-23T12:30:00Z")).toBe(true);
    expect(isWithinExtendedHoursSession("2026-04-23T20:15:00Z")).toBe(true);
    expect(isWithinExtendedHoursSession("2026-04-23T17:00:00Z")).toBe(false);
  });

  it("blocks equity entries near the close", () => {
    expect(
      shouldBlockEquityEntryNearClose(
        {
          timestamp: "2026-04-23T19:55:00Z",
          is_open: true,
          next_open: "2026-04-24T13:30:00Z",
          next_close: "2026-04-23T20:00:00Z",
        },
        15
      )
    ).toBe(true);

    expect(
      shouldBlockEquityEntryNearClose(
        {
          timestamp: "2026-04-23T18:30:00Z",
          is_open: true,
          next_open: "2026-04-24T13:30:00Z",
          next_close: "2026-04-23T20:00:00Z",
        },
        15
      )
    ).toBe(false);
  });
});

describe("createPolicyBroker", () => {
  it("does not submit another buy when a buy order is already open", async () => {
    const { deps, trading } = createDeps({
      openOrders: [
        {
          id: "order-1",
          symbol: "BTC/USD",
          side: "buy",
          qty: "0",
          client_order_id: "alpaca-order",
          order_type: "market",
          status: "accepted",
        },
      ],
    });
    const broker = createPolicyBroker(deps);

    const result = await broker.buy("BTC/USD", 1000, "Crypto momentum");

    expect(result).toBe(false);
    expect(trading.createOrder).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_order_open",
      expect.objectContaining({
        symbol: "BTC/USD",
        status: "accepted",
        order_type: "market",
      })
    );
    expect(deps.onBuy).not.toHaveBeenCalled();
  });

  it("logs accepted buy orders as submitted unless filled", async () => {
    const { deps, trading } = createDeps();
    const broker = createPolicyBroker(deps);

    const result = await broker.buy("BTC/USD", 1000, "Crypto momentum");

    expect(result).toBe(true);
    expect(trading.createOrder).toHaveBeenCalledWith({
      symbol: "BTC/USD",
      notional: 1000,
      side: "buy",
      type: "market",
      time_in_force: "gtc",
    });
    expect(deps.log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_submitted",
      expect.objectContaining({
        symbol: "BTC/USD",
        status: "accepted",
      })
    );
    expect(deps.onBuy).toHaveBeenCalledWith({
      symbol: "BTC/USD",
      notional: 1000,
      reason: "Crypto momentum",
      isCrypto: true,
      status: "accepted",
      orderType: "market",
    });
  });

  it("submits an extended-hours limit exit for equities after the close", async () => {
    const { deps, trading, marketData } = createDeps();
    const broker = createPolicyBroker(deps);

    const result = await broker.sell("SKLZ", "After-hours stop loss");

    expect(result).toBe(true);
    expect(marketData.getSnapshot).toHaveBeenCalledWith("SKLZ");
    expect(trading.createOrder).toHaveBeenCalledWith({
      symbol: "SKLZ",
      qty: 10,
      side: "sell",
      type: "limit",
      time_in_force: "day",
      limit_price: 6.78,
      extended_hours: true,
      client_order_id: "mahoraga-ahx-SKLZ",
    });
    expect(trading.closePosition).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_submitted",
      expect.objectContaining({
        symbol: "SKLZ",
        status: "accepted",
        order_type: "limit",
        extended_hours: true,
      })
    );
    expect(deps.onSell).toHaveBeenCalledWith({
      symbol: "SKLZ",
      reason: "After-hours stop loss",
      status: "accepted",
      orderType: "limit",
      extendedHours: true,
      limitPrice: 6.78,
    });
  });

  it("logs an existing after-hours exit order as open, not executed", async () => {
    const { deps, trading } = createDeps({
      openOrders: [
        {
          id: "order-1",
          symbol: "SKLZ",
          side: "sell",
          qty: "10",
          client_order_id: "mahoraga-ahx-SKLZ",
          order_type: "limit",
          limit_price: "6.78",
          status: "new",
        },
      ],
    });
    const broker = createPolicyBroker(deps);

    const result = await broker.sell("SKLZ", "After-hours stop loss");

    expect(result).toBe(true);
    expect(trading.createOrder).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_order_open",
      expect.objectContaining({
        symbol: "SKLZ",
        status: "new",
        order_type: "limit",
        extended_hours: true,
      })
    );
    expect(deps.onSell).not.toHaveBeenCalled();
  });

  it("logs regular closePosition responses as submitted unless filled", async () => {
    const { deps, trading } = createDeps({
      clock: {
        is_open: true,
      },
    });
    const broker = createPolicyBroker(deps);

    const result = await broker.sell("SKLZ", "Regular-hours exit");

    expect(result).toBe(true);
    expect(trading.closePosition).toHaveBeenCalledWith("SKLZ");
    expect(deps.log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_submitted",
      expect.objectContaining({
        symbol: "SKLZ",
        status: "accepted",
      })
    );
    expect(deps.onSell).toHaveBeenCalledWith({
      symbol: "SKLZ",
      reason: "Regular-hours exit",
      status: "accepted",
      orderType: "market",
    });
  });

  it("creates protective stop orders for open long equity positions", async () => {
    const { deps, trading } = createDeps({
      position: {
        symbol: "SKLZ",
        asset_class: "us_equity",
        side: "long",
        qty: 10,
        current_price: 9.8,
        avg_entry_price: 10,
      },
    });
    const broker = createPolicyBroker(deps);

    await broker.syncProtectiveStops([
      {
        symbol: "SKLZ",
        asset_class: "us_equity",
        side: "long",
        qty: 10,
        current_price: 9.8,
        avg_entry_price: 10,
      } as never,
    ]);

    expect(trading.createOrder).toHaveBeenCalledWith({
      symbol: "SKLZ",
      qty: 10,
      side: "sell",
      type: "stop",
      time_in_force: "gtc",
      stop_price: 9.5,
      client_order_id: "mahoraga-stop-SKLZ",
    });
  });
});
