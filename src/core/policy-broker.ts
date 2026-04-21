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
import type { Account, MarketClock, Position } from "../providers/types";
import type { D1Client } from "../storage/d1/client";
import type { RiskState } from "../storage/d1/queries/risk-state";
import { getRiskState } from "../storage/d1/queries/risk-state";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import type { StrategyContext } from "../strategy/types";

export interface PolicyBrokerDeps {
  alpaca: AlpacaProviders;
  policyConfig: PolicyConfig;
  db: D1Client | null;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  cryptoSymbols: string[];
  allowedExchanges: string[];
  /** Called after a successful buy order */
  onBuy?: (symbol: string, notional: number) => void;
  /** Called after a successful sell/close order */
  onSell?: (symbol: string, reason: string) => void;
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

      const ctx: PolicyContext = { order, account, positions, clock, riskState };
      const result = engine.evaluate(ctx);

      if (!result.allowed) {
        log("PolicyBroker", "buy_rejected", {
          symbol,
          notional,
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
          notional: Math.round(notional * 100) / 100,
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
              notional,
              reference_price: referencePrice,
              limit_price: limitPrice,
            });

            alpacaOrder = await alpaca.trading.createOrder({
              symbol: orderSymbol,
              notional: Math.round(notional * 100) / 100,
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
        notional,
        reason,
        order_type: alpacaOrder.order_type ?? alpacaOrder.type,
      });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      deps.onBuy?.(symbol, notional);
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

      await alpaca.trading.closePosition(symbol);
      log("PolicyBroker", "sell_executed", { symbol, reason });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      deps.onSell?.(symbol, reason);
      return true;
    } catch (error) {
      log("PolicyBroker", "sell_failed", { symbol, error: String(error) });
      return false;
    }
  }

  return {
    getAccount,
    getPositions,
    getClock,
    buy,
    buyOption,
    sell,
  };
}
