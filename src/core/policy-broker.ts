/**
 * PolicyEngine-wrapped broker — every autonomous trade goes through policy checks.
 *
 * This is the H2 security fix: the harness used to call alpaca.trading.createOrder()
 * directly, bypassing kill switch, daily loss limits, position concentration, etc.
 * Now all trades (buy AND sell) go through PolicyEngine.evaluate() first.
 *
 * Strategies call ctx.broker.buy()/sell() and get back true/false.
 * They cannot bypass these safety checks.
 */

import type { OptionsOrderPreview, OrderPreview } from "../mcp/types";
import type { PolicyConfig } from "../policy/config";
import { getDTE } from "../providers/alpaca/options";
import { type OptionsPolicyContext, type PolicyContext, PolicyEngine } from "../policy/engine";
import type { AlpacaProviders } from "../providers/alpaca";
import type { Account, MarketClock, Order, Position, Snapshot } from "../providers/types";
import type { D1Client } from "../storage/d1/client";
import type { RiskState } from "../storage/d1/queries/risk-state";
import { getRiskState } from "../storage/d1/queries/risk-state";
import { isCryptoSymbol, normalizeCryptoSymbol } from "./asset-symbols";
import type { StrategyContext } from "../strategy/types";

export interface PolicyBrokerDeps {
  alpaca: AlpacaProviders;
  policyConfig: PolicyConfig;
  db: D1Client | null;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  cryptoSymbols: string[];
  allowedExchanges: string[];
  equityEntryCutoffMinutesBeforeClose: number;
  afterHoursExitLimitBufferPct: number;
  defaultStopLossPct: number;
  /** Called after a successful buy order */
  onBuy?: (trade: {
    symbol: string;
    notional: number;
    reason: string;
    isCrypto: boolean;
    status: string;
    orderType: string;
  }) => void | Promise<void>;
  /** Called after a successful sell/close order */
  onSell?: (trade: { symbol: string; reason: string }) => void | Promise<void>;
}

const REGULAR_MARKET_OPEN_ET_MINUTES = 9 * 60 + 30;
const REGULAR_MARKET_CLOSE_ET_MINUTES = 16 * 60;
const EXTENDED_HOURS_OPEN_ET_MINUTES = 4 * 60;
const EXTENDED_HOURS_CLOSE_ET_MINUTES = 20 * 60;
const MANAGED_STOP_ORDER_PREFIX = "mahoraga-stop";
const AFTER_HOURS_EXIT_ORDER_PREFIX = "mahoraga-ahx";
const ORDER_PRICE_EPSILON = 0.02;
const ORDER_QTY_EPSILON = 0.0001;

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function approximatelyEqual(left: number, right: number, epsilon: number): boolean {
  return Math.abs(left - right) <= epsilon;
}

function buildManagedOrderId(prefix: string, symbol: string): string {
  const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  return `${prefix}-${normalizedSymbol}`.slice(0, 48);
}

function extractEtClockInfo(timestamp: string): { weekday: string; minutesSinceMidnight: number } | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);

  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  return {
    weekday,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

function isWeekdayEt(weekday: string): boolean {
  return weekday !== "Sat" && weekday !== "Sun";
}

export function isWithinExtendedHoursSession(timestamp: string): boolean {
  const info = extractEtClockInfo(timestamp);
  if (!info || !isWeekdayEt(info.weekday)) {
    return false;
  }

  const minutes = info.minutesSinceMidnight;
  const inPremarket = minutes >= EXTENDED_HOURS_OPEN_ET_MINUTES && minutes < REGULAR_MARKET_OPEN_ET_MINUTES;
  const inAfterHours = minutes >= REGULAR_MARKET_CLOSE_ET_MINUTES && minutes < EXTENDED_HOURS_CLOSE_ET_MINUTES;
  return inPremarket || inAfterHours;
}

export function shouldBlockEquityEntryNearClose(clock: MarketClock, cutoffMinutes: number): boolean {
  if (!clock.is_open || cutoffMinutes <= 0) {
    return false;
  }

  const nowMs = new Date(clock.timestamp).getTime();
  const nextCloseMs = new Date(clock.next_close).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextCloseMs)) {
    return false;
  }

  const minutesUntilClose = (nextCloseMs - nowMs) / 60000;
  return minutesUntilClose >= 0 && minutesUntilClose <= cutoffMinutes;
}

function computeProtectiveStopPrice(referencePrice: number, stopLossPct: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(stopLossPct) || stopLossPct <= 0) {
    return null;
  }

  return Math.max(0.01, roundToCents(referencePrice * (1 - stopLossPct / 100)));
}

function computeAfterHoursExitLimitPrice(
  position: Pick<Position, "current_price" | "avg_entry_price">,
  snapshot: Snapshot | null,
  bufferPct: number
): number | null {
  const bidPrice = snapshot?.latest_quote?.bid_price ?? 0;
  const latestTradePrice = snapshot?.latest_trade?.price ?? 0;
  const fallbackPrice = position.current_price || position.avg_entry_price || 0;
  const referencePrice = bidPrice > 0 ? bidPrice : latestTradePrice > 0 ? latestTradePrice : fallbackPrice;

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  const aggressivePrice = referencePrice * (1 - Math.max(0, bufferPct) / 100);
  return Math.max(0.01, roundToCents(aggressivePrice));
}

function parseOrderPrice(order: Pick<Order, "limit_price" | "stop_price">): number {
  const raw = order.limit_price ?? order.stop_price ?? "";
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOrderQty(order: Pick<Order, "qty">): number {
  const parsed = Number.parseFloat(order.qty);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isTradingHaltMarketOrderError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("trading halt") && message.includes("limit order instead");
}

export function computeHaltLimitPrice(referencePrice: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  // Small premium to improve the chance of queuing/filling when the halt lifts.
  return Math.round(referencePrice * 1.02 * 100) / 100;
}

export function computeCappedBuyNotional(
  requestedNotional: number,
  account: Pick<Account, "buying_power" | "daytrading_buying_power">,
  isCrypto: boolean
): { adjustedNotional: number; cap: number } {
  const buyingPowerCap = Number.isFinite(account.buying_power) ? Math.max(0, account.buying_power) : 0;
  const dayTradingCap =
    !isCrypto && Number.isFinite(account.daytrading_buying_power) && account.daytrading_buying_power > 0
      ? account.daytrading_buying_power
      : Number.POSITIVE_INFINITY;
  const cap = Math.max(0, Math.min(buyingPowerCap, dayTradingCap));
  const adjustedNotional = Math.min(Math.max(0, requestedNotional), cap);

  return {
    adjustedNotional: Math.round(adjustedNotional * 100) / 100,
    cap,
  };
}

interface ParsedOptionsContract {
  underlying: string;
  expiration: string;
  optionType: "call" | "put";
  strike: number;
}

function computeAverageVolume20d(volumes: number[]): number | undefined {
  const validVolumes = volumes.filter((volume) => Number.isFinite(volume) && volume > 0);
  if (validVolumes.length === 0) return undefined;
  return validVolumes.reduce((sum, volume) => sum + volume, 0) / validVolumes.length;
}

function getOptionsLimitPrice(snapshot: Awaited<ReturnType<AlpacaProviders["options"]["getSnapshot"]>>): number | null {
  const bid = snapshot.latest_quote?.bid_price ?? 0;
  const ask = snapshot.latest_quote?.ask_price ?? 0;

  if (bid > 0 && ask > 0) {
    return Math.round(((bid + ask) / 2) * 100) / 100;
  }

  const fallback = ask > 0 ? ask : bid > 0 ? bid : 0;
  return fallback > 0 ? Math.round(fallback * 100) / 100 : null;
}

function parseOptionsContractSymbol(symbol: string): ParsedOptionsContract | null {
  const match = symbol.toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return null;

  const [, underlying, rawDate, typeCode, rawStrike] = match;
  if (!underlying || !rawDate || !typeCode || !rawStrike) return null;

  const year = 2000 + Number.parseInt(rawDate.slice(0, 2), 10);
  const month = Number.parseInt(rawDate.slice(2, 4), 10);
  const day = Number.parseInt(rawDate.slice(4, 6), 10);
  const strike = Number.parseInt(rawStrike, 10) / 1000;

  return {
    underlying,
    expiration: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    optionType: typeCode === "C" ? "call" : "put",
    strike,
  };
}

/**
 * Create the broker adapter that strategies use via ctx.broker.
 * All orders are validated by PolicyEngine before execution.
 */
export function createPolicyBroker(deps: PolicyBrokerDeps): StrategyContext["broker"] {
  const { alpaca, policyConfig, db, log } = deps;
  const engine = new PolicyEngine(policyConfig);

  // Cache account/positions/clock per cycle to avoid redundant API calls
  let cachedAccount: Account | null = null;
  let cachedPositions: Position[] | null = null;
  let cachedClock: MarketClock | null = null;

  async function getAccount(): Promise<Account> {
    if (!cachedAccount) {
      cachedAccount = await alpaca.trading.getAccount();
    }
    return cachedAccount;
  }

  async function getPositions(): Promise<Position[]> {
    if (!cachedPositions) {
      cachedPositions = await alpaca.trading.getPositions();
    }
    return cachedPositions;
  }

  async function getClock(): Promise<MarketClock> {
    if (!cachedClock) {
      cachedClock = await alpaca.trading.getClock();
    }
    return cachedClock;
  }

  async function getRiskStateOrDefault(): Promise<RiskState> {
    if (!db) {
      return {
        kill_switch_active: false,
        kill_switch_reason: null,
        kill_switch_at: null,
        daily_loss_usd: 0,
        daily_loss_reset_at: null,
        last_loss_at: null,
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      };
    }
    return getRiskState(db);
  }

  async function listOpenOrdersForSymbol(symbol: string): Promise<Order[]> {
    return alpaca.trading.listOrders({ status: "open", limit: 50, symbols: [symbol] }).catch(() => []);
  }

  function isManagedProtectiveStop(order: Order, symbol: string): boolean {
    return (
      order.symbol === symbol &&
      order.side === "sell" &&
      order.client_order_id === buildManagedOrderId(MANAGED_STOP_ORDER_PREFIX, symbol) &&
      (order.order_type === "stop" || order.type === "stop")
    );
  }

  function isManagedAfterHoursExit(order: Order, symbol: string): boolean {
    return (
      order.symbol === symbol &&
      order.side === "sell" &&
      order.client_order_id === buildManagedOrderId(AFTER_HOURS_EXIT_ORDER_PREFIX, symbol)
    );
  }

  async function cancelManagedOrders(symbol: string): Promise<void> {
    const openOrders = await listOpenOrdersForSymbol(symbol);
    const managedOrders = openOrders.filter(
      (order) => isManagedProtectiveStop(order, symbol) || isManagedAfterHoursExit(order, symbol)
    );

    await Promise.all(managedOrders.map((order) => alpaca.trading.cancelOrder(order.id).catch(() => undefined)));
  }

  async function buy(symbol: string, notional: number, reason: string): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      log("PolicyBroker", "buy_blocked", { reason: "Empty symbol" });
      return false;
    }

    if (notional <= 0 || !Number.isFinite(notional)) {
      log("PolicyBroker", "buy_blocked", { symbol, reason: "Invalid notional", notional });
      return false;
    }

    const isCrypto = isCryptoSymbol(symbol, deps.cryptoSymbols);
    const orderSymbol = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
    const assetClass = isCrypto ? "crypto" : "us_equity";
    const timeInForce = isCrypto ? "gtc" : "day";
    let estimatedPrice: number | undefined;
    let avgVolume20d: number | undefined;

    let assetInfo: Awaited<ReturnType<typeof alpaca.trading.getAsset>> | null = null;

    // Exchange validation for equities
    if (!isCrypto && deps.allowedExchanges.length > 0) {
      try {
        assetInfo = await alpaca.trading.getAsset(symbol);
        if (!assetInfo) {
          log("PolicyBroker", "buy_blocked", { symbol, reason: "Asset not found" });
          return false;
        }
        if (!deps.allowedExchanges.includes(assetInfo.exchange)) {
          log("PolicyBroker", "buy_blocked", {
            symbol,
            reason: "Exchange not allowed",
            exchange: assetInfo.exchange,
          });
          return false;
        }
      } catch {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Asset lookup failed" });
        return false;
      }
    }

    if (isCrypto) {
      const snapshot = await alpaca.marketData.getCryptoSnapshot(orderSymbol).catch(() => null);
      estimatedPrice =
        snapshot?.latest_trade?.price ||
        snapshot?.latest_quote?.ask_price ||
        snapshot?.latest_quote?.bid_price ||
        snapshot?.daily_bar?.c ||
        undefined;
    } else {
      const [snapshot, dailyBars] = await Promise.all([
        alpaca.marketData.getSnapshot(symbol).catch(() => null),
        alpaca.marketData.getBars(symbol, "1Day", { limit: 20 }).catch(() => []),
      ]);

      estimatedPrice =
        snapshot?.latest_trade?.price ||
        snapshot?.latest_quote?.ask_price ||
        snapshot?.latest_quote?.bid_price ||
        snapshot?.daily_bar?.c ||
        undefined;

      avgVolume20d = computeAverageVolume20d(
        dailyBars.length > 0
          ? dailyBars.map((bar) => bar.v)
          : snapshot?.daily_bar?.v
            ? [snapshot.daily_bar.v]
            : []
      );

      if (!estimatedPrice || !Number.isFinite(estimatedPrice) || estimatedPrice <= 0) {
        log("PolicyBroker", "buy_blocked", {
          symbol,
          reason: "Unable to determine current price",
        });
        return false;
      }
    }

    // Build OrderPreview for PolicyEngine
    const order: OrderPreview = {
      symbol: orderSymbol,
      asset_class: assetClass,
      side: "buy",
      notional: Math.round(notional * 100) / 100,
      order_type: "market",
      time_in_force: timeInForce,
      estimated_price: estimatedPrice,
      avg_volume_20d: avgVolume20d,
      estimated_cost: Math.round(notional * 100) / 100,
      buying_power_impact: Math.round(notional * 100) / 100,
    };

    try {
      const [account, positions, clock, riskState] = await Promise.all([
        getAccount(),
        getPositions(),
        getClock(),
        getRiskStateOrDefault(),
      ]);

      if (!isCrypto && shouldBlockEquityEntryNearClose(clock, deps.equityEntryCutoffMinutesBeforeClose)) {
        log("PolicyBroker", "buy_blocked", {
          symbol,
          reason: "Equity entry blocked near market close",
          cutoff_minutes: deps.equityEntryCutoffMinutesBeforeClose,
          next_close: clock.next_close,
        });
        return false;
      }

      const { adjustedNotional, cap } = computeCappedBuyNotional(notional, account, isCrypto);

      if (adjustedNotional <= 0) {
        log("PolicyBroker", "buy_blocked", {
          symbol,
          reason: "Insufficient buying power",
          requested_notional: Math.round(notional * 100) / 100,
          buying_power: account.buying_power,
          daytrading_buying_power: account.daytrading_buying_power,
          effective_cap: Math.round(cap * 100) / 100,
          isCrypto,
        });
        return false;
      }

      if (adjustedNotional < notional) {
        log("PolicyBroker", "buy_notional_adjusted", {
          symbol,
          requested_notional: Math.round(notional * 100) / 100,
          adjusted_notional: adjustedNotional,
          buying_power: account.buying_power,
          daytrading_buying_power: account.daytrading_buying_power,
          effective_cap: Math.round(cap * 100) / 100,
          isCrypto,
        });
      }

      if (adjustedNotional < 100) {
        log("PolicyBroker", "buy_blocked", {
          symbol,
          reason: "Adjusted notional below minimum order size",
          requested_notional: Math.round(notional * 100) / 100,
          adjusted_notional: adjustedNotional,
          min_notional: 100,
        });
        return false;
      }

      order.notional = adjustedNotional;
      order.estimated_cost = adjustedNotional;
      order.buying_power_impact = adjustedNotional;

      const ctx: PolicyContext = { order, account, positions, clock, riskState };
      const result = engine.evaluate(ctx);

      if (!result.allowed) {
        log("PolicyBroker", "buy_rejected", {
          symbol,
          requested_notional: Math.round(notional * 100) / 100,
          adjusted_notional: adjustedNotional,
          violations: result.violations.map((v) => v.message),
        });
        return false;
      }

      if (result.warnings.length > 0) {
        log("PolicyBroker", "buy_warnings", {
          symbol,
          warnings: result.warnings.map((w) => w.message),
        });
      }

      // Execute
      let alpacaOrder;
      try {
        alpacaOrder = await alpaca.trading.createOrder({
          symbol: orderSymbol,
          notional: adjustedNotional,
          side: "buy",
          type: "market",
          time_in_force: timeInForce,
        });
      } catch (error) {
        if (!isCrypto && isTradingHaltMarketOrderError(error)) {
          const snapshot = await alpaca.marketData.getSnapshot(orderSymbol).catch(() => null);
          const referencePrice =
            snapshot?.latest_quote?.ask_price ||
            snapshot?.latest_trade?.price ||
            snapshot?.daily_bar?.c ||
            snapshot?.prev_daily_bar?.c ||
            0;
          const limitPrice = computeHaltLimitPrice(referencePrice);

          if (limitPrice) {
            log("PolicyBroker", "buy_retry_limit_on_halt", {
              symbol: orderSymbol,
              requested_notional: Math.round(notional * 100) / 100,
              adjusted_notional: adjustedNotional,
              reference_price: referencePrice,
              limit_price: limitPrice,
            });

            alpacaOrder = await alpaca.trading.createOrder({
              symbol: orderSymbol,
              notional: adjustedNotional,
              side: "buy",
              type: "limit",
              time_in_force: "day",
              limit_price: limitPrice,
              extended_hours: false,
            });
          } else {
            log("PolicyBroker", "buy_failed_halt_no_price", {
              symbol: orderSymbol,
              error: String(error),
            });
            throw error;
          }
        } else {
          throw error;
        }
      }

      log("PolicyBroker", "buy_executed", {
        symbol: orderSymbol,
        isCrypto,
        status: alpacaOrder.status,
        requested_notional: Math.round(notional * 100) / 100,
        notional: adjustedNotional,
        reason,
        order_type: alpacaOrder.order_type ?? alpacaOrder.type,
      });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      await deps.onBuy?.({
        symbol,
        notional: adjustedNotional,
        reason,
        isCrypto,
        status: String(alpacaOrder.status ?? "submitted"),
        orderType: String(alpacaOrder.order_type ?? alpacaOrder.type ?? "market"),
      });
      return true;
    } catch (error) {
      log("PolicyBroker", "buy_failed", { symbol, error: String(error) });
      return false;
    }
  }

  async function buyOption(contractSymbol: string, quantity: number, reason: string): Promise<boolean> {
    if (!contractSymbol || contractSymbol.trim().length === 0) {
      log("PolicyBroker", "buy_option_blocked", { reason: "Empty contract symbol" });
      return false;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      log("PolicyBroker", "buy_option_blocked", { contract: contractSymbol, reason: "Invalid quantity", quantity });
      return false;
    }

    const parsedContract = parseOptionsContractSymbol(contractSymbol);
    if (!parsedContract) {
      log("PolicyBroker", "buy_option_blocked", {
        contract: contractSymbol,
        reason: "Invalid options contract symbol",
      });
      return false;
    }

    try {
      const [account, positions, clock, riskState, snapshot] = await Promise.all([
        getAccount(),
        getPositions(),
        getClock(),
        getRiskStateOrDefault(),
        alpaca.options.getSnapshot(contractSymbol),
      ]);

      const limitPrice = getOptionsLimitPrice(snapshot);
      if (!limitPrice) {
        log("PolicyBroker", "buy_option_blocked", {
          contract: contractSymbol,
          reason: "No valid options quote available",
        });
        return false;
      }

      const order: OptionsOrderPreview = {
        contract_symbol: contractSymbol.toUpperCase(),
        underlying: parsedContract.underlying,
        side: "buy",
        qty: quantity,
        order_type: "limit",
        limit_price: limitPrice,
        time_in_force: "day",
        expiration: parsedContract.expiration,
        strike: parsedContract.strike,
        option_type: parsedContract.optionType,
        dte: getDTE(parsedContract.expiration),
        delta: snapshot.greeks?.delta,
        estimated_premium: limitPrice,
        estimated_cost: quantity * limitPrice * 100,
        buying_power_impact: quantity * limitPrice * 100,
      };

      const ctx: OptionsPolicyContext = { order, account, positions, clock, riskState };
      const result = engine.evaluateOptionsOrder(ctx);

      if (!result.allowed) {
        log("PolicyBroker", "buy_option_rejected", {
          contract: contractSymbol,
          quantity,
          violations: result.violations.map((v) => v.message),
        });
        return false;
      }

      if (result.warnings.length > 0) {
        log("PolicyBroker", "buy_option_warnings", {
          contract: contractSymbol,
          warnings: result.warnings.map((w) => w.message),
        });
      }

      const alpacaOrder = await alpaca.trading.createOrder({
        symbol: contractSymbol.toUpperCase(),
        qty: quantity,
        side: "buy",
        type: "limit",
        limit_price: limitPrice,
        time_in_force: "day",
      });

      log("PolicyBroker", "buy_option_executed", {
        contract: contractSymbol.toUpperCase(),
        underlying: parsedContract.underlying,
        quantity,
        premium: limitPrice,
        estimated_cost: order.estimated_cost,
        status: alpacaOrder.status,
        reason,
      });

      cachedAccount = null;
      cachedPositions = null;
      return true;
    } catch (error) {
      log("PolicyBroker", "buy_option_failed", { contract: contractSymbol, error: String(error) });
      return false;
    }
  }

  async function sell(symbol: string, reason: string): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      log("PolicyBroker", "sell_blocked", { reason: "Empty symbol" });
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      log("PolicyBroker", "sell_blocked", { symbol, reason: "No sell reason provided" });
      return false;
    }

    // For sells (closing positions), we skip full PolicyEngine evaluation.
    // Closing a position is risk-reducing — blocking exits on kill switch
    // or cooldown would trap users in losing positions.
    // We only check kill switch to log a warning (but still execute).
    try {
      const [clock, position] = await Promise.all([
        getClock(),
        alpaca.trading.getPosition(symbol).catch(() => null),
      ]);

      if (db) {
        const riskState = await getRiskStateOrDefault();
        if (riskState.kill_switch_active) {
          log("PolicyBroker", "sell_during_kill_switch", {
            symbol,
            reason,
            note: "Executing sell despite kill switch — closing positions is risk-reducing",
          });
        }
      }

      if (
        position &&
        position.asset_class === "us_equity" &&
        position.side === "long" &&
        position.qty > 0 &&
        !clock.is_open &&
        isWithinExtendedHoursSession(clock.timestamp)
      ) {
        const snapshot = await alpaca.marketData.getSnapshot(symbol).catch(() => null);
        const limitPrice = computeAfterHoursExitLimitPrice(position, snapshot, deps.afterHoursExitLimitBufferPct);
        if (limitPrice) {
          const existingOpenOrders = await listOpenOrdersForSymbol(symbol);
          const existingAfterHoursExit = existingOpenOrders.find((order) => isManagedAfterHoursExit(order, symbol));
          if (
            existingAfterHoursExit &&
            approximatelyEqual(parseOrderPrice(existingAfterHoursExit), limitPrice, ORDER_PRICE_EPSILON) &&
            approximatelyEqual(parseOrderQty(existingAfterHoursExit), position.qty, ORDER_QTY_EPSILON)
          ) {
            log("PolicyBroker", "sell_executed", {
              symbol,
              reason,
              status: existingAfterHoursExit.status,
              order_type: existingAfterHoursExit.order_type ?? existingAfterHoursExit.type,
              extended_hours: true,
              limit_price: limitPrice,
            });
            return true;
          }

          if (existingAfterHoursExit) {
            await alpaca.trading.cancelOrder(existingAfterHoursExit.id).catch(() => undefined);
          }

          const existingProtectiveStop = existingOpenOrders.find((order) => isManagedProtectiveStop(order, symbol));
          if (existingProtectiveStop) {
            await alpaca.trading.cancelOrder(existingProtectiveStop.id).catch(() => undefined);
          }

          const order = await alpaca.trading.createOrder({
            symbol,
            qty: position.qty,
            side: "sell",
            type: "limit",
            time_in_force: "day",
            limit_price: limitPrice,
            extended_hours: true,
            client_order_id: buildManagedOrderId(AFTER_HOURS_EXIT_ORDER_PREFIX, symbol),
          });

          log("PolicyBroker", "sell_executed", {
            symbol,
            reason,
            status: order.status,
            order_type: order.order_type ?? order.type,
            extended_hours: true,
            limit_price: limitPrice,
          });

          cachedAccount = null;
          cachedPositions = null;
          return true;
        }
      }

      await cancelManagedOrders(symbol);
      await alpaca.trading.closePosition(symbol);
      log("PolicyBroker", "sell_executed", { symbol, reason });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      await deps.onSell?.({ symbol, reason });
      return true;
    } catch (error) {
      log("PolicyBroker", "sell_failed", { symbol, error: String(error) });
      return false;
    }
  }

  async function syncProtectiveStops(positions: Position[]): Promise<void> {
    const longEquityPositions = positions.filter(
      (position) => position.asset_class === "us_equity" && position.side === "long" && position.qty > 0
    );

    const openOrders = await alpaca.trading.listOrders({ status: "open", limit: 200 }).catch(() => []);
    const activeSymbols = new Set(longEquityPositions.map((position) => position.symbol));

    const orphanedStops = openOrders.filter(
      (order) =>
        order.client_order_id.startsWith(MANAGED_STOP_ORDER_PREFIX) &&
        (order.order_type === "stop" || order.type === "stop") &&
        !activeSymbols.has(order.symbol)
    );
    await Promise.all(orphanedStops.map((order) => alpaca.trading.cancelOrder(order.id).catch(() => undefined)));

    for (const position of longEquityPositions) {
      const desiredStopPrice = computeProtectiveStopPrice(position.avg_entry_price || position.current_price, deps.defaultStopLossPct);
      if (!desiredStopPrice) {
        continue;
      }

      const existingStop = openOrders.find((order) => isManagedProtectiveStop(order, position.symbol));
      if (
        existingStop &&
        approximatelyEqual(parseOrderPrice(existingStop), desiredStopPrice, ORDER_PRICE_EPSILON) &&
        approximatelyEqual(parseOrderQty(existingStop), position.qty, ORDER_QTY_EPSILON)
      ) {
        continue;
      }

      if (existingStop) {
        await alpaca.trading.cancelOrder(existingStop.id).catch(() => undefined);
      }

      try {
        await alpaca.trading.createOrder({
          symbol: position.symbol,
          qty: position.qty,
          side: "sell",
          type: "stop",
          time_in_force: "gtc",
          stop_price: desiredStopPrice,
          client_order_id: buildManagedOrderId(MANAGED_STOP_ORDER_PREFIX, position.symbol),
        });

        log("PolicyBroker", "protective_stop_synced", {
          symbol: position.symbol,
          qty: position.qty,
          stop_price: desiredStopPrice,
        });
      } catch (error) {
        log("PolicyBroker", "protective_stop_failed", {
          symbol: position.symbol,
          qty: position.qty,
          stop_price: desiredStopPrice,
          error: String(error),
        });
      }
    }
  }

  return {
    getAccount,
    getPositions,
    getClock,
    buy,
    buyOption,
    sell,
    syncProtectiveStops,
  };
}
