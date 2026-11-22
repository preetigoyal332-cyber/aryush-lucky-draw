// Cloudflare Pages Functions / Workers D1 Backend for Aryush Foods Lucky Draw ERP
// Supports: /api/bootstrap, /api/public/check, /api/settings, /api/retailers, /api/deliveries,
// /api/coupons, /api/segments, /api/media/upload-chunk, /api/media/stream, /api/media/delete, /api/verify-pin, /api/live-poll

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

function getDB(env) {
  const db = env.DB || env.D1 || env.DATABASE;
  if (!db) throw new Error('Cloudflare D1 binding (DB) not configured.');
  return db;
}

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, val TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS retailers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, area TEXT DEFAULT '', phone TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, dl_code TEXT DEFAULT '', entry_date TEXT NOT NULL, retailer_id INTEGER NOT NULL, bags REAL DEFAULT 0, loose_kg REAL DEFAULT 0, total_kg REAL NOT NULL, remarks TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, coupon_num INTEGER NOT NULL UNIQUE, coupon_code TEXT NOT NULL, retailer_id INTEGER NOT NULL, issue_date TEXT NOT NULL, prize_rank INTEGER DEFAULT 999, prize_title TEXT DEFAULT '', prize_status TEXT DEFAULT 'NONE', draw_date TEXT DEFAULT '', handover_proof TEXT DEFAULT '', handover_note TEXT DEFAULT '')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY AUTOINCREMENT, rank INTEGER NOT NULL, title TEXT NOT NULL, target_qty INTEGER NOT NULL DEFAULT 1, icon TEXT DEFAULT '🎁')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS media_chunks (media_key TEXT NOT NULL, chunk_idx INTEGER NOT NULL, mime_type TEXT DEFAULT 'video/mp4', data_b64 TEXT NOT NULL, PRIMARY KEY (media_key, chunk_idx))`)
  ]);
}

async function loadAllSettings(db, includeSecrets = false) {
  const { results } = await db.prepare(`SELECT key, val FROM settings`).all();
  const out = {};
  let hasPin = false;
  let hasGemini = false;
  for (const row of (results || [])) {
    if (row.key === 'admin_pin') {
      hasPin = Boolean(row.val && row.val !== '0000');
      if (includeSecrets) out[row.key] = row.val;
    } else if (row.key === 'gemini_api_key') {
      hasGemini = Boolean(row.val);
      if (includeSecrets) out[row.key] = row.val;
    } else {
      out[row.key] = row.val;
    }
  }
  out.pin_enabled = hasPin;
  out.gemini_key_saved = hasGemini;
  return out;
}

function padCouponCode(num, settings) {
  const maxC = Number(settings.max_coupons) || 301;
  const digits = maxC >= 1000 ? 4 : 3;
  const p = String(settings.coupon_prefix || '').trim();
  const prefix = (!p || /^\d+$/.test(p)) ? '' : p;
  return prefix + String(num).padStart(digits, '0');
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    const db = getDB(env);
    await ensureTables(db);

    // 1. STREAM VIDEO DIRECTLY FROM D1 MEDIA_CHUNKS
    if (path === '/api/media/stream' && method === 'GET') {
      const mediaKey = url.searchParams.get('key') || 'passbook_ad_video';
      const { results } = await db.prepare(
        `SELECT chunk_idx, mime_type, data_b64 FROM media_chunks WHERE media_key = ? ORDER BY chunk_idx ASC`
      ).bind(mediaKey).all();

      if (!results || !results.length) {
        return new Response('Media not found', { status: 404, headers: CORS_HEADERS });
      }
      const mimeType = results[0].mime_type || 'video/mp4';
      const fullB64 = results.map(r => r.data_b64).join('');
      const binStr = atob(fullB64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(bytes.byteLength),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=300',
          ...CORS_HEADERS
        }
      });
    }

    // 2. UPLOAD VIDEO CHUNK
    if (path === '/api/media/upload-chunk' && method === 'POST') {
      const body = await request.json();
      const mediaKey = String(body.media_key || 'passbook_ad_video');
      const idx = Number(body.chunk_idx) || 0;
      const mime = String(body.mime_type || 'video/mp4');
      const dataB64 = String(body.data_b64 || '');
      await db.prepare(
        `INSERT INTO media_chunks (media_key, chunk_idx, mime_type, data_b64) VALUES (?, ?, ?, ?)
         ON CONFLICT(media_key, chunk_idx) DO UPDATE SET mime_type = excluded.mime_type, data_b64 = excluded.data_b64`
      ).bind(mediaKey, idx, mime, dataB64).run();
      return jsonRes({ ok: true, chunk_idx: idx });
    }

    // 3. DELETE MEDIA CHUNKS
    if (path === '/api/media/delete' && method === 'POST') {
      const body = await request.json();
      const mediaKey = String(body.media_key || 'passbook_ad_video');
      await db.prepare(`DELETE FROM media_chunks WHERE media_key = ?`).bind(mediaKey).run();
      return jsonRes({ ok: true });
    }

    // 4. BOOTSTRAP (ADMIN)
    if (path === '/api/bootstrap' && method === 'GET') {
      const settings = await loadAllSettings(db, false);
      const [retRes, delRes, cupRes, segRes] = await Promise.all([
        db.prepare(`SELECT * FROM retailers ORDER BY name ASC`).all(),
        db.prepare(`SELECT * FROM deliveries ORDER BY id DESC`).all(),
        db.prepare(`SELECT id, coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status, draw_date, handover_note, CASE WHEN handover_proof != '' THEN 1 ELSE 0 END AS has_proof FROM coupons ORDER BY coupon_num ASC`).all(),
        db.prepare(`SELECT * FROM segments ORDER BY rank ASC, id ASC`).all()
      ]);
      return jsonRes({
        ok: true,
        ai_ready: Boolean(settings.gemini_key_saved),
        settings,
        retailers: retRes.results || [],
        deliveries: delRes.results || [],
        coupons: cupRes.results || [],
        segments: segRes.results || []
      });
    }

    // 5. PUBLIC RETAILER PASSBOOK CHECK (INCLUDES ALL PRODUCT PICS & VIDEO SETTINGS)
    if (path === '/api/public/check' && method === 'GET') {
      const settings = await loadAllSettings(db, false);
      const rid = Number(url.searchParams.get('id')) || 0;
      const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
      const cupKg = Math.max(1, Number(settings.kg_per_coupon) || 210);
      const bagKg = Math.max(1, Number(settings.kg_per_bag) || 30);
      const bonusEvery = Math.max(0, parseInt(settings.bonus_every_coupons ?? '7', 10));
      const bonusFree = Math.max(0, parseInt(settings.bonus_free_coupons ?? '1', 10));

      let retailers = [];
      if (rid > 0) {
        const r = await db.prepare(`SELECT * FROM retailers WHERE id = ?`).bind(rid).all();
        retailers = r.results || [];
      } else if (q) {
        const cupNum = parseInt(q.replace(/[^0-9]/g, ''), 10);
        if (cupNum > 0 && /^#?\d+$/.test(q)) {
          const r = await db.prepare(
            `SELECT DISTINCT r.* FROM retailers r JOIN coupons c ON c.retailer_id = r.id WHERE c.coupon_num = ?`
          ).bind(cupNum).all();
          retailers = r.results || [];
        }
        if (!retailers.length) {
          const r = await db.prepare(
            `SELECT * FROM retailers WHERE UPPER(name) LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 20`
          ).bind(`%${q}%`, `%${q}%`).all();
          retailers = r.results || [];
        }
      }

      const matches = [];
      for (const r of retailers) {
        const [dRes, cRes] = await Promise.all([
          db.prepare(`SELECT * FROM deliveries WHERE retailer_id = ? ORDER BY entry_date DESC, id DESC`).bind(r.id).all(),
          db.prepare(`SELECT id, coupon_num, coupon_code, issue_date, prize_rank, prize_title, prize_status FROM coupons WHERE retailer_id = ? ORDER BY coupon_num ASC`).bind(r.id).all()
        ]);
        const dels = dRes.results || [];
        const totalKg = Math.round(dels.reduce((s, d) => s + Number(d.total_kg || 0), 0) * 100) / 100;
        const baseEarned = Math.floor((totalKg + 1e-9) / cupKg);
        const bonusEarned = (bonusEvery > 0 && bonusFree > 0) ? Math.floor(baseEarned / bonusEvery) * bonusFree : 0;
        const remKg = Math.round((totalKg % cupKg) * 100) / 100;
        const needKg = Math.round((cupKg - remKg) * 100) / 100;

        matches.push({
          id: r.id,
          name: r.name,
          area: r.area,
          total_kg: totalKg,
          bags_eq: Math.round((totalKg / bagKg) * 10) / 10,
          base_earned: baseEarned,
          bonus_earned: bonusEarned,
          earned: baseEarned + bonusEarned,
          rem_kg: remKg,
          need_kg: needKg,
          pct: Math.min(100, Math.round((remKg / cupKg) * 100)),
          coupons: cRes.results || [],
          recent_deliveries: dels.slice(0, 30)
        });
      }

      return jsonRes({ ok: true, settings, matches });
    }

    // 6. SETTINGS SAVE
    if (path === '/api/settings' && method === 'POST') {
      const body = await request.json();
      const stmts = [];
      for (const [k, v] of Object.entries(body || {})) {
        stmts.push(
          db.prepare(`INSERT INTO settings (key, val) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val`)
            .bind(String(k), v === null || v === undefined ? '' : String(v))
        );
      }
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true });
    }

    // 7. VERIFY ADMIN PIN
    if (path === '/api/verify-pin' && method === 'POST') {
      const body = await request.json();
      const row = await db.prepare(`SELECT val FROM settings WHERE key = 'admin_pin'`).first();
      const saved = row?.val || '';
      const valid = !saved || saved === '0000' || String(body.pin || '') === String(saved);
      return jsonRes({ ok: true, valid });
    }

    // 8. LIVE POLL & SYNC PING
    if (path === '/api/live-poll' && method === 'GET') {
      const row = await db.prepare(`SELECT val FROM settings WHERE key = 'live_stage_cmd'`).first();
      return jsonRes({ ok: true, live_stage_cmd: row?.val || '' });
    }

    if (path === '/api/sync-ping' && method === 'GET') {
      const d = await db.prepare(`SELECT COUNT(*) AS c FROM deliveries`).first();
      const c = await db.prepare(`SELECT COUNT(*) AS c FROM coupons`).first();
      return jsonRes({ ok: true, sig: `${d?.c || 0}_${c?.c || 0}`, ts: Date.now() });
    }

    // 9. RETAILERS CRUD & MERGE
    if (path === '/api/retailers' && method === 'POST') {
      const body = await request.json();
      const name = String(body.name || '').trim().toUpperCase();
      const area = String(body.area || '').trim().toUpperCase();
      const phone = String(body.phone || '').trim();
      if (body.id) {
        await db.prepare(`UPDATE retailers SET name = ?, area = ?, phone = ? WHERE id = ?`).bind(name, area, phone, Number(body.id)).run();
      } else {
        await db.prepare(`INSERT OR IGNORE INTO retailers (name, area, phone) VALUES (?, ?, ?)`).bind(name, area, phone).run();
      }
      return jsonRes({ ok: true });
    }

    if (path === '/api/retailers/merge' && method === 'POST') {
      const body = await request.json();
      const keepId = Number(body.keep_id);
      const remId = Number(body.remove_id);
      await db.batch([
        db.prepare(`UPDATE deliveries SET retailer_id = ? WHERE retailer_id = ?`).bind(keepId, remId),
        db.prepare(`UPDATE coupons SET retailer_id = ? WHERE retailer_id = ?`).bind(keepId, remId),
        db.prepare(`DELETE FROM retailers WHERE id = ?`).bind(remId)
      ]);
      return jsonRes({ ok: true });
    }

    if (path === '/api/retailers/bulk-area' && method === 'POST') {
      const body = await request.json();
      const stmts = (body.updates || []).map(u =>
        db.prepare(`UPDATE retailers SET area = ? WHERE id = ?`).bind(String(u.area || '').trim().toUpperCase(), Number(u.id))
      );
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true });
    }

    if (path.startsWith('/api/retailers/') && method === 'DELETE') {
      const id = Number(path.split('/').pop());
      await db.batch([
        db.prepare(`DELETE FROM deliveries WHERE retailer_id = ?`).bind(id),
        db.prepare(`DELETE FROM coupons WHERE retailer_id = ?`).bind(id),
        db.prepare(`DELETE FROM retailers WHERE id = ?`).bind(id)
      ]);
      return jsonRes({ ok: true });
    }

    // 10. DELIVERIES CRUD
    if (path === '/api/deliveries' && method === 'POST') {
      const body = await request.json();
      const name = String(body.retailer_name || '').trim().toUpperCase();
      const area = String(body.area || '').trim().toUpperCase();
      let ret = await db.prepare(`SELECT * FROM retailers WHERE name = ?`).bind(name).first();
      if (!ret) {
        await db.prepare(`INSERT INTO retailers (name, area) VALUES (?, ?)`).bind(name, area).run();
        ret = await db.prepare(`SELECT * FROM retailers WHERE name = ?`).bind(name).first();
      } else if (area && !ret.area) {
        await db.prepare(`UPDATE retailers SET area = ? WHERE id = ?`).bind(area, ret.id).run();
      }

      if (body.id) {
        await db.prepare(`UPDATE deliveries SET entry_date = ?, retailer_id = ?, bags = ?, loose_kg = ?, total_kg = ?, remarks = ? WHERE id = ?`)
          .bind(body.entry_date, ret.id, Number(body.bags) || 0, Number(body.loose_kg) || 0, Number(body.total_kg), body.remarks || '', Number(body.id)).run();
      } else {
        const dlCode = 'DL-' + Math.random().toString(16).slice(2, 8).toUpperCase();
        await db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(dlCode, body.entry_date, ret.id, Number(body.bags) || 0, Number(body.loose_kg) || 0, Number(body.total_kg), body.remarks || '').run();
      }
      return jsonRes({ ok: true, retailer_id: ret.id });
    }

    if (path === '/api/deliveries/beat-bulk' && method === 'POST') {
      const body = await request.json();
      const stmts = [];
      for (const x of (body.items || [])) {
        if (Number(x.total_kg) > 0) {
          const dlCode = 'DL-' + Math.random().toString(16).slice(2, 8).toUpperCase();
          stmts.push(
            db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, 'Area Sheet')`)
              .bind(dlCode, body.entry_date, Number(x.retailer_id), Number(x.bags) || 0, Number(x.loose_kg) || 0, Number(x.total_kg))
          );
        }
      }
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true, saved: stmts.length });
    }

    if (path.startsWith('/api/deliveries/') && method === 'DELETE') {
      const id = Number(path.split('/').pop());
      await db.prepare(`DELETE FROM deliveries WHERE id = ?`).bind(id).run();
      return jsonRes({ ok: true });
    }

    // 11. COUPONS & PRIZES
    if (path === '/api/coupons/allot' && method === 'POST') {
      const body = await request.json();
      const settings = await loadAllSettings(db, false);
      const maxC = Number(settings.max_coupons) || 301;
      const issueDate = body.issue_date || new Date().toISOString().slice(0, 10);

      if (Array.isArray(body.custom_assignments)) {
        let savedCnt = 0;
        for (const item of body.custom_assignments) {
          const rid = Number(item.retailer_id);
          const nums = (item.coupon_nums || []).map(Number).filter(n => n > 0);
          if (item.replace_party_coupons) {
            const { results: curCups } = await db.prepare(`SELECT id, coupon_num, prize_status, prize_title FROM coupons WHERE retailer_id = ?`).bind(rid).all();
            const keepSet = new Set(nums);
            for (const c of (curCups || [])) {
              if (!keepSet.has(Number(c.coupon_num)) && (!c.prize_title || c.prize_status === 'NONE')) {
                await db.prepare(`DELETE FROM coupons WHERE id = ?`).bind(c.id).run();
              }
            }
          }
          for (const n of nums) {
            const ex = await db.prepare(`SELECT * FROM coupons WHERE coupon_num = ?`).bind(n).first();
            if (ex) {
              if (Number(ex.retailer_id) !== rid) {
                await db.prepare(`UPDATE coupons SET retailer_id = ?, issue_date = ? WHERE coupon_num = ?`).bind(rid, issueDate, n).run();
                savedCnt++;
              }
            } else {
              await db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date) VALUES (?, ?, ?, ?)`)
                .bind(n, padCouponCode(n, settings), rid, issueDate).run();
              savedCnt++;
            }
          }
        }
        return jsonRes({ ok: true, allotted: savedCnt });
      }

      const { results: usedRows } = await db.prepare(`SELECT coupon_num FROM coupons`).all();
      const used = new Set((usedRows || []).map(r => Number(r.coupon_num)));
      const avail = [];
      for (let i = 1; i <= maxC; i++) if (!used.has(i)) avail.push(i);
      if (body.mode === 'random') avail.sort(() => Math.random() - 0.5);

      let p = 0;
      const stmts = [];
      for (const a of (body.allocations || [])) {
        for (let k = 0; k < Number(a.count); k++) {
          if (p >= avail.length) break;
          const n = avail[p++];
          stmts.push(
            db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date) VALUES (?, ?, ?, ?)`)
              .bind(n, padCouponCode(n, settings), Number(a.retailer_id), issueDate)
          );
        }
      }
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true, allotted: p });
    }

    if (path.startsWith('/api/coupons/proof/') && method === 'GET') {
      const cid = Number(path.split('/').pop());
      const row = await db.prepare(`SELECT handover_proof, handover_note FROM coupons WHERE id = ?`).bind(cid).first();
      return jsonRes({ ok: true, handover_proof: row?.handover_proof || '', handover_note: row?.handover_note || '' });
    }

    if (path.startsWith('/api/coupons/') && method === 'DELETE') {
      const id = Number(path.split('/').pop());
      await db.prepare(`DELETE FROM coupons WHERE id = ?`).bind(id).run();
      return jsonRes({ ok: true });
    }

    if (path === '/api/coupons/prize-bulk' && method === 'POST') {
      const body = await request.json();
      if (body.mode === 'HANDOVER') {
        const stmts = (body.coupon_ids || []).map(id => {
          if (body.handover_proof !== undefined) {
            return db.prepare(`UPDATE coupons SET prize_status = ?, handover_proof = ?, handover_note = ? WHERE id = ?`)
              .bind(body.prize_status, body.handover_proof, body.handover_note || '', Number(id));
          }
          return db.prepare(`UPDATE coupons SET prize_status = ?, handover_note = COALESCE(?, handover_note) WHERE id = ?`)
            .bind(body.prize_status, body.handover_note ?? null, Number(id));
        });
        if (stmts.length) await db.batch(stmts);
        return jsonRes({ ok: true, updated: stmts.length });
      }
      const stmts = (body.coupon_nums || []).map(num =>
        db.prepare(`UPDATE coupons SET prize_title = ?, prize_rank = ?, prize_status = ?, draw_date = ? WHERE coupon_num = ?`)
          .bind(body.prize_title || '', body.prize_title ? Number(body.prize_rank) : 999, body.prize_title ? (body.prize_status || 'WON') : 'NONE', body.draw_date || '', Number(num))
      );
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true, updated: stmts.length });
    }

    // 12. SEGMENTS CRUD
    if (path === '/api/segments' && method === 'POST') {
      const body = await request.json();
      if (body.id) {
        await db.prepare(`UPDATE segments SET rank = ?, title = ?, target_qty = ?, icon = ? WHERE id = ?`)
          .bind(Number(body.rank), body.title, Number(body.target_qty), body.icon || '🎁', Number(body.id)).run();
      } else {
        await db.prepare(`INSERT INTO segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`)
          .bind(Number(body.rank), body.title, Number(body.target_qty), body.icon || '🎁').run();
      }
      return jsonRes({ ok: true });
    }

    if (path.startsWith('/api/segments/') && method === 'DELETE') {
      const id = Number(path.split('/').pop());
      await db.prepare(`DELETE FROM segments WHERE id = ?`).bind(id).run();
      return jsonRes({ ok: true });
    }

    return jsonRes({ error: 'API route not found: ' + path }, 404);
  } catch (err) {
    return jsonRes({ error: err.message || 'Server error' }, 500);
  }
}
