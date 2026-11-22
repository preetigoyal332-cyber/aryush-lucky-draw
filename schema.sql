CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  val TEXT
);

CREATE TABLE IF NOT EXISTS retailers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  area TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dl_code TEXT DEFAULT '',
  entry_date TEXT NOT NULL,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  bags REAL DEFAULT 0,
  loose_kg REAL DEFAULT 0,
  total_kg REAL NOT NULL,
  remarks TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_num INTEGER NOT NULL UNIQUE,
  coupon_code TEXT NOT NULL,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  issue_date TEXT NOT NULL,
  prize_rank INTEGER DEFAULT 999,
  prize_title TEXT DEFAULT '',
  prize_status TEXT DEFAULT 'NONE',
  draw_date TEXT DEFAULT '',
  handover_proof TEXT DEFAULT '',
  handover_note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_qty INTEGER NOT NULL DEFAULT 1,
  icon TEXT DEFAULT '🎁'
);

CREATE TABLE IF NOT EXISTS media_chunks (
  media_key TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL,
  mime_type TEXT DEFAULT 'video/mp4',
  data_b64 TEXT NOT NULL,
  PRIMARY KEY (media_key, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_retailer ON deliveries(retailer_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(entry_date);
CREATE INDEX IF NOT EXISTS idx_coupons_retailer ON coupons(retailer_id);
CREATE INDEX IF NOT EXISTS idx_coupons_prize_status ON coupons(prize_status);
