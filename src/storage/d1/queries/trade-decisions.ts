import { generateId, nowISO } from "../../../lib/utils";
import type { D1Client, TradeDecisionRow } from "../client";

export interface InsertTradeDecisionParams {
  id?: string;
  cycle_id: string;
  decision_at?: string;
  source: string;
  symbol: string;
  action: string;
  status: string;
  confidence?: number | null;
  reason?: string | null;
  notional?: number | null;
  price?: number | null;
  pnl_pct?: number | null;
  trade_id?: string | null;
  journal_id?: string | null;
  snapshot_r2_key?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function insertTradeDecision(db: D1Client, params: InsertTradeDecisionParams): Promise<string> {
  const id = params.id ?? generateId();
  const now = nowISO();

  await db.run(
    `INSERT INTO trade_decisions (
      id, cycle_id, decision_at, source, symbol, action, status, confidence, reason, notional, price, pnl_pct,
      trade_id, journal_id, snapshot_r2_key, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.cycle_id,
      params.decision_at ?? now,
      params.source,
      params.symbol.toUpperCase(),
      params.action,
      params.status,
      params.confidence ?? null,
      params.reason ?? null,
      params.notional ?? null,
      params.price ?? null,
      params.pnl_pct ?? null,
      params.trade_id ?? null,
      params.journal_id ?? null,
      params.snapshot_r2_key ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now,
    ]
  );

  return id;
}

export async function queryTradeDecisions(
  db: D1Client,
  params: {
    symbol?: string;
    source?: string;
    action?: string;
    status?: string;
    days?: number;
    limit?: number;
    offset?: number;
  }
): Promise<TradeDecisionRow[]> {
  const { symbol, source, action, status, days = 30, limit = 100, offset = 0 } = params;
  const conditions: string[] = ["created_at >= ?"];
  const values: unknown[] = [new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()];

  if (symbol) {
    conditions.push("symbol = ?");
    values.push(symbol.toUpperCase());
  }
  if (source) {
    conditions.push("source = ?");
    values.push(source);
  }
  if (action) {
    conditions.push("action = ?");
    values.push(action.toUpperCase());
  }
  if (status) {
    conditions.push("status = ?");
    values.push(status);
  }

  values.push(limit, offset);

  return db.execute<TradeDecisionRow>(
    `SELECT * FROM trade_decisions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    values
  );
}

export async function getTradeDecisionStats(
  db: D1Client,
  params: { symbol?: string; days?: number } = {}
): Promise<{
  total_decisions: number;
  buys: number;
  sells: number;
  skips: number;
  waits: number;
  submitted: number;
  blocked: number;
}> {
  const { symbol, days = 30 } = params;
  let query = `
    SELECT
      COUNT(*) as total_decisions,
      SUM(CASE WHEN action = 'BUY' THEN 1 ELSE 0 END) as buys,
      SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) as sells,
      SUM(CASE WHEN action = 'SKIP' THEN 1 ELSE 0 END) as skips,
      SUM(CASE WHEN action = 'WAIT' THEN 1 ELSE 0 END) as waits,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status = 'blocked' OR status = 'filtered' THEN 1 ELSE 0 END) as blocked
    FROM trade_decisions
    WHERE created_at >= ?
  `;
  const values: unknown[] = [new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()];

  if (symbol) {
    query += " AND symbol = ?";
    values.push(symbol.toUpperCase());
  }

  const row = await db.executeOne<{
    total_decisions: number;
    buys: number | null;
    sells: number | null;
    skips: number | null;
    waits: number | null;
    submitted: number | null;
    blocked: number | null;
  }>(query, values);

  return {
    total_decisions: row?.total_decisions ?? 0,
    buys: row?.buys ?? 0,
    sells: row?.sells ?? 0,
    skips: row?.skips ?? 0,
    waits: row?.waits ?? 0,
    submitted: row?.submitted ?? 0,
    blocked: row?.blocked ?? 0,
  };
}
