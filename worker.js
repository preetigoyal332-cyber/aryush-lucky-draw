// Aryush Foods — Lucky Draw Coupon & 301 Prize ERP (v2.0 Pro)
// Cloudflare Worker + D1 Backend (Auto-migrates v1 -> v2 seamlessly)

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
    db.prepare(`CREATE TABLE IF NOT EXISTS prize_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rank INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      target_qty INTEGER NOT NULL DEFAULT 1,
      icon TEXT DEFAULT '🏆',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_deliveries_retailer ON deliveries(retailer_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_coupons_retailer ON coupons(retailer_id)`)
  ]);

  // Seed default 301-prize segments if table is empty
  const segCount = await db.prepare("SELECT COUNT(*) AS cnt FROM prize_segments").first();
  if (!segCount || Number(segCount.cnt) === 0) {
    await db.batch([
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (1, '1st Mega Prize - Maruti Alto Car', 1, '🥇')"),
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (2, '2nd Prize - Two Wheeler / Fridge', 2, '🥈')"),
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (3, '3rd Prize - LED TV / Washing Machine', 5, '🥉')"),
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (4, '4th Prize - Mixer Grinder / Induction', 25, '🎁')"),
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (5, '5th Prize - Special Home Appliance', 50, '✨')"),
      db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (6, 'Assured / Consolation Gift Prize', 218, '⭐')")
    ]);
  }

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
    max_coupons: 301,
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

function guessAreaFromShopName(name) {
  const genericWords = new Set([
    "KIRANA", "STORE", "STORES", "PROVIJAN", "PROVISION", "TRADERS", "TRADER",
    "BAZAR", "BAZAAR", "BHANDAR", "GENERAL", "MART", "SHOP", "AGENCY", "AGENCIES",
    "ENTERPRISES", "BROTHERS", "BROS", "SONS", "AND", "CO", "COMPANY", "FOODS",
    "SWEETS", "DAIRY", "MEDICAL", "CENTRE", "CENTER", "COLLECTION", "HOUSE", "POINT"
  ]);
  const parts = String(name || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    const last = parts[parts.length - 1].replace(/[^A-Z]/g, "");
    if (last.length >= 3 && !genericWords.has(last)) {
      return last;
    }
  }
  return "";
}

async function getOrCreateRetailerId(db, nameRaw, areaRaw = "", phoneRaw = "") {
  const name = String(nameRaw || "").trim().toUpperCase();
  if (!name) throw new Error("Retailer name is required");
  const area = String(areaRaw || "").trim().toUpperCase();
  const phone = String(phoneRaw || "").trim();

  const existing = await db.prepare("SELECT id, area, phone FROM retailers WHERE UPPER(name) = ?").bind(name).first();
  if (existing) {
    if ((area && area !== existing.area) || (phone && phone !== existing.phone)) {
      await db.prepare(
        "UPDATE retailers SET area = COALESCE(NULLIF(?, ''), area), phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?"
      ).bind(area, phone, existing.id).run();
    }
    return existing.id;
  }
  const finalArea = area || guessAreaFromShopName(name);
  const ins = await db.prepare("INSERT INTO retailers (name, area, phone) VALUES (?, ?, ?) RETURNING id")
    .bind(name, finalArea, phone).first();
  return ins.id;
}

function randomDlCode() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return "DL-" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Parse CSV text properly with quoted strings
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cur.trim());
        cur = "";
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        if (ch === '\r') i++;
        row.push(cur.trim());
        rows.push(row);
        row = [];
        cur = "";
      } else if (ch !== '\r') {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return jsonResp({ ok: true });

    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Static assets binding missing.", { status: 404 });
    }

    if (!env.DB) {
      return jsonResp({ error: "Cloudflare D1 binding 'DB' missing in Worker Settings -> Bindings." }, 500);
    }

    try {
      await ensureSchema(env.DB);
      const db = env.DB;

      // 1. GET /api/bootstrap
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        const [settings, retailers, deliveries, coupons, segments] = await Promise.all([
          getSettingsObj(db),
          db.prepare("SELECT * FROM retailers ORDER BY name ASC").all(),
          db.prepare("SELECT * FROM deliveries ORDER BY entry_date DESC, id DESC").all(),
          db.prepare("SELECT * FROM coupons ORDER BY coupon_num ASC").all(),
          db.prepare("SELECT * FROM prize_segments ORDER BY rank ASC, id ASC").all()
        ]);
        return jsonResp({
          settings,
          retailers: retailers.results || [],
          deliveries: deliveries.results || [],
          coupons: coupons.results || [],
          segments: segments.results || []
        });
      }

      // 2. POST /api/settings
      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await request.json();
        const stmts = Object.entries(body).map(([k, v]) =>
          db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(k, String(v ?? ""))
        );
        if (stmts.length) await db.batch(stmts);
        return jsonResp({ ok: true, settings: await getSettingsObj(db) });
      }

      // 3. POST /api/retailers
      if (url.pathname === "/api/retailers" && request.method === "POST") {
        const body = await request.json();
        if (body.id) {
          await db.prepare("UPDATE retailers SET name = ?, area = ?, phone = ? WHERE id = ?")
            .bind(
              String(body.name || "").trim().toUpperCase(),
              String(body.area || "").trim().toUpperCase(),
              String(body.phone || "").trim(),
              Number(body.id)
            ).run();
          return jsonResp({ ok: true });
        }
        const id = await getOrCreateRetailerId(db, body.name, body.area || "", body.phone || "");
        const retailer = await db.prepare("SELECT * FROM retailers WHERE id = ?").bind(id).first();
        return jsonResp({ ok: true, retailer });
      }

      // 4. POST /api/retailers/bulk-area (Auto-detect or bulk assign area)
      if (url.pathname === "/api/retailers/bulk-area" && request.method === "POST") {
        const body = await request.json();
        const updates = body.updates || []; // [{ id, area }]
        const stmts = updates.map(u =>
          db.prepare("UPDATE retailers SET area = ? WHERE id = ?")
            .bind(String(u.area || "").trim().toUpperCase(), Number(u.id))
        );
        for (let i = 0; i < stmts.length; i += 80) {
          await db.batch(stmts.slice(i, i + 80));
        }
        return jsonResp({ ok: true, updated: stmts.length });
      }

      // 5. DELETE /api/retailers/:id
      if (url.pathname.startsWith("/api/retailers/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.batch([
          db.prepare("DELETE FROM coupons WHERE retailer_id = ?").bind(id),
          db.prepare("DELETE FROM deliveries WHERE retailer_id = ?").bind(id),
          db.prepare("DELETE FROM retailers WHERE id = ?").bind(id)
        ]);
        return jsonResp({ ok: true });
      }

      // 6. POST /api/deliveries
      if (url.pathname === "/api/deliveries" && request.method === "POST") {
        const body = await request.json();
        const retailerId = body.retailer_id
          ? Number(body.retailer_id)
          : await getOrCreateRetailerId(db, body.retailer_name, body.area || "", body.phone || "");

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

      // 7. DELETE /api/deliveries/:id
      if (url.pathname.startsWith("/api/deliveries/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.prepare("DELETE FROM deliveries WHERE id = ?").bind(id).run();
        return jsonResp({ ok: true });
      }

      // 8. POST /api/segments & DELETE /api/segments/:id
      if (url.pathname === "/api/segments" && request.method === "POST") {
        const body = await request.json();
        const rank = Number(body.rank) || 1;
        const title = String(body.title || "").trim();
        const target_qty = Math.max(1, Number(body.target_qty) || 1);
        const icon = String(body.icon || "🏆").trim();
        if (!title) return jsonResp({ error: "Segment prize title required" }, 400);

        if (body.id) {
          await db.prepare("UPDATE prize_segments SET rank = ?, title = ?, target_qty = ?, icon = ? WHERE id = ?")
            .bind(rank, title, target_qty, icon, Number(body.id)).run();
        } else {
          await db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)")
            .bind(rank, title, target_qty, icon).run();
        }
        return jsonResp({ ok: true });
      }

      if (url.pathname.startsWith("/api/segments/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.prepare("DELETE FROM prize_segments WHERE id = ?").bind(id).run();
        return jsonResp({ ok: true });
      }

      // 9. POST /api/coupons/allot
      if (url.pathname === "/api/coupons/allot" && request.method === "POST") {
        const body = await request.json();
        const settings = await getSettingsObj(db);
        const maxC = Number(settings.max_coupons) || 301;
        const prefix = settings.coupon_prefix || "";
        const digits = maxC >= 1000 ? 4 : 3;
        const issueDate = String(body.issue_date || new Date().toISOString().slice(0, 10));

        const existingRows = await db.prepare("SELECT coupon_num FROM coupons").all();
        const usedSet = new Set((existingRows.results || []).map(r => Number(r.coupon_num)));

        if (body.manual_coupon_num) {
          const num = Number(body.manual_coupon_num);
          if (num < 1 || num > maxC) return jsonResp({ error: `Coupon number 1 se ${maxC} ke beech hona chahiye` }, 400);
          if (usedSet.has(num)) return jsonResp({ error: `Coupon #${num} pehle se allot ho chuka hai!` }, 400);
          const code = prefix + String(num).padStart(digits, "0");
          await db.prepare(
            "INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, batch_ref) VALUES (?, ?, ?, ?, 'MANUAL')"
          ).bind(num, code, Number(body.retailer_id), issueDate).run();
          return jsonResp({ ok: true, allotted: 1 });
        }

        const allocations = body.allocations || [];
        const totalNeeded = allocations.reduce((s, a) => s + (Number(a.count) || 0), 0);
        if (totalNeeded <= 0) return jsonResp({ error: "Allot karne ke liye koi pending coupon nahi hai" }, 400);

        const available = [];
        for (let i = 1; i <= maxC; i++) {
          if (!usedSet.has(i)) available.push(i);
        }

        if (totalNeeded > available.length) {
          return jsonResp({
            error: `Pool me sirf ${available.length} coupons bache hain (Max ${maxC}), jabki ${totalNeeded} allot karne hain. Settings me Max Coupons badha sakte hain.`
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

      // 10. DELETE /api/coupons/:id
      if (url.pathname.startsWith("/api/coupons/") && request.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        await db.prepare("DELETE FROM coupons WHERE id = ?").bind(id).run();
        return jsonResp({ ok: true });
      }

      // 11. POST /api/coupons/prize (single) & POST /api/coupons/prize-bulk (segment multi-entry!)
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

      if (url.pathname === "/api/coupons/prize-bulk" && request.method === "POST") {
        const body = await request.json();
        const mode = body.mode || "LIST";
        const drawDate = String(body.draw_date || new Date().toISOString().slice(0, 10));

        if (mode === "REMAINING") {
          const title = String(body.prize_title || "").trim();
          const rank = Number(body.prize_rank) || 99;
          const status = String(body.prize_status || "WON");
          if (!title) return jsonResp({ error: "Prize title required" }, 400);
          const res = await db.prepare(
            "UPDATE coupons SET prize_title = ?, prize_rank = ?, draw_date = ?, prize_status = ? WHERE prize_status = 'NONE' OR prize_title = ''"
          ).bind(title, rank, drawDate, status).run();
          return jsonResp({ ok: true, updated: res.meta?.changes || 0 });
        }

        if (mode === "CLEAR_SEGMENT") {
          const title = String(body.prize_title || "").trim();
          const res = await db.prepare(
            "UPDATE coupons SET prize_title = '', prize_rank = 999, draw_date = '', prize_status = 'NONE' WHERE prize_title = ?"
          ).bind(title).run();
          return jsonResp({ ok: true, updated: res.meta?.changes || 0 });
        }

        if (mode === "HANDOVER") {
          const ids = body.coupon_ids || [];
          const newStatus = String(body.prize_status || "DELIVERED");
          const stmts = ids.map(id =>
            db.prepare("UPDATE coupons SET prize_status = ? WHERE id = ?").bind(newStatus, Number(id))
          );
          for (let i = 0; i < stmts.length; i += 80) {
            await db.batch(stmts.slice(i, i + 80));
          }
          return jsonResp({ ok: true, updated: stmts.length });
        }

        // Default mode === "LIST": assign prize to array of coupon_nums
        const nums = (body.coupon_nums || []).map(n => Number(n)).filter(n => n > 0);
        if (nums.length === 0) return jsonResp({ error: "Kam se kam 1 coupon number chunein" }, 400);
        const title = String(body.prize_title || "").trim();
        const rank = title ? (Number(body.prize_rank) || 99) : 999;
        const status = title ? String(body.prize_status || "WON") : "NONE";

        const stmts = nums.map(num =>
          db.prepare(
            "UPDATE coupons SET prize_title = ?, prize_rank = ?, draw_date = ?, prize_status = ? WHERE coupon_num = ?"
          ).bind(title, rank, drawDate, status, num)
        );
        for (let i = 0; i < stmts.length; i += 80) {
          await db.batch(stmts.slice(i, i + 80));
        }
        return jsonResp({ ok: true, updated: nums.length });
      }

      // 12. POST /api/import/gsheet (Downloads full .xlsx workbook from Google Sheets so merged cells NEVER break!)
      if (url.pathname === "/api/import/gsheet" && request.method === "POST") {
        const body = await request.json();
        const rawUrl = String(body.sheet_url || "").trim();
        const idMatch = rawUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || rawUrl.match(/^([a-zA-Z0-9-_]{20,})$/);
        if (!idMatch) {
          return jsonResp({ error: "Valid Google Sheet link paste karein!" }, 400);
        }
        const sheetId = idMatch[1];
        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;

        const res = await fetch(exportUrl, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const finalUrl = (res.url || "").toLowerCase();

        // Detect private sheet (redirected to Google login or HTML response)
        if (!res.ok || ct.includes("text/html") || finalUrl.includes("accounts.google.com") || finalUrl.includes("servicelogin")) {
          return jsonResp({
            authRequired: true,
            error: "Sheet abhi Private (Restricted) hai! Google Sheet me Share -> 'Anyone with the link' (Viewer) on karein, YA bagal wale '1. Excel File' tab se file seedha select kar lein."
          }, 403);
        }

        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 200) {
          return jsonResp({ error: "Sheet khali mili ya download nahi ho saki. '1. Excel File' tab use karein." }, 400);
        }

        // Check ZIP/XLSX magic header PK (0x50, 0x4b)
        const magic = new Uint8Array(buf.slice(0, 4));
        if (magic[0] !== 0x50 || magic[1] !== 0x4B) {
          return jsonResp({
            authRequired: true,
            error: "Google Sheet abhi Private hai! Share setting 'Anyone with the link' karein, ya '1. Excel File' tab se .xlsx upload karein."
          }, 403);
        }

        return jsonResp({
          ok: true,
          xlsx_base64: arrayBufferToBase64(buf)
        });
      }

      // 13. POST /api/import (Fast Batched Import for Sheet / Excel / Paste / JSON Restore)
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
          if (body.segments && body.segments.length) {
            await db.prepare("DELETE FROM prize_segments").run();
            const segStmts = body.segments.map(s =>
              db.prepare("INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)").bind(s.rank || 1, s.title, s.target_qty || 1, s.icon || "🏆")
            );
            await db.batch(segStmts);
          }
          const retStmts = (body.retailers || []).map(r =>
            db.prepare("INSERT INTO retailers (id, name, area, phone) VALUES (?, ?, ?, ?)").bind(r.id, r.name, r.area || "", r.phone || "")
          );
          for (let i = 0; i < retStmts.length; i += 80) await db.batch(retStmts.slice(i, i + 80));

          const delStmts = (body.deliveries || []).map(d =>
            db.prepare("INSERT INTO deliveries (id, dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(d.id, d.dl_code || randomDlCode(), d.entry_date, d.retailer_id, d.bags || 0, d.loose_kg || 0, d.total_kg || 0, d.remarks || "")
          );
          for (let i = 0; i < delStmts.length; i += 80) await db.batch(delStmts.slice(i, i + 80));

          const cupStmts = (body.coupons || []).map(c =>
            db.prepare("INSERT INTO coupons (id, coupon_num, coupon_code, retailer_id, issue_date, batch_ref, prize_rank, prize_title, prize_value, draw_date, prize_status, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(c.id, c.coupon_num, c.coupon_code, c.retailer_id, c.issue_date, c.batch_ref || "", c.prize_rank ?? 999, c.prize_title || "", c.prize_value || 0, c.draw_date || "", c.prize_status || "NONE", c.remarks || "")
          );
          for (let i = 0; i < cupStmts.length; i += 80) await db.batch(cupStmts.slice(i, i + 80));

          return jsonResp({ ok: true });
        }

        // Incremental Smart Import (Retailers + Deliveries + Coupons)
        const allShopNames = new Map(); // UPPER_NAME -> area
        for (const r of (body.retailers || [])) {
          if (typeof r === "string") {
            const clean = r.trim().toUpperCase();
            if (clean) allShopNames.set(clean, guessAreaFromShopName(clean));
          } else if (r && r.name) {
            const clean = String(r.name).trim().toUpperCase();
            if (clean) allShopNames.set(clean, String(r.area || guessAreaFromShopName(clean)).trim().toUpperCase());
          }
        }
        for (const d of (body.deliveries || [])) {
          const clean = String(d.retailer_name || "").trim().toUpperCase();
          if (clean && !allShopNames.has(clean)) {
            allShopNames.set(clean, String(d.area || guessAreaFromShopName(clean)).trim().toUpperCase());
          }
        }
        for (const c of (body.coupons || [])) {
          const clean = String(c.retailer_name || "").trim().toUpperCase();
          if (clean && !allShopNames.has(clean)) {
            allShopNames.set(clean, guessAreaFromShopName(clean));
          }
        }

        // Upsert retailers in batches
        const rUpserts = [];
        for (const [name, area] of allShopNames.entries()) {
          rUpserts.push(
            db.prepare(
              "INSERT INTO retailers (name, area) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET area = CASE WHEN retailers.area = '' THEN excluded.area ELSE retailers.area END"
            ).bind(name, area)
          );
        }
        for (let i = 0; i < rUpserts.length; i += 80) {
          await db.batch(rUpserts.slice(i, i + 80));
        }

        // Fetch full retailer map
        const retRows = await db.prepare("SELECT id, name FROM retailers").all();
        const retMap = new Map((retRows.results || []).map(r => [String(r.name).toUpperCase(), r.id]));

        // Insert deliveries (skip existing dl_code via ON CONFLICT DO NOTHING)
        const dStmts = [];
        for (const d of (body.deliveries || [])) {
          const rId = retMap.get(String(d.retailer_name || "").trim().toUpperCase());
          if (!rId || !(Number(d.total_kg) > 0)) continue;
          const dlCode = d.dl_code && String(d.dl_code).startsWith("DL-") ? String(d.dl_code).trim() : randomDlCode();
          dStmts.push(
            db.prepare(
              "INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dl_code) DO NOTHING"
            ).bind(dlCode, d.entry_date || new Date().toISOString().slice(0, 10), rId, Number(d.bags) || 0, Number(d.loose_kg) || 0, Number(d.total_kg) || 0, String(d.remarks || ""))
          );
        }
        for (let i = 0; i < dStmts.length; i += 80) {
          await db.batch(dStmts.slice(i, i + 80));
        }

        // Insert coupons if provided
        const settings = await getSettingsObj(db);
        const digits = (Number(settings.max_coupons) || 301) >= 1000 ? 4 : 3;
        const prefix = settings.coupon_prefix || "";
        const cStmts = [];
        for (const c of (body.coupons || [])) {
          const rId = retMap.get(String(c.retailer_name || "").trim().toUpperCase());
          const num = Number(c.coupon_num);
          if (!rId || !(num > 0)) continue;
          const code = prefix + String(num).padStart(digits, "0");
          const pTitle = String(c.prize_title || "").trim();
          cStmts.push(
            db.prepare(
              "INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, batch_ref, prize_rank, prize_title, prize_status) VALUES (?, ?, ?, ?, 'IMPORT', ?, ?, ?) ON CONFLICT(coupon_num) DO NOTHING"
            ).bind(num, code, rId, c.issue_date || new Date().toISOString().slice(0, 10), pTitle ? 10 : 999, pTitle, pTitle ? "WON" : "NONE")
          );
        }
        for (let i = 0; i < cStmts.length; i += 80) {
          await db.batch(cStmts.slice(i, i + 80));
        }

        return jsonResp({
          ok: true,
          imported_retailers: allShopNames.size,
          imported_deliveries: dStmts.length,
          imported_coupons: cStmts.length
        });
      }

      return jsonResp({ error: "API route not found" }, 404);
    } catch (err) {
      return jsonResp({ error: err.message || "Internal Worker Error" }, 500);
    }
  }
};
