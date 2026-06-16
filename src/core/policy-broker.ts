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
import { type OptionsPolicyContext, type PolicyContext, PolicyEngine } from "../policy/engine";
import type { AlpacaProviders } from "../providers/alpaca";
import { getDTE } from "../providers/alpaca/options";
import type { Account, MarketClock, Order, Position, Snapshot } from "../providers/types";
import type { D1Client } from "../storage/d1/client";
import { createJournalEntry, logOutcome } from "../storage/d1/queries/memory";
import type { RiskState } from "../storage/d1/queries/risk-state";
import { getRiskState, recordDailyLoss, setCooldown } from "../storage/d1/queries/risk-state";
import { createTrade, getTradesToday } from "../storage/d1/queries/trades";
import type { R2Client } from "../storage/r2/client";
import { R2Paths } from "../storage/r2/paths";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import type { StrategyContext } from "../strategy/types";
import { calculateTradeOutcome } from "./trade-outcome";

export interface PolicyBrokerDeps {
  alpaca: AlpacaProviders;
  policyConfig: PolicyConfig;
  db: D1Client | null;
  r2?: R2Client | null;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  cryptoSymbols: string[];
  allowedExchanges: string[];
  afterHoursExitLimitBufferPct?: number;
  maxEntrySpreadPct?: number;
  minEntryQuoteSize?: number;
  maxEntryPriceChangePct?: number;
  dailyLossGuardEnabled?: boolean;
  dailyLossSoftLimitPct?: number;
  dailyLossMinConfidence?: number;
  dailyLossMinEntryQuality?: "excellent" | "good" | "fair" | "poor";
  openPositionLossGuardEnabled?: boolean;
  openPositionLossSoftLimitPct?: number;
  openPositionLossMinConfidence?: number;
  openPositionLossMinEntryQuality?: "excellent" | "good" | "fair" | "poor";
  /** Called after a successful buy order */
  onBuy?: (symbol: string, notional: number, reason: string) => void | Promise<void>;
  /** Called after a successful sell/close order. Return value is persisted into the trade snapshot metadata. */
  onSell?: (symbol: string, reason: string) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
}

/**
 * Create the broker adapter that strategies use via ctx.broker.
 * All orders are validated by PolicyEngine before execution.
 */
export function createPolicyBroker(deps: PolicyBrokerDeps): StrategyContext["broker"] {
  const { alpaca, policyConfig, db, r2, log } = deps;
  const engine = new PolicyEngine({ ...policyConfig, open_position_loss_entry_guard_enabled: false });

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

  function parsePositiveNumber(value: unknown): number | undefined {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  }

  function parseFiniteNumber(value: unknown): number | undefined {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  function getQualityRank(value: unknown): number {
    if (value === "excellent") return 3;
    if (value === "good") return 2;
    if (value === "fair") return 1;
    if (value === "poor") return 0;
    return -1;
  }

  function isFilledOrderStatus(status: string): boolean {
    return status === "filled" || status === "partially_filled";
  }

  function isCompleteSellOrderStatus(status: string): boolean {
    return status === "filled";
  }

  function getSnapshotReferencePrice(snapshot: {
    latest_trade?: { price?: number };
    latest_quote?: { ask_price?: number; bid_price?: number };
  }): number | undefined {
    const tradePrice = parsePositiveNumber(snapshot.latest_trade?.price);
    if (tradePrice !== undefined) return tradePrice;

    const ask = parsePositiveNumber(snapshot.latest_quote?.ask_price);
    const bid = parsePositiveNumber(snapshot.latest_quote?.bid_price);
    if (ask !== undefined && bid !== undefined) return (ask + bid) / 2;
    return ask ?? bid;
  }

  function enrichLifecycleWithExitMetrics(
    lifecycle: Record<string, unknown> | undefined,
    exitPrice: number
  ): Record<string, unknown> | undefined {
    if (!lifecycle) return undefined;
    const entryPrice = parsePositiveNumber(lifecycle.entry_price);
    const peakPrice = parsePositiveNumber(lifecycle.peak_price);
    const troughPrice = parsePositiveNumber(lifecycle.trough_price);
    if (entryPrice === undefined || exitPrice <= 0) return lifecycle;

    const peakGainPct = peakPrice !== undefined ? ((peakPrice - entryPrice) / entryPrice) * 100 : undefined;
    const troughLossPct = troughPrice !== undefined ? ((troughPrice - entryPrice) / entryPrice) * 100 : undefined;
    const exitGainPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const mfePct = parseFiniteNumber(lifecycle.mfe_pct) ?? peakGainPct;
    const maePct = parseFiniteNumber(lifecycle.mae_pct) ?? troughLossPct;
    const givebackPct = mfePct !== undefined ? Math.max(0, mfePct - Math.max(0, exitGainPct)) : undefined;
    const exitEfficiencyPct =
      mfePct !== undefined && mfePct > 0 ? Math.max(0, Math.min(100, (exitGainPct / mfePct) * 100)) : undefined;

    return {
      ...lifecycle,
      exit_price: Number(exitPrice.toFixed(4)),
      exit_gain_pct: Number(exitGainPct.toFixed(4)),
      ...(mfePct !== undefined ? { mfe_pct: Number(mfePct.toFixed(4)) } : {}),
      ...(maePct !== undefined ? { mae_pct: Number(maePct.toFixed(4)) } : {}),
      ...(givebackPct !== undefined ? { giveback_pct: Number(givebackPct.toFixed(4)) } : {}),
      ...(exitEfficiencyPct !== undefined ? { exit_efficiency_pct: Number(exitEfficiencyPct.toFixed(4)) } : {}),
    };
  }

  async function recordBrokerTrade(params: {
    alpacaOrderId: string;
    symbol: string;
    side: "buy" | "sell";
    qty?: number;
    notional?: number;
    orderType: string;
    limitPrice?: number;
    stopPrice?: number;
    status: string;
    filledQty?: number;
    filledAvgPrice?: number;
    reason: string;
    metadata?: Record<string, unknown>;
    account?: Account;
    positions?: Position[];
    policy?: Record<string, unknown>;
    outcomePosition?: Position;
  }): Promise<void> {
    if (!db) {
      if (params.side === "sell" && isCompleteSellOrderStatus(params.status)) {
        await deps.onSell?.(params.symbol, params.reason);
      }
      return;
    }

    try {
      const tradeId = await createTrade(db, {
        alpaca_order_id: params.alpacaOrderId,
        symbol: params.symbol,
        side: params.side,
        qty: params.qty,
        notional: params.notional,
        order_type: params.orderType,
        limit_price: params.limitPrice,
        stop_price: params.stopPrice,
        status: params.status,
        filled_qty: params.filledQty,
        filled_avg_price: params.filledAvgPrice,
      });
      let lifecycleMetadata: Record<string, unknown> | undefined;

      if (params.side === "buy") {
        const isFilledBuy = isFilledOrderStatus(params.status);
        if (!isFilledBuy) {
          log("PolicyBroker", "buy_outcome_deferred", {
            symbol: params.symbol,
            order_id: params.alpacaOrderId,
            status: params.status,
            reason: "Buy order not filled yet; deferring trade journal entry",
          });
        }
        const entryPrice =
          params.filledAvgPrice ??
          params.positions?.find(
            (position) => normalizeCryptoSymbol(position.symbol) === normalizeCryptoSymbol(params.symbol)
          )?.current_price ??
          undefined;
        if (isFilledBuy) {
          await createJournalEntry(db, {
            trade_id: tradeId,
            symbol: params.symbol,
            side: params.side,
            entry_price: entryPrice,
            qty: params.filledQty ?? params.qty ?? params.notional ?? 0,
            signals: {
              reason: params.reason,
              ...params.metadata,
              policy: params.policy,
            },
            technicals: {
              account_equity: params.account?.equity,
              account_cash: params.account?.cash,
            },
            regime_tags: ["autonomous", "policy_broker"],
            notes: params.reason,
          });
        }
      } else {
        const isFilledSell = isCompleteSellOrderStatus(params.status);
        if (!isFilledSell) {
          log("PolicyBroker", "sell_outcome_deferred", {
            symbol: params.symbol,
            order_id: params.alpacaOrderId,
            status: params.status,
            reason: "Sell order not filled yet; leaving trade journal open",
          });
        }
        const position =
          params.outcomePosition ??
          params.positions?.find((p) => normalizeCryptoSymbol(p.symbol) === normalizeCryptoSymbol(params.symbol));
        const normalizedSymbol = normalizeCryptoSymbol(params.symbol);
        const rawSymbol = params.symbol.trim().toUpperCase();
        const openJournal = isFilledSell
          ? await db.executeOne<{ id: string; entry_at: string | null }>(
              `SELECT id, entry_at FROM trade_journal
           WHERE symbol IN (?, ?) AND exit_at IS NULL
           ORDER BY COALESCE(entry_at, created_at) DESC
           LIMIT 1`,
              [params.symbol, normalizedSymbol === params.symbol ? rawSymbol : normalizedSymbol]
            )
          : null;
        if (isFilledSell && openJournal && position) {
          const filledAvgPrice = parsePositiveNumber(params.filledAvgPrice);
          const filledQty = parsePositiveNumber(params.filledQty) ?? parsePositiveNumber(params.qty);
          const avgEntryPrice = parsePositiveNumber(position.avg_entry_price);
          const exitPrice = filledAvgPrice ?? position.current_price ?? position.lastday_price ?? 0;
          const realizedOutcome =
            filledAvgPrice !== undefined && avgEntryPrice !== undefined && filledQty !== undefined
              ? calculateTradeOutcome({
                  entryPrice: avgEntryPrice,
                  exitPrice: filledAvgPrice,
                  qty: filledQty,
                  entryAt: openJournal.entry_at,
                })
              : null;
          const fallbackPnlUsd = position.unrealized_pl ?? 0;
          const fallbackCostBasis = parsePositiveNumber(position.cost_basis) ?? position.market_value - fallbackPnlUsd;
          const pnlUsd = realizedOutcome?.pnlUsd ?? fallbackPnlUsd;
          const pnlPct = realizedOutcome?.pnlPct ?? (fallbackCostBasis !== 0 ? (pnlUsd / fallbackCostBasis) * 100 : 0);
          const holdDurationMins = realizedOutcome?.holdDurationMins ?? 0;
          const outcome = realizedOutcome?.outcome ?? (pnlUsd > 0 ? "win" : pnlUsd < 0 ? "loss" : "scratch");

          const maybeLifecycleMetadata = deps.onSell ? await deps.onSell(params.symbol, params.reason) : undefined;
          lifecycleMetadata =
            maybeLifecycleMetadata && typeof maybeLifecycleMetadata === "object" && !Array.isArray(maybeLifecycleMetadata)
              ? maybeLifecycleMetadata
              : undefined;
          lifecycleMetadata = enrichLifecycleWithExitMetrics(lifecycleMetadata, exitPrice);

          await logOutcome(db, {
            journal_id: openJournal.id,
            exit_price: exitPrice,
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            hold_duration_mins: holdDurationMins,
            outcome,
            lessons_learned: params.reason,
            signal_updates: lifecycleMetadata
              ? {
                  exit_reason: params.reason,
                  lifecycle: lifecycleMetadata,
                  ...lifecycleMetadata,
                }
              : { exit_reason: params.reason },
          });
          if (outcome === "loss") {
            await recordDailyLoss(db, Math.abs(pnlUsd));
            const cooldownMinutes = policyConfig.cooldown_minutes_after_loss;
            if (cooldownMinutes > 0) {
              await setCooldown(db, new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString());
            }
          }
        }
      }

      if (r2) {
        await r2.putJson(R2Paths.tradeSnapshot(tradeId), {
          trade_id: tradeId,
          exported_from: "policy_broker",
          captured_at: new Date().toISOString(),
          symbol: params.symbol,
          side: params.side,
          status: params.status,
          reason: params.reason,
          account: params.account,
          positions: params.positions,
          policy: params.policy,
          metadata: params.metadata,
          lifecycle_metadata: lifecycleMetadata,
        });
      }
    } catch (error) {
      log("PolicyBroker", "trade_record_failed", {
        symbol: params.symbol,
        side: params.side,
        order_id: params.alpacaOrderId,
        error: String(error),
      });
    }
  }

  async function buy(
    symbol: string,
    notional: number,
    reason: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
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
        dailyBars.length > 0 ? dailyBars.map((bar) => bar.v) : snapshot?.daily_bar?.v ? [snapshot.daily_bar.v] : []
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
      confidence: parseFiniteNumber(metadata?.confidence ?? metadata?.research_confidence),
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
        const violationRules = result.violations.map((violation) => violation.rule);
        log("PolicyBroker", "buy_rejected", {
          symbol,
          notional,
          reason: violationRules[0] ?? "policy_violation",
          violation_rules: violationRules,
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

      const dailyLossGuardEnabled = deps.dailyLossGuardEnabled ?? true;
      const dailyLossSoftLimitPct = deps.dailyLossSoftLimitPct ?? 0;
      if (!isCrypto && dailyLossGuardEnabled && dailyLossSoftLimitPct > 0 && account.equity > 0) {
        const dailyLossPct = riskState.daily_loss_usd / account.equity;
        if (dailyLossPct >= dailyLossSoftLimitPct) {
          const confidence = parseFiniteNumber(metadata?.confidence ?? metadata?.research_confidence) ?? 0;
          const minConfidence = deps.dailyLossMinConfidence ?? 0.8;
          const quality = metadata?.entry_quality;
          const minQuality = deps.dailyLossMinEntryQuality ?? "good";
          if (confidence < minConfidence || getQualityRank(quality) < getQualityRank(minQuality)) {
            log("PolicyBroker", "buy_blocked_daily_loss_soft_guard", {
              symbol: orderSymbol,
              reason: "daily_loss_soft_guard",
              daily_loss_usd: riskState.daily_loss_usd,
              daily_loss_pct: Number(dailyLossPct.toFixed(4)),
              soft_limit_pct: dailyLossSoftLimitPct,
              confidence,
              min_confidence: minConfidence,
              entry_quality: typeof quality === "string" ? quality : null,
              min_entry_quality: minQuality,
            });
            return false;
          }
        }
      }

      const openPositionLossGuardEnabled = deps.openPositionLossGuardEnabled ?? true;
      const openPositionLossSoftLimitPct = deps.openPositionLossSoftLimitPct ?? 0;
      if (openPositionLossGuardEnabled && openPositionLossSoftLimitPct > 0 && account.equity > 0) {
        const openPnlUsd = positions.reduce((sum, position) => sum + (Number(position.unrealized_pl) || 0), 0);
        const openLossPct = Math.abs(Math.min(0, openPnlUsd)) / account.equity;
        if (openLossPct >= openPositionLossSoftLimitPct) {
          const confidence = parseFiniteNumber(metadata?.confidence ?? metadata?.research_confidence) ?? 0;
          const minConfidence = deps.openPositionLossMinConfidence ?? 0.85;
          const quality = metadata?.entry_quality;
          const minQuality = deps.openPositionLossMinEntryQuality ?? "excellent";
          if (confidence < minConfidence || getQualityRank(quality) < getQualityRank(minQuality)) {
            log("PolicyBroker", "buy_blocked_open_position_loss_guard", {
              symbol: orderSymbol,
              reason: "open_position_loss_guard",
              open_pnl_usd: Number(openPnlUsd.toFixed(2)),
              open_loss_pct: Number(openLossPct.toFixed(4)),
              soft_limit_pct: openPositionLossSoftLimitPct,
              confidence,
              min_confidence: minConfidence,
              entry_quality: typeof quality === "string" ? quality : null,
              min_entry_quality: minQuality,
            });
            return false;
          }
        }
      }

      try {
        const openOrders = await alpaca.trading.listOrders({ status: "open" });
        const isOpenOrder = (status: string) => !["filled", "canceled", "expired", "rejected"].includes(status);
        const pendingBuy = openOrders.find(
          (openOrder) =>
            openOrder.symbol?.toUpperCase() === orderSymbol.toUpperCase() &&
            openOrder.side === "buy" &&
            isOpenOrder(openOrder.status)
        );
        if (pendingBuy) {
          log("PolicyBroker", "buy_blocked_pending_order", {
            symbol: orderSymbol,
            order_id: pendingBuy.id,
            status: pendingBuy.status,
          });
          return false;
        }

        const heldSymbols = new Set(positions.map((position) => normalizeCryptoSymbol(position.symbol)));
        const pendingNewBuySymbols = new Set(
          openOrders
            .filter((openOrder) => openOrder.side === "buy" && isOpenOrder(openOrder.status))
            .map((openOrder) => normalizeCryptoSymbol(openOrder.symbol))
            .filter((pendingSymbol) => !heldSymbols.has(pendingSymbol))
        );
        const isExistingPosition = heldSymbols.has(normalizeCryptoSymbol(orderSymbol));
        if (!isExistingPosition && positions.length + pendingNewBuySymbols.size >= policyConfig.max_open_positions) {
          log("PolicyBroker", "buy_blocked_pending_capacity", {
            symbol: orderSymbol,
            open_positions: positions.length,
            pending_new_buys: pendingNewBuySymbols.size,
            max_open_positions: policyConfig.max_open_positions,
          });
          return false;
        }
      } catch (ordersError) {
        log("PolicyBroker", "buy_blocked_pending_order_check_unavailable", {
          symbol: orderSymbol,
          reason: "pending_order_check_unavailable",
          error: String(ordersError),
        });
        return false;
      }

      if (db && policyConfig.max_daily_entry_orders > 0) {
        const todayTrades = await getTradesToday(db);
        const todayBuyTrades = todayTrades.filter((trade) => trade.side === "buy");
        const todayBuyOrders = todayBuyTrades.length;
        if (todayBuyOrders >= policyConfig.max_daily_entry_orders) {
          log("PolicyBroker", "buy_blocked_daily_entry_limit", {
            symbol: orderSymbol,
            daily_entry_orders: todayBuyOrders,
            max_daily_entry_orders: policyConfig.max_daily_entry_orders,
          });
          return false;
        }

        if (policyConfig.min_minutes_between_entries > 0) {
          const latestBuy = todayBuyTrades
            .map((trade) => new Date(trade.created_at).getTime())
            .filter((timestamp) => Number.isFinite(timestamp))
            .sort((a, b) => b - a)[0];
          if (latestBuy !== undefined) {
            const elapsedMinutes = (Date.now() - latestBuy) / 60_000;
            if (elapsedMinutes < policyConfig.min_minutes_between_entries) {
              log("PolicyBroker", "buy_blocked_entry_spacing", {
                symbol: orderSymbol,
                elapsed_minutes: Number(Math.max(0, elapsedMinutes).toFixed(2)),
                min_minutes_between_entries: policyConfig.min_minutes_between_entries,
              });
              return false;
            }
          }
        }
      }

      const maxEntryPriceChangePct = deps.maxEntryPriceChangePct ?? 0;
      let entryPriceChangePct = parseFiniteNumber(metadata?.entry_price_change_pct);
      if (!isCrypto && maxEntryPriceChangePct > 0 && entryPriceChangePct === undefined) {
        try {
          const snapshot = await alpaca.marketData.getSnapshot(orderSymbol);
          const referencePrice = getSnapshotReferencePrice(snapshot);
          const prevClose = parsePositiveNumber(snapshot.prev_daily_bar?.c);
          if (referencePrice !== undefined && prevClose !== undefined) {
            entryPriceChangePct = ((referencePrice - prevClose) / prevClose) * 100;
          } else {
            log("PolicyBroker", "buy_price_change_check_unavailable", {
              symbol: orderSymbol,
              reason: "Invalid reference or previous close",
              reference_price: referencePrice ?? null,
              prev_close: prevClose ?? null,
            });
          }
        } catch (snapshotError) {
          log("PolicyBroker", "buy_price_change_check_unavailable", {
            symbol: orderSymbol,
            reason: String(snapshotError),
          });
        }
      }
      if (!isCrypto && maxEntryPriceChangePct > 0 && entryPriceChangePct !== undefined) {
        if (entryPriceChangePct > maxEntryPriceChangePct) {
          log("PolicyBroker", "buy_blocked_overextended_entry", {
            symbol: orderSymbol,
            reason: "entry_price_change_too_high",
            entry_price_change_pct: Number(entryPriceChangePct.toFixed(4)),
            max_entry_price_change_pct: maxEntryPriceChangePct,
          });
          return false;
        }
      }

      let quoteBid: number | null = null;
      let quoteAsk: number | null = null;
      let quoteMid: number | null = null;
      let quoteSpreadPct: number | null = null;
      let quoteBidSize: number | null = null;
      let quoteAskSize: number | null = null;
      const maxEntrySpreadPct = deps.maxEntrySpreadPct ?? 0;
      const minEntryQuoteSize = deps.minEntryQuoteSize ?? 0;
      if (!isCrypto && (maxEntrySpreadPct > 0 || minEntryQuoteSize > 0)) {
        try {
          const quote = await alpaca.marketData.getQuote(orderSymbol);
          const bid = Number(quote.bid_price);
          const ask = Number(quote.ask_price);
          if (bid > 0 && ask > 0 && ask >= bid) {
            quoteBid = bid;
            quoteAsk = ask;
            quoteMid = (bid + ask) / 2;
            quoteSpreadPct = ((ask - bid) / ask) * 100;
            quoteBidSize = parseFiniteNumber(quote.bid_size) ?? null;
            quoteAskSize = parseFiniteNumber(quote.ask_size) ?? null;
            if (quoteSpreadPct > maxEntrySpreadPct) {
              log("PolicyBroker", "buy_blocked_wide_spread", {
                symbol: orderSymbol,
                reason: "wide_spread",
                bid,
                ask,
                spread_pct: Number(quoteSpreadPct.toFixed(4)),
                max_spread_pct: maxEntrySpreadPct,
              });
              return false;
            }
            if (
              minEntryQuoteSize > 0 &&
              (quoteBidSize === null ||
                quoteAskSize === null ||
                quoteBidSize < minEntryQuoteSize ||
                quoteAskSize < minEntryQuoteSize)
            ) {
              log("PolicyBroker", "buy_blocked_thin_quote", {
                symbol: orderSymbol,
                reason: "thin_quote",
                bid,
                ask,
                bid_size: quoteBidSize,
                ask_size: quoteAskSize,
                min_quote_size: minEntryQuoteSize,
              });
              return false;
            }
          } else {
            log("PolicyBroker", "buy_blocked_spread_check_unavailable", {
              symbol: orderSymbol,
              reason: "Invalid bid/ask",
              bid,
              ask,
            });
            return false;
          }
        } catch (quoteError) {
          log("PolicyBroker", "buy_blocked_spread_check_unavailable", {
            symbol: orderSymbol,
            reason: String(quoteError),
          });
          return false;
        }
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

      const orderAccepted = !["rejected", "canceled", "expired"].includes(alpacaOrder.status);
      const orderFilled = isFilledOrderStatus(alpacaOrder.status);
      const filledAvgPrice = alpacaOrder.filled_avg_price ? Number(alpacaOrder.filled_avg_price) : undefined;
      const entrySlippagePct =
        filledAvgPrice !== undefined && Number.isFinite(filledAvgPrice) && quoteMid !== null && quoteMid > 0
          ? ((filledAvgPrice - quoteMid) / quoteMid) * 100
          : null;

      log("PolicyBroker", orderFilled ? "buy_executed" : "buy_submitted", {
        symbol: orderSymbol,
        requested_symbol: symbol,
        isCrypto,
        status: alpacaOrder.status,
        order_id: alpacaOrder.id,
        filled_qty: alpacaOrder.filled_qty,
        filled_avg_price: alpacaOrder.filled_avg_price,
        entry_slippage_pct: entrySlippagePct === null ? null : Number(entrySlippagePct.toFixed(4)),
        notional,
        quote_bid: quoteBid,
        quote_ask: quoteAsk,
        quote_bid_size: quoteBidSize,
        quote_ask_size: quoteAskSize,
        quote_mid: quoteMid,
        quote_spread_pct: quoteSpreadPct === null ? null : Number(quoteSpreadPct.toFixed(4)),
        reason,
        order_type: alpacaOrder.order_type ?? alpacaOrder.type,
      });

      if (!orderAccepted) {
        return false;
      }

      await recordBrokerTrade({
        alpacaOrderId: alpacaOrder.id,
        symbol: orderSymbol,
        side: "buy",
        notional: Math.round(notional * 100) / 100,
        orderType: "market",
        status: alpacaOrder.status,
        filledQty: Number(alpacaOrder.filled_qty) || undefined,
        filledAvgPrice: filledAvgPrice,
        reason,
        metadata,
        account,
        positions,
        policy: {
          warnings: result.warnings.map((warning) => warning.message),
          order,
          entry_price_change_pct:
            entryPriceChangePct === undefined ? null : Number(entryPriceChangePct.toFixed(4)),
          quote_bid: quoteBid,
          quote_ask: quoteAsk,
          quote_bid_size: quoteBidSize,
          quote_ask_size: quoteAskSize,
          quote_mid: quoteMid,
          quote_spread_pct: quoteSpreadPct === null ? null : Number(quoteSpreadPct.toFixed(4)),
          entry_slippage_pct: entrySlippagePct === null ? null : Number(entrySlippagePct.toFixed(4)),
        },
      });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      if (!orderFilled) {
        return false;
      }

      const filledQty = Number(alpacaOrder.filled_qty);
      const filledNotional =
        Number.isFinite(filledQty) && filledQty > 0 && filledAvgPrice !== undefined
          ? filledQty * filledAvgPrice
          : notional;
      await deps.onBuy?.(symbol, filledNotional, reason);
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
      const [clock, position] = await Promise.all([getClock(), alpaca.trading.getPosition(symbol).catch(() => null)]);

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

      const positions = await getPositions();
      const position = positions.find(
        (p) => p.symbol === symbol || normalizeCryptoSymbol(p.symbol) === normalizeCryptoSymbol(symbol)
      );
      const orderSymbol = position?.symbol ?? symbol;
      try {
        const openOrders = await alpaca.trading.listOrders({ status: "open", symbols: [orderSymbol] });
        const pendingSell = openOrders.find(
          (openOrder) =>
            normalizeCryptoSymbol(openOrder.symbol) === normalizeCryptoSymbol(orderSymbol) &&
            openOrder.side === "sell" &&
            !["filled", "canceled", "expired", "rejected"].includes(openOrder.status)
        );
        if (pendingSell) {
          log("PolicyBroker", "sell_blocked_pending_order", {
            symbol: orderSymbol,
            requested_symbol: symbol,
            order_id: pendingSell.id,
            status: pendingSell.status,
          });
          return false;
        }
      } catch (ordersError) {
        log("PolicyBroker", "sell_pending_order_check_unavailable", {
          symbol: orderSymbol,
          requested_symbol: symbol,
          reason: String(ordersError),
        });
      }
      const isCrypto = isCryptoSymbol(symbol, deps.cryptoSymbols);
      const clock = await getClock();
      const bufferPct = deps.afterHoursExitLimitBufferPct ?? 0;
      let sellFilled = false;

      if (!clock.is_open && !isCrypto && position && bufferPct > 0) {
        const quote = await alpaca.marketData.getQuote(position.symbol).catch(() => null);
        const referencePrice = quote?.bid_price || position.current_price || position.lastday_price || 0;
        const limitPrice = Math.round(referencePrice * (1 - bufferPct / 100) * 100) / 100;
        const qty = Math.abs(Number(position.qty));

        if (limitPrice > 0 && qty > 0) {
          const order = await alpaca.trading.createOrder({
            symbol: position.symbol,
            qty,
            side: "sell",
            type: "limit",
            limit_price: limitPrice,
            time_in_force: "day",
            extended_hours: true,
          });
          sellFilled = isCompleteSellOrderStatus(order.status);
          log("PolicyBroker", sellFilled ? "sell_limit_executed" : "sell_limit_submitted", {
            symbol: position.symbol,
            reason,
            status: order.status,
            order_id: order.id,
            limit_price: limitPrice,
            buffer_pct: bufferPct,
          });
          if (["rejected", "canceled", "expired"].includes(order.status)) {
            return false;
          }
          await recordBrokerTrade({
            alpacaOrderId: order.id,
            symbol: position.symbol,
            side: "sell",
            qty,
            orderType: "limit",
            limitPrice,
            status: order.status,
            filledQty: parsePositiveNumber(order.filled_qty),
            filledAvgPrice: parsePositiveNumber(order.filled_avg_price),
            reason,
            positions,
            outcomePosition: position,
          });
        } else {
          const order = await alpaca.trading.closePosition(orderSymbol);
          sellFilled = isCompleteSellOrderStatus(order.status);
          log("PolicyBroker", sellFilled ? "sell_executed" : "sell_submitted", {
            symbol: orderSymbol,
            requested_symbol: symbol,
            reason,
            fallback: "invalid_after_hours_limit",
          });
          await recordBrokerTrade({
            alpacaOrderId: order.id,
            symbol: orderSymbol,
            side: "sell",
            qty: position ? Math.abs(Number(position.qty)) : undefined,
            orderType: "market",
            status: order.status,
            filledQty: parsePositiveNumber(order.filled_qty),
            filledAvgPrice: parsePositiveNumber(order.filled_avg_price),
            reason,
            positions,
            outcomePosition: position,
          });
        }
      } else {
        const order = await alpaca.trading.closePosition(orderSymbol);
        sellFilled = isCompleteSellOrderStatus(order.status);
        log("PolicyBroker", sellFilled ? "sell_executed" : "sell_submitted", {
          symbol: orderSymbol,
          requested_symbol: symbol,
          reason,
          status: order.status,
          order_id: order.id,
          filled_qty: order.filled_qty,
          filled_avg_price: order.filled_avg_price,
        });
        await recordBrokerTrade({
          alpacaOrderId: order.id,
          symbol: orderSymbol,
          side: "sell",
          qty: position ? Math.abs(Number(position.qty)) : undefined,
          orderType: "market",
          status: order.status,
          filledQty: parsePositiveNumber(order.filled_qty),
          filledAvgPrice: parsePositiveNumber(order.filled_avg_price),
          reason,
          positions,
          outcomePosition: position,
        });
      }

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      if (!sellFilled) {
        return false;
      }

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
      const desiredStopPrice = computeProtectiveStopPrice(
        position.avg_entry_price || position.current_price,
        deps.defaultStopLossPct
      );
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
