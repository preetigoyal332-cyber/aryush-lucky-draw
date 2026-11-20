-- Aryush Foods Lucky Draw Pro v2.0 (Cloudflare D1 Schema)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retailers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  area TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dl_code TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  retailer_id INTEGER NOT NULL,
  bags REAL NOT NULL DEFAULT 0,
  loose_kg REAL NOT NULL DEFAULT 0,
  total_kg REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_num INTEGER NOT NULL UNIQUE,
  coupon_code TEXT NOT NULL UNIQUE,
  retailer_id INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  batch_ref TEXT DEFAULT '',
  prize_rank INTEGER DEFAULT 999,
  prize_title TEXT DEFAULT '',
  prize_value REAL DEFAULT 0,
  draw_date TEXT DEFAULT '',
  prize_status TEXT DEFAULT 'NONE',
  remarks TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prize_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rank INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  target_qty INTEGER NOT NULL DEFAULT 1,
  icon TEXT DEFAULT '🏆',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deliveries_retailer ON deliveries(retailer_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(entry_date);
CREATE INDEX IF NOT EXISTS idx_coupons_retailer ON coupons(retailer_id);
CREATE INDEX IF NOT EXISTS idx_coupons_prize ON coupons(prize_status);
