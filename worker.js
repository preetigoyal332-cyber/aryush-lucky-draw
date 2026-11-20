// Aryush Foods — Mega Lucky Draw Coupon & Prize Manager
// Clean API Worker (UI is in index.html, served automatically via Cloudflare [assets]!)

let schemaInitialized = false;

async function ensureSchema(db) {
  if (schemaInitialized) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS retailers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      area TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dl_code TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      retailer_id INTEGER NOT NULL,
      bags REAL NOT NULL DEFAULT 0,
      loose_kg REAL NOT NULL DEFAULT 0,
      total_kg REAL NOT NULL DEFAULT 0,
      remarks TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS coupons (
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
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_deliveries_retailer ON deliveries(retailer_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_coupons_retailer ON coupons(retailer_id)`)
  ]);
  schemaInitialized = true;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

async function getSettingsObj(db) {
  const defaults = {
    company_name: "ARYUSH FOODS",
    campaign_name: "MEGA ALTO LUCKY DRAW",
    kg_per_coupon: 210,
    kg_per_bag: 30,
    max_coupons: 300,
    coupon_prefix: "",
    signatory: "For Aryush Foods (Kailaras, Morena)"
  };
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  for (const r of (rows.results || [])) {
    if (["kg_per_coupon", "kg_per_bag", "max_coupons"].includes(r.key)) {
      defaults[r.key] = Number(r.value);
    } else {
      defaults[r.key] = r.value;
    }
  }
  return defaults;
}

async function getOrCreateRetailerId(db, nameRaw, area = "", phone = "") {
  const name = String(nameRaw || "").trim().toUpperCase();
  if (!name) throw new Error("Retailer name is required");
  const existing = await db.prepare("SELECT id FROM retailers WHERE UPPER(name) = ?").bind(name).first();
  if (existing) {
    if (area || phone) {
      await db.prepare("UPDATE retailers SET area = COALESCE(NULLIF(?, ''), area), phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?")
        .bind(area, phone, existing.id).run();
    }
    return existing.id;
  }
  const ins = await db.prepare("INSERT INTO retailers (name, area, phone) VALUES (?, ?, ?) RETURNING id")
    .bind(name, area, phone).first();
  return ins.id;
}

function randomDlCode() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return "DL-" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return jsonResp({ ok: true });

    // Serve index.html and static files via Cloudflare ASSETS binding
    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Static assets binding missing.", { status: 404 });
    }

    if (!env.DB) {
      return jsonResp({ error: "Cloudflare D1 binding 'DB' not configured! Bind your D1 database as 'DB' in Worker Settings -> Bindings." }, 500);
    }

    try {
      await ensureSchema(env.DB);
      const db = env.DB;

      // GET /api/bootstrap
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        const [settings, retailers, deliveries, coupons] = await Promise.all([
          getSettingsObj(db),
          db.prepare("SELECT * FROM retailers ORDER BY name ASC").all(),
          db.prepare("SELECT * FROM deliveries ORDER BY entry_date DESC, id DESC").all(),
          db.prepare("SELECT * FROM coupons ORDER BY coupon_num ASC").all()
        ]);
        return jsonResp({
          settings,
          retailers: retailers.results || [],
          deliveries: deliveries.results || [],
          coupons: coupons.results || []
        });
      }

      // POST /api/settings
      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await request.json();
        const stmts = Object.entries(body).map(([k, v]) =>
          db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(k, String(v ?? ""))
        );
        if (stmts.length) await db.batch(stmts);
        return jsonResp({ ok: true, settings: await getSettingsObj(db) });
      }

      // POST /api/retailers
      if (url.pathname === "/api/retailers" && request.method === "POST") {
        const body = await request.json();
        const id = await getOrCreateRetailerId(db, body.name, body.area || "", body.phone || "");
        const retailer = await db.prepare("SELECT * FROM retailers WHERE id = ?").bind(id).first();
        return jsonResp({ ok: true, retailer });
      }

      // DELETE /api/retailers/:id
      if (url.pathname.startsWith("/api/retailers/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.batch([
          db.prepare("DELETE FROM coupons WHERE retailer_id = ?").bind(id),
          db.prepare("DELETE FROM deliveries WHERE retailer_id = ?").bind(id),
          db.prepare("DELETE FROM retailers WHERE id = ?").bind(id)
        ]);
        return jsonResp({ ok: true });
      }

      // POST /api/deliveries
      if (url.pathname === "/api/deliveries" && request.method === "POST") {
        const body = await request.json();
        const retailerId = body.retailer_id
          ? Number(body.retailer_id)
          : await getOrCreateRetailerId(db, body.retailer_name);

        const bags = Number(body.bags) || 0;
        const loose_kg = Number(body.loose_kg) || 0;
        const total_kg = Number(body.total_kg) || 0;
        const entry_date = String(body.entry_date || new Date().toISOString().slice(0, 10));
        const remarks = String(body.remarks || "");

        if (body.id) {
          await db.prepare(
            "UPDATE deliveries SET entry_date = ?, retailer_id = ?, bags = ?, loose_kg = ?, total_kg = ?, remarks = ? WHERE id = ?"
          ).bind(entry_date, retailerId, bags, loose_kg, total_kg, remarks, Number(body.id)).run();
        } else {
          await db.prepare(
            "INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(randomDlCode(), entry_date, retailerId, bags, loose_kg, total_kg, remarks).run();
        }
        return jsonResp({ ok: true });
      }

      // DELETE /api/deliveries/:id
      if (url.pathname.startsWith("/api/deliveries/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.prepare("DELETE FROM deliveries WHERE id = ?").bind(id).run();
        return jsonResp({ ok: true });
      }

      // POST /api/coupons/allot
      if (url.pathname === "/api/coupons/allot" && request.method === "POST") {
        const body = await request.json();
        const settings = await getSettingsObj(db);
        const maxC = Number(settings.max_coupons) || 300;
        const prefix = settings.coupon_prefix || "";
        const digits = maxC >= 1000 ? 4 : 3;
        const issueDate = String(body.issue_date || new Date().toISOString().slice(0, 10));

        const existingRows = await db.prepare("SELECT coupon_num FROM coupons").all();
        const usedSet = new Set((existingRows.results || []).map(r => Number(r.coupon_num)));

        if (body.manual_coupon_num) {
          const num = Number(body.manual_coupon_num);
          if (num < 1 || num > maxC) return jsonResp({ error: `Coupon number must be between 1 and ${maxC}` }, 400);
          if (usedSet.has(num)) return jsonResp({ error: `Coupon #${num} is already allotted!` }, 400);
          const code = prefix + String(num).padStart(digits, "0");
          await db.prepare(
            "INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, batch_ref) VALUES (?, ?, ?, ?, 'MANUAL')"
          ).bind(num, code, Number(body.retailer_id), issueDate).run();
          return jsonResp({ ok: true, allotted: 1 });
        }

        const allocations = body.allocations || [];
        const totalNeeded = allocations.reduce((s, a) => s + (Number(a.count) || 0), 0);
        if (totalNeeded <= 0) return jsonResp({ error: "No pending coupons to allot" }, 400);

        const available = [];
        for (let i = 1; i <= maxC; i++) {
          if (!usedSet.has(i)) available.push(i);
        }

        if (totalNeeded > available.length) {
          return jsonResp({
            error: `Only ${available.length} coupons remaining in pool (Max ${maxC}), cannot allot ${totalNeeded}. Increase Max Coupons in Settings if needed.`
          }, 400);
        }

        if (body.mode === "random") {
          for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
          }
        }

        const batchRef = "BATCH-" + Date.now().toString(36).toUpperCase();
        const stmts = [];
        let ptr = 0;
        for (const item of allocations) {
          const cnt = Number(item.count) || 0;
          const rId = Number(item.retailer_id);
          for (let k = 0; k < cnt; k++) {
            const num = available[ptr++];
            const code = prefix + String(num).padStart(digits, "0");
            stmts.push(
              db.prepare("INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, batch_ref) VALUES (?, ?, ?, ?, ?)")
                .bind(num, code, rId, issueDate, batchRef)
            );
          }
        }

        for (let i = 0; i < stmts.length; i += 80) {
          await db.batch(stmts.slice(i, i + 80));
        }

        return jsonResp({ ok: true, allotted: totalNeeded });
      }

      // DELETE /api/coupons/:id
      if (url.pathname.startsWith("/api/coupons/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.prepare("DELETE FROM coupons WHERE id = ?").bind(id).run();
        return jsonResp({ ok: true });
      }

      // POST /api/coupons/prize
      if (url.pathname === "/api/coupons/prize" && request.method === "POST") {
        const body = await request.json();
        const title = String(body.prize_title || "").trim();
        const rank = title ? (Number(body.prize_rank) || 99) : 999;
        const status = title ? String(body.prize_status || "WON") : "NONE";
        const drawDate = String(body.draw_date || "");
        const remarks = String(body.remarks || "");

        await db.prepare(
          "UPDATE coupons SET prize_title = ?, prize_rank = ?, draw_date = ?, prize_status = ?, remarks = ? WHERE id = ?"
        ).bind(title, rank, drawDate, status, remarks, Number(body.coupon_id)).run();
        return jsonResp({ ok: true });
      }

      // POST /api/import
      if (url.pathname === "/api/import" && request.method === "POST") {
        const body = await request.json();

        if (body.full_restore) {
          await db.batch([
            db.prepare("DELETE FROM coupons"),
            db.prepare("DELETE FROM deliveries"),
            db.prepare("DELETE FROM retailers")
          ]);
          if (body.settings) {
            const sStmts = Object.entries(body.settings).map(([k, v]) =>
              db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v ?? ""))
            );
            if (sStmts.length) await db.batch(sStmts);
          }
          for (const r of (body.retailers || [])) {
            await db.prepare("INSERT INTO retailers (id, name, area, phone) VALUES (?, ?, ?, ?)").bind(r.id, r.name, r.area || "", r.phone || "").run();
          }
          for (const d of (body.deliveries || [])) {
            await db.prepare("INSERT INTO deliveries (id, dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(d.id, d.dl_code, d.entry_date, d.retailer_id, d.bags, d.loose_kg, d.total_kg, d.remarks || "").run();
          }
          for (const c of (body.coupons || [])) {
            await db.prepare("INSERT INTO coupons (id, coupon_num, coupon_code, retailer_id, issue_date, batch_ref, prize_rank, prize_title, prize_value, draw_date, prize_status, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(c.id, c.coupon_num, c.coupon_code, c.retailer_id, c.issue_date, c.batch_ref || "", c.prize_rank ?? 999, c.prize_title || "", c.prize_value || 0, c.draw_date || "", c.prize_status || "NONE", c.remarks || "").run();
          }
          return jsonResp({ ok: true });
        }

        for (const rName of (body.retailers || [])) {
          if (String(rName || "").trim()) await getOrCreateRetailerId(db, rName);
        }

        for (const d of (body.deliveries || [])) {
          const rId = await getOrCreateRetailerId(db, d.retailer_name);
          await db.prepare(
            "INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(randomDlCode(), d.entry_date, rId, Number(d.bags) || 0, Number(d.loose_kg) || 0, Number(d.total_kg) || 0, String(d.remarks || "")).run();
        }

        return jsonResp({ ok: true });
      }

      return jsonResp({ error: "API route not found" }, 404);
    } catch (err) {
      return jsonResp({ error: err.message || "Internal Worker Error" }, 500);
    }
  }
};
