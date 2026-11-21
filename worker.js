// Aryush Foods — Lucky Draw & 301 Prize ERP v6.0 AI Pro (Cloudflare Worker + D1 + Gemini AI)

const OFFICIAL_301_SEGMENTS = [
  { rank: 1, title: '1st Prize - Maruti Suzuki Alto K10 LXi', target_qty: 1, icon: '🚗' },
  { rank: 2, title: '2nd Prize - Honda Activa', target_qty: 2, icon: '🛵' },
  { rank: 3, title: '3rd Prize - Hero HF Deluxe Bike', target_qty: 2, icon: '🏍️' },
  { rank: 4, title: '4th Prize - Chandi (Silver) 200g', target_qty: 2, icon: '🥈' },
  { rank: 5, title: '5th Prize - Chandi (Silver) 100g', target_qty: 5, icon: '🪙' },
  { rank: 6, title: '6th Prize - Lloyd Refrigerator (180L)', target_qty: 10, icon: '🧊' },
  { rank: 7, title: '7th Prize - Chandi (Silver) 50g', target_qty: 11, icon: '🪙' },
  { rank: 8, title: '8th Prize - Voltas Washing Machine (6 kg)', target_qty: 21, icon: '🧺' },
  { rank: 9, title: '9th Prize - Chandi (Silver) 30g', target_qty: 25, icon: '✨' },
  { rank: 10, title: '10th Prize - Chandi (Silver) 25g', target_qty: 30, icon: '✨' },
  { rank: 11, title: '11th Prize - Chandi (Silver) 20g', target_qty: 40, icon: '✨' },
  { rank: 12, title: '12th Prize - Rasoi Dhan Haldi Powder (25 kg)', target_qty: 51, icon: '🟡' },
  { rank: 13, title: '13th Prize - Rasoi Dhan Dhaniya Powder (30 kg)', target_qty: 101, icon: '🟢' }
];

const DEFAULT_SETTINGS = {
  company_name: 'ARYUSH FOODS',
  campaign_name: 'MEGA ALTO LUCKY DRAW',
  kg_per_coupon: '210',
  kg_per_bag: '30',
  max_coupons: '301',
  coupon_prefix: '',
  signatory: 'For Aryush Foods (Kailaras, Morena)',
  auto_allot_coupons: '0',
  brand_tagline: 'Aryush Rasoi Dhan • Pure Kacchi Ghani Mustard Oil & Spices',
  brand_logo_data: ''
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function guessArea(name) {
  const generic = new Set([
    'KIRANA','STORE','STORES','PROVIJAN','PROVISION','TRADERS','TRADER','BAZAR','BAZAAR',
    'BHANDAR','GENERAL','MART','SHOP','AGENCY','AGENCIES','ENTERPRISES','BROTHERS','BROS',
    'SONS','AND','CO','COMPANY','FOODS','SWEETS','DAIRY','MEDICAL','CENTRE','CENTER'
  ]);
  const parts = String(name || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    const last = parts[parts.length - 1].replace(/[^A-Z]/g, '');
    if (last.length >= 3 && !generic.has(last)) return last;
  }
  return '';
}

function randomDlCode() {
  return 'DL-' + Math.random().toString(16).slice(2, 8).toUpperCase();
}

function sanitizePrefix(prefix) {
  const p = String(prefix || '').trim();
  // Never allow purely numeric prefix like '1' which turns coupon 01 into 1001!
  if (!p || /^\d+$/.test(p)) return '';
  return p;
}

function padCoupon(num, maxC = 301, prefix = '') {
  const digits = Number(maxC) >= 1000 ? 4 : 3;
  return sanitizePrefix(prefix) + String(num).padStart(digits, '0');
}

async function ensureSchemaAndDefaults(db) {
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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE CASCADE
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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS prize_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rank INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      target_qty INTEGER NOT NULL DEFAULT 1,
      icon TEXT DEFAULT '🏆',
      created_at TEXT DEFAULT (datetime('now'))
    )`)
  ]);

  try { await db.prepare(`ALTER TABLE coupons ADD COLUMN handover_proof TEXT DEFAULT ''`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE coupons ADD COLUMN handover_note TEXT DEFAULT ''`).run(); } catch (e) {}

  const segCountRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM prize_segments`).first();
  if (!segCountRow || Number(segCountRow.cnt) === 0) {
    const stmts = OFFICIAL_301_SEGMENTS.map(s =>
      db.prepare(`INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`)
        .bind(s.rank, s.title, s.target_qty, s.icon)
    );
    await db.batch(stmts);
  }
}

async function getSettingsMap(db) {
  const rows = await db.prepare(`SELECT key, value FROM settings`).all();
  const map = { ...DEFAULT_SETTINGS };
  for (const r of (rows.results || [])) {
    map[r.key] = r.value;
  }
  const rawPref = String(map.coupon_prefix || '').trim();
  if (/^\d+$/.test(rawPref)) {
    map.coupon_prefix = '';
    try {
      await db.prepare(`UPDATE settings SET value = '' WHERE key = 'coupon_prefix'`).run();
      const maxC = Number(map.max_coupons) || 301;
      const allCups = await db.prepare(`SELECT id, coupon_num, coupon_code FROM coupons`).all();
      const fixStmts = [];
      for (const c of (allCups.results || [])) {
        const cleanCode = padCoupon(c.coupon_num, maxC, '');
        if (c.coupon_code !== cleanCode && String(c.coupon_code) === rawPref + cleanCode) {
          fixStmts.push(db.prepare(`UPDATE coupons SET coupon_code = ? WHERE id = ?`).bind(cleanCode, c.id));
        }
      }
      if (fixStmts.length) await db.batch(fixStmts);
    } catch (e) {}
  }
  return {
    ...map,
    coupon_prefix: sanitizePrefix(map.coupon_prefix),
    kg_per_coupon: Number(map.kg_per_coupon) || 210,
    kg_per_bag: Number(map.kg_per_bag) || 30,
    max_coupons: Number(map.max_coupons) || 301,
    auto_allot_coupons: String(map.auto_allot_coupons) === '1' || map.auto_allot_coupons === true,
    pin_enabled: Boolean(map.admin_pin && String(map.admin_pin).trim().length >= 4),
    gemini_key_saved: Boolean(map.gemini_api_key && String(map.gemini_api_key).trim().length > 10)
  };
}

async function autoAllotPendingForRetailer(db, retailerId, issueDate, settings) {
  const kgPerCup = Math.max(1, Number(settings.kg_per_coupon) || 210);
  const maxC = Number(settings.max_coupons) || 301;
  const prefix = settings.coupon_prefix || '';
  const totRow = await db.prepare(`SELECT COALESCE(SUM(total_kg), 0) AS tot FROM deliveries WHERE retailer_id = ?`).bind(retailerId).first();
  const issuedRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM coupons WHERE retailer_id = ?`).bind(retailerId).first();
  const pending = Math.max(0, Math.floor(((Number(totRow?.tot) || 0) + 1e-9) / kgPerCup) - (Number(issuedRow?.cnt) || 0));
  if (pending <= 0) return [];

  const usedRows = await db.prepare(`SELECT coupon_num FROM coupons`).all();
  const used = new Set((usedRows.results || []).map(x => Number(x.coupon_num)));
  const avail = [];
  for (let i = 1; i <= maxC && avail.length < pending; i++) if (!used.has(i)) avail.push(i);
  if (!avail.length) return [];

  const codes = [];
  await db.batch(avail.map(n => {
    const code = padCoupon(n, maxC, prefix);
    codes.push(code);
    return db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status) VALUES (?, ?, ?, ?, 999, '', 'NONE')`)
      .bind(n, code, retailerId, issueDate);
  }));
  return codes;
}

async function getGeminiKey(env, db) {
  if (env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim().length > 10) {
    return String(env.GEMINI_API_KEY).trim();
  }
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'gemini_api_key'`).first();
  if (row && row.value && String(row.value).trim().length > 10) {
    return String(row.value).trim();
  }
  return '';
}

async function callGeminiAPI(apiKey, parts, expectJson = true) {
  if (!apiKey) {
    throw new Error('Gemini API Key set nahi hai! Settings (PDF/Tools tab) me apni free Google AI Studio Gemini API Key save karein ya Cloudflare secret GEMINI_API_KEY lagayein.');
  }
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastErr = 'Gemini request failed';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload = {
      contents: [{ role: 'user', parts }],
      generationConfig: expectJson
        ? { temperature: 0.15, responseMimeType: 'application/json' }
        : { temperature: 0.3 }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const txt = data.candidates[0].content.parts[0].text.trim();
      if (!expectJson) return txt;
      const cleaned = txt.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      return JSON.parse(cleaned);
    }
    lastErr = data?.error?.message || `HTTP ${res.status}`;
  }
  throw new Error(lastErr);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return jsonResp({ ok: true });

    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    const db = env.DB;
    if (!db) return jsonResp({ error: 'Cloudflare D1 binding DB missing in wrangler.toml' }, 500);

    try {
      await ensureSchemaAndDefaults(db);

      // 0. PUBLIC READ-ONLY RETAILER KHATA & PRIZE CHECK PORTAL
      if (path === '/api/public/check' && request.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        const settings = await getSettingsMap(db);
        const pubSettings = {
          company_name: settings.company_name,
          campaign_name: settings.campaign_name,
          kg_per_coupon: settings.kg_per_coupon,
          kg_per_bag: settings.kg_per_bag,
          max_coupons: settings.max_coupons,
          signatory: settings.signatory,
          brand_tagline: settings.brand_tagline || 'Aryush Rasoi Dhan • Pure Kacchi Ghani Mustard Oil & Spices',
          brand_logo_data: settings.brand_logo_data || ''
        };
        if (!q) return jsonResp({ ok: true, settings: pubSettings, matches: [] });

        const qUpper = q.toUpperCase();
        const qNum = parseInt(q.replace(/[^0-9]/g, ''), 10);
        const [retRes, delRes, cupRes] = await Promise.all([
          db.prepare(`SELECT id, name, area, phone FROM retailers ORDER BY name ASC`).all(),
          db.prepare(`SELECT id, entry_date, retailer_id, bags, loose_kg, total_kg FROM deliveries ORDER BY entry_date DESC, id DESC`).all(),
          db.prepare(`SELECT coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status FROM coupons ORDER BY coupon_num ASC`).all()
        ]);

        const matchedIds = new Set();
        for (const r of (retRes.results || [])) {
          const ph = String(r.phone || '').replace(/[^0-9]/g, '');
          const qDigits = q.replace(/[^0-9]/g, '');
          if (r.name.toUpperCase().includes(qUpper) || (qDigits.length >= 6 && ph.includes(qDigits))) matchedIds.add(r.id);
        }
        for (const c of (cupRes.results || [])) {
          if (c.coupon_code.toUpperCase() === qUpper || (qNum > 0 && q.length <= 4 && Number(c.coupon_num) === qNum)) matchedIds.add(c.retailer_id);
        }

        const kgPerCup = Math.max(1, Number(settings.kg_per_coupon) || 210);
        const kgPerBag = Math.max(1, Number(settings.kg_per_bag) || 30);
        const matches = (retRes.results || []).filter(r => matchedIds.has(r.id)).slice(0, 15).map(r => {
          const dels = (delRes.results || []).filter(d => d.retailer_id === r.id);
          const cups = (cupRes.results || []).filter(c => c.retailer_id === r.id);
          const total_kg = Math.round(dels.reduce((s, d) => s + (Number(d.total_kg) || 0), 0) * 100) / 100;
          const rem_kg = Math.round((total_kg % kgPerCup) * 100) / 100;
          return {
            name: r.name,
            area: r.area,
            total_kg,
            bags_eq: Math.round((total_kg / kgPerBag) * 10) / 10,
            earned: Math.floor((total_kg + 1e-9) / kgPerCup),
            need_kg: Math.round((kgPerCup - rem_kg) * 100) / 100,
            coupons: cups,
            recent_deliveries: dels.slice(0, 20)
          };
        });
        return jsonResp({ ok: true, settings: pubSettings, matches });
      }

      if (path === '/api/verify-pin' && request.method === 'POST') {
        const { pin } = await request.json();
        const row = await db.prepare(`SELECT value FROM settings WHERE key = 'admin_pin'`).first();
        const saved = row?.value ? String(row.value).trim() : '';
        return jsonResp({ ok: true, valid: !saved || String(pin || '').trim() === saved });
      }

      if (path.startsWith('/api/coupons/proof/') && request.method === 'GET') {
        const cid = Number(path.split('/').pop());
        const row = await db.prepare(`SELECT handover_proof, handover_note FROM coupons WHERE id = ?`).bind(cid).first();
        return jsonResp({ ok: true, handover_proof: row?.handover_proof || '', handover_note: row?.handover_note || '' });
      }

      // 1. BOOTSTRAP ALL DATA
      if (path === '/api/bootstrap' && request.method === 'GET') {
        const settings = await getSettingsMap(db);
        const safeSettings = { ...settings };
        delete safeSettings.gemini_api_key;
        delete safeSettings.admin_pin;

        const [retRes, delRes, cupRes, segRes] = await Promise.all([
          db.prepare(`SELECT * FROM retailers ORDER BY name ASC`).all(),
          db.prepare(`SELECT * FROM deliveries ORDER BY id DESC`).all(),
          db.prepare(`SELECT id, coupon_num, coupon_code, retailer_id, issue_date, batch_ref, prize_rank, prize_title, prize_value, draw_date, prize_status, handover_note, CASE WHEN handover_proof != '' AND handover_proof IS NOT NULL THEN 1 ELSE 0 END AS has_proof FROM coupons ORDER BY coupon_num ASC`).all(),
          db.prepare(`SELECT * FROM prize_segments ORDER BY rank ASC, id ASC`).all()
        ]);

        return jsonResp({
          settings: safeSettings,
          ai_ready: Boolean(env.GEMINI_API_KEY || settings.gemini_key_saved),
          retailers: retRes.results || [],
          deliveries: delRes.results || [],
          coupons: cupRes.results || [],
          segments: segRes.results || []
        });
      }

      // 2. SAVE SETTINGS (including optional gemini_api_key)
      if (path === '/api/settings' && request.method === 'POST') {
        const body = await request.json();
        const allowedKeys = [
          'company_name', 'campaign_name', 'kg_per_coupon', 'kg_per_bag',
          'max_coupons', 'coupon_prefix', 'signatory', 'gemini_api_key',
          'admin_pin', 'auto_allot_coupons', 'brand_tagline', 'brand_logo_data'
        ];
        const stmts = [];
        for (const k of allowedKeys) {
          if (body[k] !== undefined && body[k] !== null) {
            if (k === 'gemini_api_key' && String(body[k]).trim() === '') continue;
            if (k === 'admin_pin' && String(body[k]).trim() === '') continue;
            let val = String(body[k]).trim();
            if (k === 'coupon_prefix') val = sanitizePrefix(val);
            if (k === 'admin_pin' && val === '0000') val = '';
            if (k === 'auto_allot_coupons') val = (body[k] === '1' || body[k] === 1 || body[k] === true) ? '1' : '0';
            stmts.push(
              db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
                .bind(k, val)
            );
          }
        }
        if (stmts.length) await db.batch(stmts);
        const updated = await getSettingsMap(db);
        delete updated.gemini_api_key;
        delete updated.admin_pin;
        return jsonResp({ ok: true, settings: updated });
      }

      // 3. RETAILERS ADD / UPDATE / BULK AREA / DELETE / MERGE DUPLICATES
      if (path === '/api/retailers' && request.method === 'POST') {
        const body = await request.json();
        const name = String(body.name || '').trim().toUpperCase();
        const area = String(body.area || guessArea(name)).trim().toUpperCase();
        const phone = String(body.phone || '').trim();
        if (!name) return jsonResp({ error: 'Party name required' }, 400);

        if (body.id) {
          await db.prepare(`UPDATE retailers SET name = ?, area = ?, phone = ? WHERE id = ?`)
            .bind(name, area, phone, Number(body.id)).run();
        } else {
          await db.prepare(`INSERT INTO retailers (name, area, phone) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              area = CASE WHEN excluded.area != '' THEN excluded.area ELSE retailers.area END,
              phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE retailers.phone END`)
            .bind(name, area, phone).run();
        }
        return jsonResp({ ok: true });
      }

      if (path === '/api/retailers/bulk-area' && request.method === 'POST') {
        const body = await request.json();
        const updates = body.updates || [];
        const stmts = updates.map(u =>
          db.prepare(`UPDATE retailers SET area = ? WHERE id = ?`)
            .bind(String(u.area || '').trim().toUpperCase(), Number(u.id))
        );
        if (stmts.length) await db.batch(stmts);
        return jsonResp({ ok: true });
      }

      if (path === '/api/retailers/merge' && request.method === 'POST') {
        const { keep_id, remove_id } = await request.json();
        if (!keep_id || !remove_id || Number(keep_id) === Number(remove_id)) {
          return jsonResp({ error: 'Valid keep_id and remove_id required' }, 400);
        }
        await db.batch([
          db.prepare(`UPDATE deliveries SET retailer_id = ? WHERE retailer_id = ?`).bind(Number(keep_id), Number(remove_id)),
          db.prepare(`UPDATE coupons SET retailer_id = ? WHERE retailer_id = ?`).bind(Number(keep_id), Number(remove_id)),
          db.prepare(`DELETE FROM retailers WHERE id = ?`).bind(Number(remove_id))
        ]);
        return jsonResp({ ok: true });
      }

      if (path.startsWith('/api/retailers/') && request.method === 'DELETE') {
        const id = Number(path.split('/').pop());
        await db.batch([
          db.prepare(`DELETE FROM deliveries WHERE retailer_id = ?`).bind(id),
          db.prepare(`DELETE FROM coupons WHERE retailer_id = ?`).bind(id),
          db.prepare(`DELETE FROM retailers WHERE id = ?`).bind(id)
        ]);
        return jsonResp({ ok: true });
      }

      // 4. DELIVERIES ADD / EDIT / DELETE
      if (path === '/api/deliveries' && request.method === 'POST') {
        const body = await request.json();
        const nm = String(body.retailer_name || '').trim().toUpperCase();
        const area = String(body.area || guessArea(nm)).trim().toUpperCase();
        const total_kg = Number(body.total_kg) || 0;
        const bags = Number(body.bags) || 0;
        const loose_kg = Number(body.loose_kg) || 0;
        const entry_date = String(body.entry_date || new Date().toISOString().slice(0, 10));
        const remarks = String(body.remarks || '').trim();

        if (!nm || total_kg <= 0) return jsonResp({ error: 'Party name and valid KG required' }, 400);

        await db.prepare(`INSERT INTO retailers (name, area) VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET area = CASE WHEN retailers.area = '' AND excluded.area != '' THEN excluded.area ELSE retailers.area END`)
          .bind(nm, area).run();

        const ret = await db.prepare(`SELECT id FROM retailers WHERE name = ?`).bind(nm).first();
        if (!ret) return jsonResp({ error: 'Could not resolve retailer' }, 500);

        if (body.id) {
          await db.prepare(`UPDATE deliveries SET entry_date = ?, retailer_id = ?, bags = ?, loose_kg = ?, total_kg = ?, remarks = ? WHERE id = ?`)
            .bind(entry_date, ret.id, bags, loose_kg, total_kg, remarks, Number(body.id)).run();
        } else {
          await db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(randomDlCode(), entry_date, ret.id, bags, loose_kg, total_kg, remarks).run();
        }
        const settings = await getSettingsMap(db);
        let auto_codes = [];
        if (settings.auto_allot_coupons) {
          auto_codes = await autoAllotPendingForRetailer(db, ret.id, entry_date, settings);
        }
        return jsonResp({ ok: true, retailer_id: ret.id, auto_codes });
      }

      if (path === '/api/deliveries/beat-bulk' && request.method === 'POST') {
        const body = await request.json();
        const entry_date = String(body.entry_date || new Date().toISOString().slice(0, 10));
        const items = (body.items || []).filter(x => Number(x.retailer_id) > 0 && Number(x.total_kg) > 0);
        if (!items.length) return jsonResp({ error: 'Kam se kam 1 party ke bags dalein!' }, 400);
        await db.batch(items.map(x =>
          db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(randomDlCode(), entry_date, Number(x.retailer_id), Number(x.bags) || 0, Number(x.loose_kg) || 0, Number(x.total_kg) || 0, String(x.remarks || 'Area Sheet'))
        ));
        const settings = await getSettingsMap(db);
        let auto_allotted = 0;
        if (settings.auto_allot_coupons) {
          for (const x of items) {
            const c = await autoAllotPendingForRetailer(db, Number(x.retailer_id), entry_date, settings);
            auto_allotted += c.length;
          }
        }
        return jsonResp({ ok: true, saved: items.length, auto_allotted });
      }

      if (path.startsWith('/api/deliveries/') && request.method === 'DELETE') {
        const id = Number(path.split('/').pop());
        await db.prepare(`DELETE FROM deliveries WHERE id = ?`).bind(id).run();
        return jsonResp({ ok: true });
      }

      // 5. SEGMENTS
      if (path === '/api/segments/reset-official' && request.method === 'POST') {
        await db.prepare(`DELETE FROM prize_segments`).run();
        const stmts = OFFICIAL_301_SEGMENTS.map(s =>
          db.prepare(`INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`)
            .bind(s.rank, s.title, s.target_qty, s.icon)
        );
        await db.batch(stmts);
        return jsonResp({ ok: true });
      }

      if (path === '/api/segments' && request.method === 'POST') {
        const body = await request.json();
        const rank = Number(body.rank) || 1;
        const title = String(body.title || '').trim();
        const target_qty = Number(body.target_qty) || 1;
        const icon = String(body.icon || '🎁').trim();
        if (!title) return jsonResp({ error: 'Segment title required' }, 400);

        if (body.id) {
          await db.prepare(`UPDATE prize_segments SET rank = ?, title = ?, target_qty = ?, icon = ? WHERE id = ?`)
            .bind(rank, title, target_qty, icon, Number(body.id)).run();
        } else {
          await db.prepare(`INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`)
            .bind(rank, title, target_qty, icon).run();
        }
        return jsonResp({ ok: true });
      }

      if (path.startsWith('/api/segments/') && request.method === 'DELETE') {
        const id = Number(path.split('/').pop());
        await db.prepare(`DELETE FROM prize_segments WHERE id = ?`).bind(id).run();
        return jsonResp({ ok: true });
      }

      // 6. COUPONS ALLOT / REVOKE / BULK PRIZE
      if (path === '/api/coupons/allot' && request.method === 'POST') {
        const body = await request.json();
        const settings = await getSettingsMap(db);
        const maxC = Number(settings.max_coupons) || 301;
        const prefix = settings.coupon_prefix || '';
        const issue_date = String(body.issue_date || new Date().toISOString().slice(0, 10));

        const existingRows = await db.prepare(`SELECT coupon_num FROM coupons`).all();
        const used = new Set((existingRows.results || []).map(x => Number(x.coupon_num)));

        if (body.manual_coupon_num) {
          const n = Number(body.manual_coupon_num);
          if (n < 1 || n > maxC) return jsonResp({ error: `Coupon # must be between 1 and ${maxC}` }, 400);
          if (used.has(n)) return jsonResp({ error: `Coupon #${padCoupon(n, maxC, prefix)} is already allotted!` }, 400);
          await db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status) VALUES (?, ?, ?, ?, 999, '', 'NONE')`)
            .bind(n, padCoupon(n, maxC, prefix), Number(body.retailer_id), issue_date).run();
          return jsonResp({ ok: true, allotted: 1 });
        }

        const avail = [];
        for (let i = 1; i <= maxC; i++) if (!used.has(i)) avail.push(i);
        if (body.mode === 'random') {
          for (let i = avail.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [avail[i], avail[j]] = [avail[j], avail[i]];
          }
        }

        const stmts = [];
        let p = 0;
        for (const a of (body.allocations || [])) {
          const cnt = Number(a.count) || 0;
          for (let k = 0; k < cnt; k++) {
            if (p >= avail.length) break;
            const n = avail[p++];
            stmts.push(
              db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status) VALUES (?, ?, ?, ?, 999, '', 'NONE')`)
                .bind(n, padCoupon(n, maxC, prefix), Number(a.retailer_id), issue_date)
            );
          }
        }
        if (stmts.length) await db.batch(stmts);
        return jsonResp({ ok: true, allotted: stmts.length });
      }

      if (path.startsWith('/api/coupons/') && request.method === 'DELETE') {
        const id = Number(path.split('/').pop());
        await db.prepare(`DELETE FROM coupons WHERE id = ?`).bind(id).run();
        return jsonResp({ ok: true });
      }

      if (path === '/api/coupons/prize-bulk' && request.method === 'POST') {
        const body = await request.json();
        const draw_date = String(body.draw_date || new Date().toISOString().slice(0, 10));

        if (body.mode === 'REMAINING') {
          const res = await db.prepare(`UPDATE coupons SET prize_rank = ?, prize_title = ?, prize_status = ?, draw_date = ? WHERE prize_title = '' OR prize_status = 'NONE'`)
            .bind(Number(body.prize_rank) || 999, String(body.prize_title || ''), String(body.prize_status || 'WON'), draw_date).run();
          return jsonResp({ ok: true, updated: res.meta?.changes || 0 });
        }

        if (body.mode === 'HANDOVER') {
          const ids = (body.coupon_ids || []).map(Number).filter(Boolean);
          const proof = body.handover_proof !== undefined ? String(body.handover_proof) : null;
          const note = body.handover_note !== undefined ? String(body.handover_note) : null;
          const stmts = ids.map(id => {
            if (proof !== null || note !== null) {
              return db.prepare(`UPDATE coupons SET prize_status = ?, handover_proof = COALESCE(?, handover_proof), handover_note = COALESCE(?, handover_note) WHERE id = ?`)
                .bind(String(body.prize_status || 'DELIVERED'), proof, note, id);
            }
            return db.prepare(`UPDATE coupons SET prize_status = ? WHERE id = ?`).bind(String(body.prize_status || 'DELIVERED'), id);
          });
          if (stmts.length) await db.batch(stmts);
          return jsonResp({ ok: true, updated: stmts.length });
        }

        const nums = (body.coupon_nums || []).map(Number).filter(Boolean);
        const title = String(body.prize_title || '').trim();
        const rank = title ? (Number(body.prize_rank) || 999) : 999;
        const status = title ? String(body.prize_status || 'WON') : 'NONE';
        const stmts = nums.map(n =>
          db.prepare(`UPDATE coupons SET prize_rank = ?, prize_title = ?, prize_status = ?, draw_date = ? WHERE coupon_num = ?`)
            .bind(rank, title, status, title ? draw_date : '', n)
        );
        if (stmts.length) await db.batch(stmts);
        return jsonResp({ ok: true, updated: stmts.length });
      }

      // 7. IMPORT FROM GOOGLE SHEET URL OR BULK PAYLOAD
      if (path === '/api/import/gsheet' && request.method === 'POST') {
        const { sheet_url } = await request.json();
        const m = String(sheet_url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (!m) return jsonResp({ error: 'Invalid Google Sheet URL' }, 400);
        const exportUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`;
        const resp = await fetch(exportUrl);
        if (!resp.ok) return jsonResp({ error: 'Sheet private hai. Share -> Anyone with the link (Viewer) karein ya Excel download karke upload karein.' }, 400);
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return jsonResp({ ok: true, xlsx_base64: btoa(binary) });
      }

      if (path === '/api/import' && request.method === 'POST') {
        const body = await request.json();
        const settings = await getSettingsMap(db);
        const maxC = Number(settings.max_coupons) || 301;
        const prefix = settings.coupon_prefix || '';

        if (body.full_restore) {
          await db.batch([
            db.prepare(`DELETE FROM deliveries`),
            db.prepare(`DELETE FROM coupons`),
            db.prepare(`DELETE FROM retailers`),
            db.prepare(`DELETE FROM prize_segments`)
          ]);
          if (body.segments?.length) {
            await db.batch(body.segments.map(s =>
              db.prepare(`INSERT INTO prize_segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`)
                .bind(s.rank, s.title, s.target_qty, s.icon || '🎁')
            ));
          }
          for (const r of (body.retailers || [])) {
            await db.prepare(`INSERT INTO retailers (id, name, area, phone) VALUES (?, ?, ?, ?)`)
              .bind(r.id, String(r.name).toUpperCase(), String(r.area || '').toUpperCase(), String(r.phone || '')).run();
          }
          for (const d of (body.deliveries || [])) {
            await db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .bind(d.dl_code || randomDlCode(), d.entry_date, d.retailer_id, d.bags || 0, d.loose_kg || 0, d.total_kg || 0, d.remarks || '').run();
          }
          for (const c of (body.coupons || [])) {
            await db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status, draw_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(c.coupon_num, c.coupon_code || padCoupon(c.coupon_num, maxC, prefix), c.retailer_id, c.issue_date || '', c.prize_rank || 999, c.prize_title || '', c.prize_status || 'NONE', c.draw_date || '').run();
          }
          return jsonResp({ ok: true });
        }

        for (const r of (body.retailers || [])) {
          const nm = String(typeof r === 'string' ? r : r.name || '').trim().toUpperCase();
          if (!nm) continue;
          const ar = String(r.area || guessArea(nm)).trim().toUpperCase();
          const ph = String(r.phone || '').trim();
          await db.prepare(`INSERT INTO retailers (name, area, phone) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              area = CASE WHEN retailers.area = '' AND excluded.area != '' THEN excluded.area ELSE retailers.area END,
              phone = CASE WHEN retailers.phone = '' AND excluded.phone != '' THEN excluded.phone ELSE retailers.phone END`)
            .bind(nm, ar, ph).run();
        }

        const allRets = await db.prepare(`SELECT id, name FROM retailers`).all();
        const rByName = new Map((allRets.results || []).map(x => [x.name.toUpperCase(), x.id]));

        for (const d of (body.deliveries || [])) {
          const nm = String(d.retailer_name || '').trim().toUpperCase();
          if (!nm || !(Number(d.total_kg) > 0)) continue;
          let rid = rByName.get(nm);
          if (!rid) {
            await db.prepare(`INSERT OR IGNORE INTO retailers (name, area) VALUES (?, ?)`).bind(nm, guessArea(nm)).run();
            const nr = await db.prepare(`SELECT id FROM retailers WHERE name = ?`).bind(nm).first();
            rid = nr?.id;
            if (rid) rByName.set(nm, rid);
          }
          if (rid) {
            await db.prepare(`INSERT OR IGNORE INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .bind(d.dl_code || randomDlCode(), d.entry_date || new Date().toISOString().slice(0, 10), rid, Number(d.bags) || 0, Number(d.loose_kg) || 0, Number(d.total_kg) || 0, String(d.remarks || '')).run();
          }
        }

        for (const c of (body.coupons || [])) {
          const nm = String(c.retailer_name || '').trim().toUpperCase();
          const num = Number(c.coupon_num);
          const rid = rByName.get(nm);
          if (rid && num >= 1) {
            const pTitle = String(c.prize_title || '').trim();
            await db.prepare(`INSERT OR IGNORE INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .bind(num, padCoupon(num, maxC, prefix), rid, c.issue_date || new Date().toISOString().slice(0, 10), 999, pTitle, pTitle ? 'WON' : 'NONE').run();
          }
        }
        return jsonResp({ ok: true });
      }

      // ==================== GEMINI AI ENDPOINTS ====================

      // AI 1: VOICE COMMAND PARSER (Delivery Entry OR Bulk Prize Numbers)
      if (path === '/api/ai/parse-voice' && request.method === 'POST') {
        const { transcript, context_mode, retailer_names, bag_kg, today } = await request.json();
        const apiKey = await getGeminiKey(env, db);

        if (context_mode === 'PRIZES') {
          const parsed = await callGeminiAPI(apiKey, [{
            text: `Extract all winning coupon numbers spoken in this Hindi/Hinglish voice transcript: "${transcript}".
Return strict JSON: {"coupon_nums": [number, ...], "segment_hint": "optional prize keyword mentioned"}`
          }], true);
          return jsonResp({ ok: true, ...parsed });
        }

        const prompt = `You are a smart Hindi/Hinglish ERP data-entry parser for Aryush Foods (1 Bag = ${bag_kg || 30} kg).
Today's date is ${today || new Date().toISOString().slice(0, 10)}.
Existing retailer names list: ${JSON.stringify((retailer_names || []).slice(0, 350))}.

Spoken Hindi/Hinglish text: "${transcript}"

Match the spoken shop name to the closest existing retailer name if it clearly refers to one; otherwise return the clean uppercase shop name and village/area.
Calculate bags, loose_kg, and total_kg accurately (e.g., "7 bori" or "7 bag" = 7 bags, 210 total_kg; "5 bag aur 15 kilo" = 5 bags, 15 loose_kg, 165 total_kg).
Return strict JSON:
{
  "retailer_name": "UPPERCASE SHOP NAME",
  "matched_existing": true,
  "area": "UPPERCASE AREA OR EMPTY",
  "bags": 0,
  "loose_kg": 0,
  "total_kg": 0,
  "entry_date": "YYYY-MM-DD",
  "remarks": "bill no or note if spoken"
}`;
        const parsed = await callGeminiAPI(apiKey, [{ text: prompt }], true);
        return jsonResp({ ok: true, ...parsed });
      }

      // AI 2: CAMERA BILL / KANTA PARCHI SCANNER (Single or Multi-Row)
      if (path === '/api/ai/scan-bill' && request.method === 'POST') {
        const { image_base64, mime_type, retailer_names, bag_kg, today } = await request.json();
        const apiKey = await getGeminiKey(env, db);

        const prompt = `You are an expert OCR & handwritten Hindi/English bill scanner for Aryush Foods (1 Bag = ${bag_kg || 30} kg).
Default date if not visible on bill: ${today || new Date().toISOString().slice(0, 10)}.
Existing retailers list for exact name matching: ${JSON.stringify((retailer_names || []).slice(0, 300))}.

Read the uploaded bill / parchi / register page carefully. Extract ALL party delivery entries visible.
If bags/bori/katta are written without kg, multiply by ${bag_kg || 30} to get total_kg. If kg is written directly, compute bags = floor(total_kg / ${bag_kg || 30}) and loose_kg = remainder.
Match each shop name to the closest existing retailer name when applicable.
Return strict JSON:
{
  "entries": [
    {
      "entry_date": "YYYY-MM-DD",
      "retailer_name": "UPPERCASE SHOP NAME",
      "area": "UPPERCASE AREA",
      "bags": 0,
      "loose_kg": 0,
      "total_kg": 0,
      "remarks": "Bill No if visible"
    }
  ]
}`;
        const parsed = await callGeminiAPI(apiKey, [
          { text: prompt },
          { inlineData: { mimeType: mime_type || 'image/jpeg', data: image_base64 } }
        ], true);
        return jsonResp({ ok: true, entries: parsed.entries || [] });
      }

      // AI 3: STAGE DRAW PARCHI PHOTO READER (51 / 101 Coupon Numbers in 1 Photo!)
      if (path === '/api/ai/scan-prizes' && request.method === 'POST') {
        const { image_base64, mime_type, max_coupons } = await request.json();
        const apiKey = await getGeminiKey(env, db);

        const prompt = `Read ALL handwritten or printed winning coupon numbers from this lucky draw sheet / parchi image.
Valid coupon numbers are integers between 1 and ${max_coupons || 301}. Ignore serial indices like 1), 2) if there is clearly a 2-3 digit coupon number next to them, otherwise extract all valid coupon numbers in order.
Return strict JSON:
{
  "coupon_nums": [12, 45, 108]
}`;
        const parsed = await callGeminiAPI(apiKey, [
          { text: prompt },
          { inlineData: { mimeType: mime_type || 'image/jpeg', data: image_base64 } }
        ], true);
        return jsonResp({ ok: true, coupon_nums: parsed.coupon_nums || [] });
      }

      // AI 4: ASK MUNIM AI (Hinglish Business & Lucky Draw Assistant)
      if (path === '/api/ai/ask-munim' && request.method === 'POST') {
        const { question, stats_context } = await request.json();
        const apiKey = await getGeminiKey(env, db);

        const prompt = `Tum "Smart Munim AI" ho — Aryush Foods (Kailaras, Morena) ke Lucky Draw & Party Khata ERP ke samajhdar Hinglish assistant.
Niche live database summary diya gaya hai:
${JSON.stringify(stats_context)}

User ka sawal: "${question}"

Bilkul saaf, friendly Hinglish me point-wise jawab do (exact numbers, party names, area aur bags/kg ke sath). Chhota aur kaam ka jawab rakho.`;
        const answer = await callGeminiAPI(apiKey, [{ text: prompt }], false);
        return jsonResp({ ok: true, answer });
      }

      return jsonResp({ error: 'Unknown API route: ' + path }, 404);
    } catch (err) {
      return jsonResp({ error: err.message || 'Server error' }, 500);
    }
  }
};
