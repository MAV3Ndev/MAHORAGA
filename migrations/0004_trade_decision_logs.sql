CREATE TABLE trade_decisions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  cycle_id TEXT NOT NULL,
  decision_at TEXT NOT NULL,
  source TEXT NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL,
  reason TEXT,
  notional REAL,
  price REAL,
  pnl_pct REAL,
  trade_id TEXT REFERENCES trades(id),
  journal_id TEXT REFERENCES trade_journal(id),
  snapshot_r2_key TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trade_decisions_cycle ON trade_decisions(cycle_id);
CREATE INDEX idx_trade_decisions_symbol ON trade_decisions(symbol);
CREATE INDEX idx_trade_decisions_source ON trade_decisions(source);
CREATE INDEX idx_trade_decisions_action ON trade_decisions(action);
CREATE INDEX idx_trade_decisions_status ON trade_decisions(status);
CREATE INDEX idx_trade_decisions_created ON trade_decisions(created_at);
