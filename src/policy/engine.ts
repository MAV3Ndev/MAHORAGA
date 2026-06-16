/**
 * Policy Engine - Trade Validation System
 *
 * This is the safety layer that validates every order before execution.
 * All trades must pass through the policy engine to get an approval token.
 *
 * Checks performed:
 * - Kill switch status (emergency halt)
 * - Loss cooldown period
 * - Daily loss limits
 * - Market hours restrictions
 * - Symbol allow/deny lists
 * - Order type restrictions
 * - Notional (dollar) limits per trade
 * - Position size as % of equity
 * - Maximum open positions
 * - Short selling restrictions
 * - Available buying power
 *
 * If all checks pass, an approval token is generated that must be used
 * within the configured TTL (default 5 minutes) to execute the order.
 */

import type {
  OptionsOrderPreview,
  OptionsPolicyResult,
  OrderPreview,
  PolicyResult,
  PolicyViolation,
  PolicyWarning,
} from "../mcp/types";
import type { Account, MarketClock, Position } from "../providers/types";
import type { RiskState } from "../storage/d1/queries/risk-state";
import type { OptionsStrategy, PolicyConfig } from "./config";

export interface PolicyContext {
  order: OrderPreview;
  account: Account;
  positions: Position[];
  clock: MarketClock;
  riskState: RiskState;
}

export interface OptionsPolicyContext {
  order: OptionsOrderPreview;
  account: Account;
  positions: Position[];
  clock: MarketClock;
  riskState: RiskState;
}

export class PolicyEngine {
  constructor(public config: PolicyConfig) {}

  evaluate(ctx: PolicyContext): PolicyResult {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];

    this.checkKillSwitch(ctx, violations);
    this.checkCooldown(ctx, violations);
    this.checkDailyLossLimit(ctx, violations);
    this.checkTradingHours(ctx, violations, warnings);
    this.checkSymbolFilters(ctx, violations);
    this.checkOrderType(ctx, violations);
    this.checkNotionalLimit(ctx, violations);
    this.checkAveragingDown(ctx, violations);
    this.checkOpenPositionLossEntryGuard(
      ctx,
      violations,
      ctx.order.confidence,
      this.config.open_position_loss_guard_min_confidence
    );
    this.checkPositionSize(ctx, violations, warnings);
    this.checkOpenPositionsLimit(ctx, violations);
    this.checkShortSelling(ctx, violations);
    this.checkBuyingPower(ctx, violations);

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  private checkKillSwitch(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.riskState.kill_switch_active) {
      violations.push({
        rule: "kill_switch",
        message: `Trading halted: ${ctx.riskState.kill_switch_reason ?? "Kill switch activated"}`,
        current_value: true,
        limit_value: false,
      });
    }
  }

  private checkCooldown(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;
    if (!ctx.riskState.cooldown_until) return;

    const cooldownEnd = new Date(ctx.riskState.cooldown_until);
    const now = new Date();

    if (now < cooldownEnd) {
      violations.push({
        rule: "loss_cooldown",
        message: `In cooldown period until ${ctx.riskState.cooldown_until}`,
        current_value: now.toISOString(),
        limit_value: ctx.riskState.cooldown_until,
      });
    }
  }

  private checkDailyLossLimit(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;
    const dailyLossPct = ctx.riskState.daily_loss_usd / ctx.account.equity;

    if (dailyLossPct >= this.config.max_daily_loss_pct) {
      violations.push({
        rule: "daily_loss_limit",
        message: `Daily loss limit reached: ${(dailyLossPct * 100).toFixed(2)}% of equity`,
        current_value: dailyLossPct,
        limit_value: this.config.max_daily_loss_pct,
      });
    }
  }

  private checkTradingHours(ctx: PolicyContext, violations: PolicyViolation[], warnings: PolicyWarning[]): void {
    if (!this.config.trading_hours_only) return;

    // Crypto trades 24/7 — skip market hours check
    if (ctx.order.asset_class === "crypto") return;

    if (!ctx.clock.is_open) {
      if (ctx.order.side === "sell") {
        warnings.push({
          rule: "outside_hours_exit",
          message: "Risk-reducing sell is allowed outside market hours; verify order type and fill status",
        });
        return;
      }

      if (!this.config.extended_hours_allowed) {
        violations.push({
          rule: "trading_hours",
          message: "Trading outside market hours is not allowed",
          current_value: ctx.clock.is_open,
          limit_value: true,
        });
      } else {
        warnings.push({
          rule: "extended_hours",
          message: "Order will be placed during extended hours",
        });
      }
    }
  }

  private checkSymbolFilters(ctx: PolicyContext, violations: PolicyViolation[]): void {
    const symbol = ctx.order.symbol.toUpperCase();

    if (this.config.deny_symbols.map((s) => s.toUpperCase()).includes(symbol)) {
      violations.push({
        rule: "symbol_denied",
        message: `Symbol ${symbol} is on the deny list`,
        current_value: symbol,
        limit_value: "not in deny list",
      });
      return;
    }

    if (this.config.allowed_symbols !== null) {
      const allowed = this.config.allowed_symbols.map((s) => s.toUpperCase());
      if (!allowed.includes(symbol)) {
        violations.push({
          rule: "symbol_not_allowed",
          message: `Symbol ${symbol} is not on the allow list`,
          current_value: symbol,
          limit_value: "in allow list",
        });
      }
    }
  }

  private checkOrderType(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (!this.config.allowed_order_types.includes(ctx.order.order_type)) {
      violations.push({
        rule: "order_type_not_allowed",
        message: `Order type '${ctx.order.order_type}' is not allowed`,
        current_value: ctx.order.order_type,
        limit_value: this.config.allowed_order_types,
      });
    }
  }

  private checkNotionalLimit(ctx: PolicyContext, violations: PolicyViolation[]): void {
    const estimatedNotional = this.estimateNotional(ctx.order);

    if (estimatedNotional > this.config.max_notional_per_trade) {
      violations.push({
        rule: "max_notional",
        message: `Order notional $${estimatedNotional.toFixed(2)} exceeds limit of $${this.config.max_notional_per_trade}`,
        current_value: estimatedNotional,
        limit_value: this.config.max_notional_per_trade,
      });
    }
  }

  private checkPositionSize(ctx: PolicyContext, violations: PolicyViolation[], warnings: PolicyWarning[]): void {
    if (ctx.order.side !== "buy") return;

    const estimatedNotional = this.estimateNotional(ctx.order);
    const existingPosition = this.findExistingPosition(ctx.positions, ctx.order.symbol);
    const existingValue = existingPosition?.market_value ?? 0;
    const totalPositionValue = estimatedNotional + existingValue;
    const positionPct = totalPositionValue / ctx.account.equity;

    if (positionPct > this.config.max_position_pct_equity) {
      violations.push({
        rule: "max_position_pct",
        message: `Position would be ${(positionPct * 100).toFixed(2)}% of equity (limit: ${(this.config.max_position_pct_equity * 100).toFixed(0)}%)`,
        current_value: positionPct,
        limit_value: this.config.max_position_pct_equity,
      });
    } else if (positionPct > this.config.max_position_pct_equity * 0.8) {
      warnings.push({
        rule: "position_size_warning",
        message: `Position will be ${(positionPct * 100).toFixed(2)}% of equity, approaching limit`,
      });
    }
  }

  private checkOpenPositionsLimit(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;

    const existingPosition = this.findExistingPosition(ctx.positions, ctx.order.symbol);
    const isNewPosition = !existingPosition;
    const openPositionCount = ctx.positions.length;

    if (isNewPosition && openPositionCount >= this.config.max_open_positions) {
      violations.push({
        rule: "max_open_positions",
        message: `Already at max ${this.config.max_open_positions} open positions`,
        current_value: openPositionCount,
        limit_value: this.config.max_open_positions,
      });
    }
  }

  private checkAveragingDown(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (!this.config.no_averaging_down) return;
    if (ctx.order.side !== "buy") return;

    const existingPosition = this.findExistingPosition(ctx.positions, ctx.order.symbol);
    if (!existingPosition || existingPosition.unrealized_pl >= 0) return;

    violations.push({
      rule: "averaging_down_blocked",
      message: `Cannot add to losing position ${ctx.order.symbol} (current P/L: $${existingPosition.unrealized_pl.toFixed(2)})`,
      current_value: existingPosition.unrealized_pl,
      limit_value: 0,
    });
  }

  private getOpenPositionLossPct(ctx: Pick<PolicyContext, "account" | "positions">): number {
    if (ctx.account.equity <= 0) return 0;
    const openPnlUsd = ctx.positions.reduce((sum, position) => sum + (Number(position.unrealized_pl) || 0), 0);
    return Math.abs(Math.min(0, openPnlUsd)) / ctx.account.equity;
  }

  private checkOpenPositionLossEntryGuard(
    ctx: PolicyContext,
    violations: PolicyViolation[],
    confidence: number | undefined,
    minConfidence: number
  ): void {
    if (!this.config.open_position_loss_entry_guard_enabled) return;
    if (ctx.order.side !== "buy") return;
    if (this.config.open_position_loss_entry_guard_pct <= 0) return;

    const openLossPct = this.getOpenPositionLossPct(ctx);
    if (openLossPct < this.config.open_position_loss_entry_guard_pct) return;
    const usableConfidence = Number.isFinite(confidence) ? confidence ?? 0 : 0;
    if (usableConfidence >= minConfidence) return;

    violations.push({
      rule: "open_position_loss_entry_guard",
      message: `Open positions are down ${(openLossPct * 100).toFixed(2)}% of equity; new entries require confidence >= ${minConfidence.toFixed(2)}`,
      current_value: { open_loss_pct: openLossPct, confidence: usableConfidence },
      limit_value: {
        open_position_loss_entry_guard_pct: this.config.open_position_loss_entry_guard_pct,
        min_confidence: minConfidence,
      },
    });
  }

  private checkShortSelling(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "sell") return;
    if (this.config.allow_short_selling) return;

    const existingPosition = this.findExistingPosition(ctx.positions, ctx.order.symbol);

    if (!existingPosition) {
      violations.push({
        rule: "short_selling_blocked",
        message: `Short selling is disabled. You don't own ${ctx.order.symbol}.`,
        current_value: 0,
        limit_value: "must own position to sell",
      });
      return;
    }

    const sellQty = ctx.order.qty ?? (ctx.order.notional ? ctx.order.notional / (ctx.order.estimated_price || 1) : 0);
    if (sellQty > existingPosition.qty) {
      violations.push({
        rule: "short_selling_blocked",
        message: `Cannot sell ${sellQty.toFixed(2)} shares of ${ctx.order.symbol} - you only own ${existingPosition.qty.toFixed(2)}. Short selling is disabled.`,
        current_value: sellQty,
        limit_value: existingPosition.qty,
      });
    }
  }

  private checkBuyingPower(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;

    const estimatedNotional = this.estimateNotional(ctx.order);
    const availableFunds = this.config.use_cash_only ? ctx.account.cash : ctx.account.buying_power;
    const fundType = this.config.use_cash_only ? "cash" : "buying power";

    if (estimatedNotional > availableFunds) {
      violations.push({
        rule: "insufficient_funds",
        message: `Insufficient ${fundType}: need $${estimatedNotional.toFixed(2)}, have $${availableFunds.toFixed(2)}`,
        current_value: availableFunds,
        limit_value: estimatedNotional,
      });
    }
  }

  private estimateNotional(order: OrderPreview): number {
    if (order.notional) {
      return order.notional;
    }

    const price = order.estimated_price ?? order.limit_price ?? order.stop_price ?? 0;
    return (order.qty ?? 0) * price;
  }

  private findExistingPosition(positions: Position[], symbol: string): Position | undefined {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    return positions.find((position) => this.normalizeSymbol(position.symbol) === normalizedSymbol);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase().replace(/[\s/._-]/g, "");
  }

  evaluateOptionsOrder(ctx: OptionsPolicyContext): OptionsPolicyResult {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];

    this.checkKillSwitch(ctx as unknown as PolicyContext, violations);
    this.checkCooldown(ctx as unknown as PolicyContext, violations);
    this.checkDailyLossLimit(ctx as unknown as PolicyContext, violations);
    this.checkTradingHours(ctx as unknown as PolicyContext, violations, warnings);

    this.checkOptionsEnabled(violations);
    this.checkOptionsSymbolFilters(ctx, violations);
    this.checkOptionsConfidence(ctx, violations, warnings);
    this.checkOptionsDTE(ctx, violations);
    this.checkOptionsDelta(ctx, violations, warnings);
    this.checkOptionsStrategy(ctx, violations);
    this.checkOptionsPositionSize(ctx, violations);
    this.checkOptionsTotalExposure(ctx, violations, warnings);
    this.checkOptionsPositionCount(ctx, violations);
    this.checkOptionsAveragingDown(ctx, violations);
    this.checkOptionsOpenPositionLossEntryGuard(ctx, violations);
    this.checkOptionsBuyingPower(ctx, violations);

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  private checkOptionsEnabled(violations: PolicyViolation[]): void {
    if (!this.config.options.options_enabled) {
      violations.push({
        rule: "options_disabled",
        message: "Options trading is disabled in policy config",
        current_value: false,
        limit_value: true,
      });
    }
  }

  private checkOptionsSymbolFilters(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    const denySymbols = this.config.deny_symbols.map((symbol) => symbol.toUpperCase());
    const contractSymbol = ctx.order.contract_symbol.toUpperCase();
    const underlying = ctx.order.underlying.toUpperCase();

    if (denySymbols.includes(contractSymbol) || denySymbols.includes(underlying)) {
      violations.push({
        rule: "symbol_denied",
        message: `Option ${contractSymbol} or underlying ${underlying} is on the deny list`,
        current_value: { contract_symbol: contractSymbol, underlying },
        limit_value: "not in deny list",
      });
    }
  }

  private checkOptionsConfidence(
    ctx: OptionsPolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    const { confidence } = ctx.order;
    if (confidence === undefined) {
      warnings.push({
        rule: "options_confidence_unknown",
        message: "Options entry confidence not available - proceeding without confidence validation",
      });
      return;
    }

    const minConfidence = this.config.options.min_confidence_for_options;
    if (confidence < minConfidence) {
      violations.push({
        rule: "options_min_confidence",
        message: `Options entry confidence ${confidence.toFixed(2)} is below minimum ${minConfidence.toFixed(2)}`,
        current_value: confidence,
        limit_value: minConfidence,
      });
    }
  }

  private checkOptionsDTE(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    const { dte } = ctx.order;
    const { min_dte, max_dte } = this.config.options;

    if (dte < min_dte) {
      violations.push({
        rule: "options_min_dte",
        message: `Option DTE ${dte} is below minimum ${min_dte} days (no weeklies)`,
        current_value: dte,
        limit_value: min_dte,
      });
    }

    if (dte > max_dte) {
      violations.push({
        rule: "options_max_dte",
        message: `Option DTE ${dte} exceeds maximum ${max_dte} days`,
        current_value: dte,
        limit_value: max_dte,
      });
    }
  }

  private checkOptionsDelta(ctx: OptionsPolicyContext, violations: PolicyViolation[], warnings: PolicyWarning[]): void {
    const { delta } = ctx.order;
    if (delta === undefined) {
      warnings.push({
        rule: "options_delta_unknown",
        message: "Delta not available - proceeding without delta validation",
      });
      return;
    }

    const absDelta = Math.abs(delta);
    const { min_delta, max_delta } = this.config.options;

    if (absDelta < min_delta) {
      violations.push({
        rule: "options_min_delta",
        message: `Option delta ${absDelta.toFixed(2)} is below minimum ${min_delta} (too far OTM)`,
        current_value: absDelta,
        limit_value: min_delta,
      });
    }

    if (absDelta > max_delta) {
      violations.push({
        rule: "options_max_delta",
        message: `Option delta ${absDelta.toFixed(2)} exceeds maximum ${max_delta} (too far ITM)`,
        current_value: absDelta,
        limit_value: max_delta,
      });
    }
  }

  private checkOptionsStrategy(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    const { side, option_type } = ctx.order;
    const { allowed_strategies } = this.config.options;

    let strategy: OptionsStrategy | null = null;
    if (side === "buy" && option_type === "call") {
      strategy = "long_call";
    } else if (side === "buy" && option_type === "put") {
      strategy = "long_put";
    }

    if (!strategy) {
      violations.push({
        rule: "options_strategy_invalid",
        message: `Options strategy '${side} ${option_type}' is not supported (only long calls/puts allowed)`,
        current_value: `${side} ${option_type}`,
        limit_value: allowed_strategies,
      });
      return;
    }

    if (!allowed_strategies.includes(strategy)) {
      violations.push({
        rule: "options_strategy_not_allowed",
        message: `Options strategy '${strategy}' is not in allowed list`,
        current_value: strategy,
        limit_value: allowed_strategies,
      });
    }
  }

  private checkOptionsPositionSize(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;

    const estimatedCost = this.estimateOptionsCost(ctx.order);
    const maxAllowed = ctx.account.equity * this.config.options.max_pct_per_option_trade;

    if (estimatedCost > maxAllowed) {
      violations.push({
        rule: "options_max_position_size",
        message: `Options order cost $${estimatedCost.toFixed(2)} exceeds ${(this.config.options.max_pct_per_option_trade * 100).toFixed(0)}% of equity ($${maxAllowed.toFixed(2)})`,
        current_value: estimatedCost,
        limit_value: maxAllowed,
      });
    }
  }

  private checkOptionsTotalExposure(
    ctx: OptionsPolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    if (ctx.order.side !== "buy") return;

    const optionsPositions = ctx.positions.filter((p) => p.asset_class === "us_option");
    const currentExposure = optionsPositions.reduce((sum, p) => sum + Math.abs(p.market_value), 0);
    const orderCost = this.estimateOptionsCost(ctx.order);
    const newTotalExposure = currentExposure + orderCost;
    const maxExposure = ctx.account.equity * this.config.options.max_total_options_exposure_pct;

    if (newTotalExposure > maxExposure) {
      violations.push({
        rule: "options_total_exposure",
        message: `Total options exposure $${newTotalExposure.toFixed(2)} would exceed ${(this.config.options.max_total_options_exposure_pct * 100).toFixed(0)}% of equity ($${maxExposure.toFixed(2)})`,
        current_value: newTotalExposure,
        limit_value: maxExposure,
      });
    } else if (newTotalExposure > maxExposure * 0.8) {
      warnings.push({
        rule: "options_exposure_warning",
        message: `Options exposure $${newTotalExposure.toFixed(2)} approaching ${(this.config.options.max_total_options_exposure_pct * 100).toFixed(0)}% limit ($${maxExposure.toFixed(2)})`,
      });
    }
  }

  private checkOptionsPositionCount(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;

    const optionsPositions = ctx.positions.filter((p) => p.asset_class === "us_option");
    const existingPosition = optionsPositions.find(
      (p) => p.symbol.toUpperCase() === ctx.order.contract_symbol.toUpperCase()
    );

    if (!existingPosition && optionsPositions.length >= this.config.options.max_option_positions) {
      violations.push({
        rule: "options_max_positions",
        message: `Already at max ${this.config.options.max_option_positions} options positions`,
        current_value: optionsPositions.length,
        limit_value: this.config.options.max_option_positions,
      });
    }
  }

  private checkOptionsAveragingDown(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    if (!this.config.options.no_averaging_down) return;
    if (ctx.order.side !== "buy") return;

    const optionsPositions = ctx.positions.filter((p) => p.asset_class === "us_option");
    const existingPosition = optionsPositions.find(
      (p) => p.symbol.toUpperCase() === ctx.order.contract_symbol.toUpperCase()
    );

    if (existingPosition && existingPosition.unrealized_pl < 0) {
      violations.push({
        rule: "options_no_averaging_down",
        message: `Cannot add to losing options position (current P/L: $${existingPosition.unrealized_pl.toFixed(2)})`,
        current_value: existingPosition.unrealized_pl,
        limit_value: 0,
      });
    }
  }

  private checkOptionsOpenPositionLossEntryGuard(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    if (!this.config.open_position_loss_entry_guard_enabled) return;
    if (ctx.order.side !== "buy") return;

    this.checkOpenPositionLossEntryGuard(
      {
        order: {
          symbol: ctx.order.contract_symbol,
          asset_class: "us_equity",
          side: "buy",
          qty: ctx.order.qty,
          order_type: ctx.order.order_type,
          limit_price: ctx.order.limit_price,
          time_in_force: ctx.order.time_in_force,
        },
        account: ctx.account,
        positions: ctx.positions,
        clock: ctx.clock,
        riskState: ctx.riskState,
      },
      violations,
      ctx.order.confidence,
      Math.max(this.config.open_position_loss_guard_min_confidence, this.config.options.min_confidence_for_options)
    );
  }

  private checkOptionsBuyingPower(ctx: OptionsPolicyContext, violations: PolicyViolation[]): void {
    if (ctx.order.side !== "buy") return;

    const estimatedCost = this.estimateOptionsCost(ctx.order);
    const availableFunds = this.config.use_cash_only ? ctx.account.cash : ctx.account.buying_power;
    const fundType = this.config.use_cash_only ? "cash" : "buying power";

    if (estimatedCost > availableFunds) {
      violations.push({
        rule: "options_insufficient_funds",
        message: `Insufficient ${fundType}: need $${estimatedCost.toFixed(2)}, have $${availableFunds.toFixed(2)}`,
        current_value: availableFunds,
        limit_value: estimatedCost,
      });
    }
  }

  private estimateOptionsCost(order: OptionsOrderPreview): number {
    if (order.estimated_cost) {
      return order.estimated_cost;
    }
    const premium = order.estimated_premium ?? order.limit_price ?? 0;
    return order.qty * premium * 100;
  }
}
