import { describe, expect, it, vi } from "vitest";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import type { Account, MarketClock, Order, Position, Quote } from "../providers/types";
import { createPolicyBroker } from "./policy-broker";

const account = {
  cash: 10_000,
  buying_power: 10_000,
  equity: 10_000,
} as Account;

const afterHoursClock = {
  is_open: false,
  timestamp: "2026-01-01T21:00:00Z",
  next_open: "2026-01-02T14:30:00Z",
  next_close: "2026-01-02T21:00:00Z",
} as MarketClock;

const openClock = {
  is_open: true,
  timestamp: "2026-01-02T15:00:00Z",
  next_open: "2026-01-02T14:30:00Z",
  next_close: "2026-01-02T21:00:00Z",
} as MarketClock;

const position = {
  symbol: "AAPL",
  qty: 10,
  current_price: 100,
  lastday_price: 99,
  market_value: 1000,
  unrealized_pl: 0,
} as Position;

const quote = {
  symbol: "AAPL",
  bid_price: 98,
  ask_price: 98.1,
} as Quote;

const order = {
  id: "order-1",
  status: "accepted",
} as Order;

function makeAlpaca(overrides: Partial<AlpacaProviders["trading"]> = {}): AlpacaProviders {
  return {
    trading: {
      getAccount: vi.fn().mockResolvedValue(account),
      getPositions: vi.fn().mockResolvedValue([position]),
      getClock: vi.fn().mockResolvedValue(afterHoursClock),
      closePosition: vi.fn().mockResolvedValue(order),
      createOrder: vi.fn().mockResolvedValue(order),
      listOrders: vi.fn().mockResolvedValue([]),
      getAsset: vi.fn(),
      ...overrides,
    },
    marketData: {
      getQuote: vi.fn().mockResolvedValue(quote),
    },
    options: {},
  } as unknown as AlpacaProviders;
}

describe("createPolicyBroker", () => {
  it("records autonomous buys for trade review exports", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
        filled_qty: 5,
        filled_avg_price: 100,
      }),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const r2 = {
      putJson: vi.fn().mockResolvedValue({}),
    };
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      r2: r2 as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry", {
      confidence: 0.91,
      entry_quality: "excellent",
      source_count: 2,
    });

    expect(result).toBe(true);
    expect(db.run).toHaveBeenCalledTimes(2);
    expect(db.run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "AAPL", "buy", 500, "market", "filled", 5, 100])
    );
    expect(db.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO trade_journal"),
      expect.arrayContaining(["AAPL", "buy", 100, 5])
    );
    const journalArgs = db.run.mock.calls[1]?.[1] as unknown[];
    expect(JSON.parse(String(journalArgs[7]))).toEqual(
      expect.objectContaining({
        reason: "High-quality entry",
        confidence: 0.91,
        entry_quality: "excellent",
        source_count: 2,
      })
    );
    expect(r2.putJson).toHaveBeenCalledWith(
      expect.stringMatching(/^trades\/.+\/snapshot\.json$/),
      expect.objectContaining({
        exported_from: "policy_broker",
        symbol: "AAPL",
        side: "buy",
        reason: "High-quality entry",
        metadata: expect.objectContaining({
          confidence: 0.91,
          entry_quality: "excellent",
          source_count: 2,
        }),
      })
    );
  });

  it("defers trade journal entries for accepted but unfilled buys", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "accepted",
        filled_qty: "0",
        filled_avg_price: null,
      }),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "AAPL", "buy", 500, "market", "accepted", null, null])
    );
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_outcome_deferred",
      expect.objectContaining({ symbol: "AAPL", status: "accepted" })
    );
  });

  it("passes actual filled notional to the buy hook for partially filled buys", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "partially_filled",
        filled_qty: "2",
        filled_avg_price: "101",
      }),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const onBuy = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
      onBuy,
    });

    const result = await broker.buy("AAPL", 500, "Partial high-quality entry");

    expect(result).toBe(true);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trade_journal"),
      expect.arrayContaining(["AAPL", "buy", 101, 2])
    );
    expect(onBuy).toHaveBeenCalledWith("AAPL", 202, "Partial high-quality entry");
  });

  it("blocks buys after the daily entry order limit is reached", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue([
        { id: "trade-1", side: "buy" },
        { id: "trade-2", side: "buy" },
      ]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const policyConfig = getDefaultPolicyConfig({} as never);
    policyConfig.max_daily_entry_orders = 2;
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "Daily limit test");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_daily_entry_limit",
      expect.objectContaining({
        symbol: "AAPL",
        daily_entry_orders: 2,
        max_daily_entry_orders: 2,
      })
    );
  });

  it("blocks buys when the previous entry order is too recent", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue(null),
      execute: vi
        .fn()
        .mockResolvedValue([
          { id: "trade-1", side: "buy", created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() },
        ]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const policyConfig = getDefaultPolicyConfig({} as never);
    policyConfig.max_daily_entry_orders = 8;
    policyConfig.min_minutes_between_entries = 10;
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "Entry spacing test");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_entry_spacing",
      expect.objectContaining({
        symbol: "AAPL",
        min_minutes_between_entries: 10,
      })
    );
  });

  it("blocks equity buys when the live quote spread is too wide", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    alpaca.marketData.getQuote = vi.fn().mockResolvedValue({
      symbol: "AAPL",
      bid_price: 98,
      ask_price: 100,
    } as Quote);
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_wide_spread",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "wide_spread",
        spread_pct: 2,
        max_spread_pct: 0.8,
      })
    );
  });

  it("blocks equity buys when the live quote size is too thin", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    alpaca.marketData.getQuote = vi.fn().mockResolvedValue({
      symbol: "AAPL",
      bid_price: 99.9,
      ask_price: 100,
      bid_size: 0,
      ask_size: 2,
    } as Quote);
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
      minEntryQuoteSize: 1,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_thin_quote",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "thin_quote",
        bid_size: 0,
        ask_size: 2,
        min_quote_size: 1,
      })
    );
  });

  it("blocks low-conviction equity buys after the daily loss soft guard is reached", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue({
        kill_switch_active: 0,
        kill_switch_reason: null,
        kill_switch_at: null,
        daily_loss_usd: 100,
        daily_loss_reset_at: new Date().toISOString(),
        last_loss_at: new Date().toISOString(),
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      }),
      execute: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      dailyLossGuardEnabled: true,
      dailyLossSoftLimitPct: 0.0075,
      dailyLossMinConfidence: 0.8,
      dailyLossMinEntryQuality: "good",
    });

    const result = await broker.buy("AAPL", 500, "Weak entry after losses", {
      confidence: 0.7,
      entry_quality: "fair",
    });

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_daily_loss_soft_guard",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "daily_loss_soft_guard",
        daily_loss_pct: 0.01,
        confidence: 0.7,
        min_confidence: 0.8,
        entry_quality: "fair",
        min_entry_quality: "good",
      })
    );
  });

  it("allows high-conviction equity buys after the daily loss soft guard is reached", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValue({
        kill_switch_active: 0,
        kill_switch_reason: null,
        kill_switch_at: null,
        daily_loss_usd: 100,
        daily_loss_reset_at: new Date().toISOString(),
        last_loss_at: new Date().toISOString(),
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      }),
      execute: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      dailyLossGuardEnabled: true,
      dailyLossSoftLimitPct: 0.0075,
      dailyLossMinConfidence: 0.8,
      dailyLossMinEntryQuality: "good",
    });

    const result = await broker.buy("AAPL", 500, "Strong entry after losses", {
      confidence: 0.85,
      entry_quality: "good",
    });

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).toHaveBeenCalled();
  });

  it("blocks equity buys when the live quote is unavailable for spread validation", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    alpaca.marketData.getQuote = vi.fn().mockRejectedValue(new Error("quote unavailable"));
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_spread_check_unavailable",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "Error: quote unavailable",
      })
    );
  });

  it("blocks equity buys when the live quote has invalid bid or ask", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    alpaca.marketData.getQuote = vi.fn().mockResolvedValue({
      symbol: "AAPL",
      bid_price: 0,
      ask_price: 100,
    } as Quote);
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_spread_check_unavailable",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "Invalid bid/ask",
        bid: 0,
        ask: 100,
      })
    );
  });

  it("blocks equity buys that are overextended from the previous close", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
      maxEntryPriceChangePct: 5,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry", { entry_price_change_pct: 6.25 });

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_overextended_entry",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "entry_price_change_too_high",
        entry_price_change_pct: 6.25,
        max_entry_price_change_pct: 5,
      })
    );
  });

  it("blocks buys for symbols on the configured deny list", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const log = vi.fn();
    const policyConfig = getDefaultPolicyConfig({} as never);
    policyConfig.deny_symbols = ["AAPL"];
    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db: null,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
    });

    const result = await broker.buy("AAPL", 500, "Blacklisted entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_rejected",
      expect.objectContaining({
        symbol: "AAPL",
        violations: expect.arrayContaining([expect.stringContaining("deny list")]),
      })
    );
  });

  it("calculates overextended entry risk from the latest snapshot when metadata is missing", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
    });
    alpaca.marketData.getSnapshot = vi.fn().mockResolvedValue({
      latest_trade: { price: 106.25 },
      latest_quote: { bid_price: 106, ask_price: 106.5 },
      prev_daily_bar: { c: 100 },
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
      maxEntryPriceChangePct: 5,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.marketData.getSnapshot).toHaveBeenCalledWith("AAPL");
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_overextended_entry",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "entry_price_change_too_high",
        entry_price_change_pct: 6.25,
        max_entry_price_change_pct: 5,
      })
    );
  });

  it("does not apply the overextended entry guard to crypto buys", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
        filled_qty: "0.01",
        filled_avg_price: "100000",
      }),
    });
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: null,
      log: vi.fn(),
      cryptoSymbols: ["BTC/USD"],
      allowedExchanges: [],
      maxEntryPriceChangePct: 5,
    });

    const result = await broker.buy("BTC/USD", 500, "Crypto momentum entry", { entry_price_change_pct: 12 });

    expect(result).toBe(true);
    expect(alpaca.trading.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC/USD", side: "buy" })
    );
  });

  it("blocks duplicate buys while an open buy order is already pending", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      listOrders: vi.fn().mockResolvedValue([
        {
          id: "pending-buy-1",
          symbol: "AAPL",
          side: "buy",
          status: "accepted",
        },
      ]),
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.listOrders).toHaveBeenCalledWith({ status: "open" });
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_pending_order",
      expect.objectContaining({
        symbol: "AAPL",
        order_id: "pending-buy-1",
        status: "accepted",
      })
    );
  });

  it("blocks buys when pending order status cannot be checked", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([]),
      listOrders: vi.fn().mockRejectedValue(new Error("orders unavailable")),
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_pending_order_check_unavailable",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "pending_order_check_unavailable",
        error: "Error: orders unavailable",
      })
    );
  });

  it("blocks averaging down into an existing losing position", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([{ ...position, unrealized_pl: -50 }]),
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "Attempted add to loser");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_rejected",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "averaging_down_blocked",
        violation_rules: expect.arrayContaining(["averaging_down_blocked"]),
      })
    );
  });

  it("blocks weak new buys when the open portfolio is in drawdown", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([{ ...position, symbol: "MSFT", unrealized_pl: -150 }]),
    });
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
      openPositionLossGuardEnabled: true,
      openPositionLossSoftLimitPct: 0.01,
      openPositionLossMinConfidence: 0.85,
      openPositionLossMinEntryQuality: "excellent",
    });

    const result = await broker.buy("AAPL", 500, "Weak add during open drawdown", {
      confidence: 0.7,
      entry_quality: "good",
    });

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_open_position_loss_guard",
      expect.objectContaining({
        symbol: "AAPL",
        reason: "open_position_loss_guard",
        open_loss_pct: 0.015,
        confidence: 0.7,
        min_confidence: 0.85,
        entry_quality: "good",
      })
    );
  });

  it("allows exceptional new buys during open drawdown", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([{ ...position, symbol: "MSFT", unrealized_pl: -150 }]),
      createOrder: vi.fn().mockResolvedValue({ ...order, status: "filled", filled_qty: 5, filled_avg_price: 100 }),
    });
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: null,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
      openPositionLossGuardEnabled: true,
      openPositionLossSoftLimitPct: 0.01,
      openPositionLossMinConfidence: 0.85,
      openPositionLossMinEntryQuality: "excellent",
    });

    const result = await broker.buy("AAPL", 500, "Exceptional entry during open drawdown", {
      confidence: 0.9,
      entry_quality: "excellent",
    });

    expect(result).toBe(true);
    expect(alpaca.trading.createOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAPL", side: "buy" }));
  });

  it("counts pending new buys toward the max open positions limit", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([
        { ...position, symbol: "MSFT" },
        { ...position, symbol: "GOOG" },
        { ...position, symbol: "AMZN" },
        { ...position, symbol: "META" },
      ]),
      listOrders: vi.fn().mockResolvedValue([
        {
          id: "pending-buy-1",
          symbol: "NVDA",
          side: "buy",
          status: "accepted",
        },
      ]),
    });
    const log = vi.fn();
    const policyConfig = getDefaultPolicyConfig({} as never);
    policyConfig.max_open_positions = 5;
    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db: {
        executeOne: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      maxEntrySpreadPct: 0.8,
    });

    const result = await broker.buy("AAPL", 500, "High-quality entry");

    expect(result).toBe(false);
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "buy_blocked_pending_capacity",
      expect.objectContaining({
        symbol: "AAPL",
        open_positions: 4,
        pending_new_buys: 1,
        max_open_positions: 5,
      })
    );
  });

  it("submits buffered limit sells during after-hours equity exits without clearing state before fill", async () => {
    const alpaca = makeAlpaca();
    const onSell = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: null,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
      onSell,
    });

    const result = await broker.sell("AAPL", "Risk exit");

    expect(result).toBe(false);
    expect(alpaca.trading.closePosition).not.toHaveBeenCalled();
    expect(alpaca.trading.createOrder).toHaveBeenCalledWith({
      symbol: "AAPL",
      qty: 10,
      side: "sell",
      type: "limit",
      limit_price: 97.76,
      time_in_force: "day",
      extended_hours: true,
    });
    expect(onSell).not.toHaveBeenCalled();
  });

  it("blocks duplicate sells while an open sell order is already pending", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      listOrders: vi.fn().mockResolvedValue([
        {
          id: "pending-sell-1",
          symbol: "AAPL",
          side: "sell",
          status: "accepted",
        },
      ]),
    });
    const onSell = vi.fn();
    const log = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: null,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
      onSell,
    });

    const result = await broker.sell("AAPL", "Risk exit");

    expect(result).toBe(false);
    expect(alpaca.trading.listOrders).toHaveBeenCalledWith({ status: "open", symbols: ["AAPL"] });
    expect(alpaca.trading.createOrder).not.toHaveBeenCalled();
    expect(alpaca.trading.closePosition).not.toHaveBeenCalled();
    expect(onSell).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_blocked_pending_order",
      expect.objectContaining({
        symbol: "AAPL",
        order_id: "pending-sell-1",
        status: "accepted",
      })
    );
  });

  it("closes the latest open journal when an autonomous sell is recorded", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
      }),
    });
    const db = {
      executeOne: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "journal-1", entry_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const onSell = vi
      .fn()
      .mockReturnValue({ entry_price: 100, peak_price: 104.2, trough_price: 98.5, mfe_pct: 4.2, mae_pct: -1.5 });
    const r2 = { putJson: vi.fn().mockResolvedValue(undefined) };
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      r2: r2 as never,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
      onSell,
    });

    const result = await broker.sell("AAPL", "Trailing stop");

    expect(result).toBe(true);
    expect(db.run).toHaveBeenCalledTimes(2);
    expect(db.run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "AAPL", "sell", 10, "market", "filled"])
    );
    expect(db.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE trade_journal"),
      expect.arrayContaining([
        100,
        expect.any(String),
        0,
        0,
        expect.any(Number),
        "scratch",
        "Trailing stop",
        expect.any(String),
        "journal-1",
      ])
    );
    expect(onSell).toHaveBeenCalledWith("AAPL", "Trailing stop");
    expect(r2.putJson).toHaveBeenCalledWith(
      expect.stringMatching(/^trades\/.+\/snapshot\.json$/),
      expect.objectContaining({
        side: "sell",
        lifecycle_metadata: expect.objectContaining({
          exit_price: 100,
          exit_gain_pct: 0,
          mfe_pct: 4.2,
          mae_pct: -1.5,
          giveback_pct: 4.2,
          exit_efficiency_pct: 0,
        }),
      })
    );
  });

  it("uses filled sell price when recording autonomous sell outcomes", async () => {
    const stalePricePosition = {
      ...position,
      avg_entry_price: 100,
      cost_basis: 1000,
      current_price: 90,
      market_value: 900,
      unrealized_pl: -100,
    } as Position;
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([stalePricePosition]),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
        filled_qty: "10",
        filled_avg_price: "103",
      }),
    });
    const db = {
      executeOne: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "journal-1", entry_at: new Date(Date.now() - 45 * 60 * 1000).toISOString() }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0,
    });

    const result = await broker.sell("AAPL", "Take profit");

    expect(result).toBe(true);
    expect(db.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE trade_journal"),
      expect.arrayContaining([103, expect.any(String), 30, 3, expect.any(Number), "win", "Take profit"])
    );
  });

  it("records realized losses into risk state and starts the loss cooldown", async () => {
    const losingPosition = {
      ...position,
      current_price: 90,
      market_value: 900,
      unrealized_pl: -100,
    } as Position;
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([losingPosition]),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
      }),
    });
    const db = {
      executeOne: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "journal-1", entry_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const policyConfig = getDefaultPolicyConfig({} as never);
    policyConfig.cooldown_minutes_after_loss = 45;
    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db: db as never,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0.25,
    });

    const before = Date.now();
    const result = await broker.sell("AAPL", "Stop loss");
    const after = Date.now();

    expect(result).toBe(true);
    expect(db.run).toHaveBeenCalledTimes(4);
    expect(db.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE trade_journal"),
      expect.arrayContaining([90, expect.any(String), -100, expect.any(Number), expect.any(Number), "loss"])
    );
    expect(db.run).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("daily_loss_usd = daily_loss_usd + ?"),
      expect.arrayContaining([100])
    );
    const cooldownArgs = db.run.mock.calls[3]?.[1] as unknown[];
    const cooldownUntil = new Date(String(cooldownArgs[0])).getTime();
    expect(cooldownUntil).toBeGreaterThanOrEqual(before + 45 * 60 * 1000 - 1000);
    expect(cooldownUntil).toBeLessThanOrEqual(after + 45 * 60 * 1000 + 1000);
  });

  it("does not close trade journal outcomes for accepted but unfilled sells", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "accepted",
      }),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValueOnce(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const log = vi.fn();
    const onSell = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0,
      onSell,
    });

    const result = await broker.sell("AAPL", "Exit submitted");

    expect(result).toBe(false);
    expect(db.executeOne).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "AAPL", "sell", 10, "market", "accepted"])
    );
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_outcome_deferred",
      expect.objectContaining({ symbol: "AAPL", status: "accepted" })
    );
    expect(onSell).not.toHaveBeenCalled();
  });

  it("does not close trade journal outcomes for partially filled sells", async () => {
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "partially_filled",
        filled_qty: "2",
        filled_avg_price: "101",
      }),
    });
    const db = {
      executeOne: vi.fn().mockResolvedValueOnce(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const log = vi.fn();
    const onSell = vi.fn();
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log,
      cryptoSymbols: [],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0,
      onSell,
    });

    const result = await broker.sell("AAPL", "Partial exit submitted");

    expect(result).toBe(false);
    expect(db.executeOne).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "AAPL", "sell", 10, "market", "partially_filled", 2, 101])
    );
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_submitted",
      expect.objectContaining({ symbol: "AAPL", status: "partially_filled" })
    );
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_outcome_deferred",
      expect.objectContaining({ symbol: "AAPL", status: "partially_filled" })
    );
    expect(onSell).not.toHaveBeenCalled();
  });

  it("closes the matched broker position symbol when sell requests use a normalized alias", async () => {
    const cryptoPosition = {
      ...position,
      symbol: "SOL/USD",
      qty: 2,
      current_price: 150,
      market_value: 300,
    } as Position;
    const alpaca = makeAlpaca({
      getClock: vi.fn().mockResolvedValue(openClock),
      getPositions: vi.fn().mockResolvedValue([cryptoPosition]),
      closePosition: vi.fn().mockResolvedValue({
        ...order,
        status: "filled",
        filled_qty: "2",
        filled_avg_price: "150",
      }),
    });
    const db = {
      executeOne: vi.fn().mockImplementation((query: string) => {
        if (query.includes("SELECT id, entry_at FROM trade_journal")) {
          return Promise.resolve({ id: "journal-1", entry_at: new Date().toISOString() });
        }
        if (query.includes("SELECT signals_json FROM trade_journal")) {
          return Promise.resolve({ signals_json: JSON.stringify({ entry_path: "strategy_select_entries" }) });
        }
        return Promise.resolve(null);
      }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const log = vi.fn();
    const onSell = vi
      .fn()
      .mockResolvedValue({ entry_price: 150, mfe_pct: 4.2, mae_pct: -1.1, peak_price: 156, trough_price: 148 });
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as never),
      db: db as never,
      log,
      cryptoSymbols: ["SOL/USD"],
      allowedExchanges: [],
      afterHoursExitLimitBufferPct: 0,
      onSell,
    });

    const result = await broker.sell("SOLUSD", "Alias exit");

    expect(result).toBe(true);
    expect(alpaca.trading.closePosition).toHaveBeenCalledWith("SOL/USD");
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO trades"),
      expect.arrayContaining(["order-1", "SOL/USD", "sell", 2, "market", "filled", 2, 150])
    );
    const outcomeCall = db.run.mock.calls.find((call) => String(call[0]).includes("UPDATE trade_journal"));
    const outcomeArgs = outcomeCall?.[1] as unknown[];
    const signalUpdate = JSON.parse(String(outcomeArgs[7]));
    expect(signalUpdate).toEqual(
      expect.objectContaining({
        entry_path: "strategy_select_entries",
        exit_reason: "Alias exit",
        exit_price: 150,
        exit_gain_pct: 0,
        mfe_pct: 4.2,
        mae_pct: -1.1,
        giveback_pct: 4.2,
        exit_efficiency_pct: 0,
        lifecycle: expect.objectContaining({ peak_price: 156, trough_price: 148 }),
      })
    );
    expect(onSell).toHaveBeenCalledWith("SOL/USD", "Alias exit");
    expect(log).toHaveBeenCalledWith(
      "PolicyBroker",
      "sell_executed",
      expect.objectContaining({ symbol: "SOL/USD", requested_symbol: "SOLUSD" })
    );
  });
});
