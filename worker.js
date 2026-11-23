// Aryush Foods — Mega Alto Lucky Draw & Live Digital Passbook Worker (v23.0 Pro Final)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Pin'
};

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

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

function getDB(env) {
  const db = env.DB || env.D1 || env.DATABASE;
  if (!db) throw new Error('Cloudflare D1 binding (DB) not configured on Worker.');
  return db;
}

async function seedOfficialSegmentsIfEmpty(db, forceReset = false) {
  if (forceReset) {
    await db.prepare(`DELETE FROM segments`).run();
  } else {
    const cnt = await db.prepare(`SELECT COUNT(*) AS c FROM segments`).first();
    if (cnt && Number(cnt.c) > 0) return;
  }
  await db.batch(
    OFFICIAL_301_SEGMENTS.map(s =>
      db.prepare(`INSERT INTO segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`).bind(s.rank, s.title, s.target_qty, s.icon)
    )
  );
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
  await seedOfficialSegmentsIfEmpty(db, false);
}

async function loadAllSettings(db, includeSecrets = false) {
  let keyCol = 'key', valCol = 'val';
  try {
    const info = await db.prepare(`PRAGMA table_info(settings)`).all();
    const cols = (info.results || []).map(c => c.name);
    if (!cols.includes('val') && cols.includes('value')) valCol = 'value';
    if (!cols.includes('key') && cols.includes('name')) keyCol = 'name';
  } catch (e) {}

  const { results } = await db.prepare(`SELECT ${keyCol} AS key, ${valCol} AS val FROM settings`).all();
  const out = {};
  let hasPin = false, hasGemini = false;

  for (const row of (results || [])) {
    if (String(row.key || '').startsWith('pad_vid_c_')) continue;
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

function calcEarnedTotal(totalKg, settings) {
  const cupKg = Math.max(1, Number(settings.kg_per_coupon) || 210);
  const bonusEvery = Math.max(0, parseInt(settings.bonus_every_coupons ?? '7', 10));
  const bonusFree = Math.max(0, parseInt(settings.bonus_free_coupons ?? '1', 10));
  const baseEarned = Math.floor((Math.max(0, Number(totalKg) || 0) + 1e-9) / cupKg);
  const bonusEarned = (bonusEvery > 0 && bonusFree > 0) ? Math.floor(baseEarned / bonusEvery) * bonusFree : 0;
  return { baseEarned, bonusEarned, totalEarned: baseEarned + bonusEarned };
}

async function autoAllotPendingForRetailer(db, retailerId, issueDate, settings) {
  if (String(settings.auto_allot_coupons || '0') !== '1') return [];
  const sumRow = await db.prepare(`SELECT COALESCE(SUM(total_kg), 0) AS kg FROM deliveries WHERE retailer_id = ?`).bind(retailerId).first();
  const { totalEarned } = calcEarnedTotal(sumRow?.kg || 0, settings);
  const curRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM coupons WHERE retailer_id = ?`).bind(retailerId).first();
  const needCount = Math.max(0, totalEarned - (Number(curRow?.cnt) || 0));
  if (needCount <= 0) return [];

  const maxC = Number(settings.max_coupons) || 301;
  const { results: usedRows } = await db.prepare(`SELECT coupon_num FROM coupons`).all();
  const used = new Set((usedRows || []).map(r => Number(r.coupon_num)));

  const codes = [], stmts = [];
  for (let i = 1; i <= maxC && codes.length < needCount; i++) {
    if (!used.has(i)) {
      const code = padCouponCode(i, settings);
      codes.push(code);
      stmts.push(db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date) VALUES (?, ?, ?, ?)`).bind(i, code, retailerId, issueDate));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return codes;
}

async function callGeminiFromWorker(apiKey, parts, jsonMode = true) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: jsonMode ? { temperature: 0.15, responseMimeType: 'application/json' } : { temperature: 0.3 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Gemini API request failed');
  const txt = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  return jsonMode ? JSON.parse(txt.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()) : txt;
}

async function handleApiRequest(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = getDB(env);
  await ensureTables(db);

  // 1. STREAM VIDEO WITH HTTP 206 RANGE SUPPORT
  if (path === '/api/media/stream' && method === 'GET') {
    const mediaKey = url.searchParams.get('key') || 'passbook_ad_video';
    const { results } = await db.prepare(`SELECT chunk_idx, mime_type, data_b64 FROM media_chunks WHERE media_key = ? ORDER BY chunk_idx ASC`).bind(mediaKey).all();
    if (!results || !results.length) return new Response('Media not found', { status: 404, headers: CORS_HEADERS });

    const mimeType = results[0].mime_type || 'video/mp4';
    const binStr = atob(results.map(r => r.data_b64).join(''));
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

    const total = bytes.byteLength;
    const rangeHdr = request.headers.get('Range');
    if (rangeHdr && rangeHdr.startsWith('bytes=')) {
      const parts = rangeHdr.replace(/bytes=/, '').split('-');
      const start = Math.max(0, parseInt(parts[0], 10) || 0);
      const end = parts[1] ? Math.min(total - 1, parseInt(parts[1], 10)) : total - 1;
      const chunk = bytes.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(chunk.byteLength),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=600',
          ...CORS_HEADERS
        }
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=600', ...CORS_HEADERS }
    });
  }

  // 2. UPLOAD & DELETE MEDIA CHUNKS
  if (path === '/api/media/upload-chunk' && method === 'POST') {
    const body = await request.json();
    await db.prepare(
      `INSERT INTO media_chunks (media_key, chunk_idx, mime_type, data_b64) VALUES (?, ?, ?, ?)
       ON CONFLICT(media_key, chunk_idx) DO UPDATE SET mime_type = excluded.mime_type, data_b64 = excluded.data_b64`
    ).bind(String(body.media_key || 'passbook_ad_video'), Number(body.chunk_idx) || 0, String(body.mime_type || 'video/mp4'), String(body.data_b64 || '')).run();
    return jsonRes({ ok: true });
  }

  if (path === '/api/media/delete' && method === 'POST') {
    const body = await request.json();
    await db.batch([
      db.prepare(`DELETE FROM media_chunks WHERE media_key = ?`).bind(String(body.media_key || 'passbook_ad_video')),
      db.prepare(`DELETE FROM settings WHERE key LIKE 'pad_vid_c_%'`)
    ]);
    return jsonRes({ ok: true });
  }

  // 3. DYNAMIC RETAILER PWA MANIFEST
  if (path === '/api/public/manifest.json' && method === 'GET') {
    const k = url.searchParams.get('k') || '';
    return jsonRes({
      name: 'आर्युष फूड्स — डिजिटल पासबुक',
      short_name: 'आर्युष पासबुक',
      description: 'आधिकारिक व्यापारिक सप्लाई खाता एवं लकी ड्रॉ कूपन पासबुक',
      start_url: k ? `/?k=${encodeURIComponent(k)}` : '/?check=1',
      display: 'standalone',
      background_color: '#0f172a',
      theme_color: '#0f172a',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
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
      ai_ready: Boolean(settings.gemini_key_saved || env.GEMINI_API_KEY),
      settings,
      retailers: retRes.results || [],
      deliveries: delRes.results || [],
      coupons: cupRes.results || [],
      segments: segRes.results || []
    });
  }

  // 5. PUBLIC RETAILER PASSBOOK CHECK
  if (path === '/api/public/check' && method === 'GET') {
    const settings = await loadAllSettings(db, false);
    const segRes = await db.prepare(`SELECT * FROM segments ORDER BY rank ASC, id ASC`).all();
    const rid = Number(url.searchParams.get('id')) || 0;
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    const cupKg = Math.max(1, Number(settings.kg_per_coupon) || 210);
    const bagKg = Math.max(1, Number(settings.kg_per_bag) || 30);

    let retailers = [];
    if (rid > 0) {
      retailers = (await db.prepare(`SELECT * FROM retailers WHERE id = ?`).bind(rid).all()).results || [];
    } else if (q) {
      const cupNum = parseInt(q.replace(/[^0-9]/g, ''), 10);
      if (cupNum > 0 && /^#?\d+$/.test(q)) {
        retailers = (await db.prepare(`SELECT DISTINCT r.* FROM retailers r JOIN coupons c ON c.retailer_id = r.id WHERE c.coupon_num = ?`).bind(cupNum).all()).results || [];
      }
      if (!retailers.length) {
        retailers = (await db.prepare(`SELECT * FROM retailers WHERE UPPER(name) LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 20`).bind(`%${q}%`, `%${q}%`).all()).results || [];
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
      const { baseEarned, bonusEarned, totalEarned } = calcEarnedTotal(totalKg, settings);
      const remKg = Math.round((totalKg % cupKg) * 100) / 100;
      const needKg = Math.round((cupKg - remKg) * 100) / 100;

      matches.push({
        id: r.id, name: r.name, area: r.area, total_kg: totalKg,
        bags_eq: Math.round((totalKg / bagKg) * 10) / 10,
        base_earned: baseEarned, bonus_earned: bonusEarned, earned: totalEarned,
        rem_kg: remKg, need_kg: needKg, pct: Math.min(100, Math.round((remKg / cupKg) * 100)),
        coupons: cRes.results || [], recent_deliveries: dels.slice(0, 35)
      });
    }
    return jsonRes({ ok: true, settings, segments: segRes.results || [], matches });
  }

  // 6. SETTINGS & PIN
  if (path === '/api/settings' && method === 'POST') {
    const body = await request.json();
    let keyCol = 'key', valCol = 'val';
    try {
      const info = await db.prepare(`PRAGMA table_info(settings)`).all();
      const cols = (info.results || []).map(c => c.name);
      if (!cols.includes('val') && cols.includes('value')) valCol = 'value';
      if (!cols.includes('key') && cols.includes('name')) keyCol = 'name';
    } catch (e) {}
    const stmts = [];
    for (const [k, v] of Object.entries(body || {})) {
      if (String(k).startsWith('pad_vid_c_')) continue;
      stmts.push(db.prepare(`INSERT INTO settings (${keyCol}, ${valCol}) VALUES (?, ?) ON CONFLICT(${keyCol}) DO UPDATE SET ${valCol} = excluded.${valCol}`).bind(String(k), v == null ? '' : String(v)));
    }
    if (stmts.length) await db.batch(stmts);
    return jsonRes({ ok: true });
  }

  if (path === '/api/verify-pin' && method === 'POST') {
    const body = await request.json();
    const row = await db.prepare(`SELECT val FROM settings WHERE key = 'admin_pin'`).first();
    const saved = row?.val || '';
    return jsonRes({ ok: true, valid: !saved || saved === '0000' || String(body.pin || '') === String(saved) });
  }

  // 7. LIVE POLL & SYNC PING
  if (path === '/api/live-poll' && method === 'GET') {
    if (url.searchParams.get('role') === 'tv') {
      const nowTs = String(Date.now());
      await db.prepare(`INSERT INTO settings (key, val) VALUES ('live_tv_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val`).bind(nowTs).run();
    }
    const [cmdRow, hbRow] = await Promise.all([
      db.prepare(`SELECT val FROM settings WHERE key = 'live_stage_cmd'`).first(),
      db.prepare(`SELECT val FROM settings WHERE key = 'live_tv_heartbeat'`).first()
    ]);
    return jsonRes({
      ok: true,
      live_stage_cmd: cmdRow?.val || '',
      tv_heartbeat_ts: Number(hbRow?.val || 0)
    });
  }

  if (path === '/api/sync-ping' && method === 'GET') {
    const [d, c] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(ROUND(SUM(total_kg),1),0) AS kg, COALESCE(MAX(id),0) AS mid FROM deliveries`).first(),
      db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(CASE WHEN prize_status!='NONE' THEN 1 ELSE 0 END),0) AS wcnt FROM coupons`).first()
    ]);
    return jsonRes({ ok: true, sig: `${d?.cnt || 0}_${d?.kg || 0}_${d?.mid || 0}_${c?.cnt || 0}_${c?.wcnt || 0}`, ts: Date.now() });
  }

  // 8. RETAILERS CRUD
  if (path === '/api/retailers' && method === 'POST') {
    const body = await request.json();
    const name = String(body.name || '').trim().toUpperCase();
    const area = String(body.area || '').trim().toUpperCase();
    const phone = String(body.phone || '').trim();
    if (body.id) await db.prepare(`UPDATE retailers SET name = ?, area = ?, phone = ? WHERE id = ?`).bind(name, area, phone, Number(body.id)).run();
    else await db.prepare(`INSERT OR IGNORE INTO retailers (name, area, phone) VALUES (?, ?, ?)`).bind(name, area, phone).run();
    return jsonRes({ ok: true });
  }

  if (path === '/api/retailers/merge' && method === 'POST') {
    const body = await request.json();
    await db.batch([
      db.prepare(`UPDATE deliveries SET retailer_id = ? WHERE retailer_id = ?`).bind(Number(body.keep_id), Number(body.remove_id)),
      db.prepare(`UPDATE coupons SET retailer_id = ? WHERE retailer_id = ?`).bind(Number(body.keep_id), Number(body.remove_id)),
      db.prepare(`DELETE FROM retailers WHERE id = ?`).bind(Number(body.remove_id))
    ]);
    return jsonRes({ ok: true });
  }

  if (path === '/api/retailers/bulk-area' && method === 'POST') {
    const body = await request.json();
    const stmts = (body.updates || []).map(u => db.prepare(`UPDATE retailers SET area = ? WHERE id = ?`).bind(String(u.area || '').trim().toUpperCase(), Number(u.id)));
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

  // 9. DELIVERIES + AUTO-ALLOT
  if (path === '/api/deliveries' && method === 'POST') {
    const body = await request.json();
    const settings = await loadAllSettings(db, false);
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
    const autoCodes = await autoAllotPendingForRetailer(db, ret.id, body.entry_date, settings);
    return jsonRes({ ok: true, retailer_id: ret.id, auto_codes: autoCodes });
  }

  if (path === '/api/deliveries/beat-bulk' && method === 'POST') {
    const body = await request.json();
    const settings = await loadAllSettings(db, false);
    const stmts = [], touchedIds = new Set();
    for (const x of (body.items || [])) {
      if (Number(x.total_kg) > 0) {
        const rid = Number(x.retailer_id);
        touchedIds.add(rid);
        stmts.push(db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, 'Area Sheet')`)
          .bind('DL-' + Math.random().toString(16).slice(2, 8).toUpperCase(), body.entry_date, rid, Number(x.bags) || 0, Number(x.loose_kg) || 0, Number(x.total_kg)));
      }
    }
    if (stmts.length) await db.batch(stmts);
    let autoAllotted = 0;
    for (const rid of touchedIds) autoAllotted += (await autoAllotPendingForRetailer(db, rid, body.entry_date, settings)).length;
    return jsonRes({ ok: true, saved: stmts.length, auto_allotted: autoAllotted });
  }

  if (path.startsWith('/api/deliveries/') && method === 'DELETE') {
    await db.prepare(`DELETE FROM deliveries WHERE id = ?`).bind(Number(path.split('/').pop())).run();
    return jsonRes({ ok: true });
  }

  // 10. COUPONS & SEGMENTS
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
              if (body.force_move === false) return jsonRes({ error: `Coupon #${padCouponCode(n, settings)} already assigned.` }, 400);
              await db.prepare(`UPDATE coupons SET retailer_id = ?, issue_date = ? WHERE coupon_num = ?`).bind(rid, issueDate, n).run();
              savedCnt++;
            }
          } else {
            await db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date) VALUES (?, ?, ?, ?)`).bind(n, padCouponCode(n, settings), rid, issueDate).run();
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
        stmts.push(db.prepare(`INSERT INTO coupons (coupon_num, coupon_code, retailer_id, issue_date) VALUES (?, ?, ?, ?)`).bind(n, padCouponCode(n, settings), Number(a.retailer_id), issueDate));
      }
    }
    if (stmts.length) await db.batch(stmts);
    return jsonRes({ ok: true, allotted: p });
  }

  if (path.startsWith('/api/coupons/proof/') && method === 'GET') {
    const row = await db.prepare(`SELECT handover_proof, handover_note FROM coupons WHERE id = ?`).bind(Number(path.split('/').pop())).first();
    return jsonRes({ ok: true, handover_proof: row?.handover_proof || '', handover_note: row?.handover_note || '' });
  }

  if (path.startsWith('/api/coupons/') && method === 'DELETE') {
    await db.prepare(`DELETE FROM coupons WHERE id = ?`).bind(Number(path.split('/').pop())).run();
    return jsonRes({ ok: true });
  }

  if (path === '/api/coupons/prize-bulk' && method === 'POST') {
    const body = await request.json();
    if (body.mode === 'HANDOVER') {
      const stmts = (body.coupon_ids || []).map(id =>
        body.handover_proof !== undefined
          ? db.prepare(`UPDATE coupons SET prize_status = ?, handover_proof = ?, handover_note = ? WHERE id = ?`).bind(body.prize_status, body.handover_proof, body.handover_note || '', Number(id))
          : db.prepare(`UPDATE coupons SET prize_status = ?, handover_note = COALESCE(?, handover_note) WHERE id = ?`).bind(body.prize_status, body.handover_note ?? null, Number(id))
      );
      if (stmts.length) await db.batch(stmts);
      return jsonRes({ ok: true, updated: stmts.length });
    }
    const newTitle = String(body.prize_title || '').trim();
    const nums = Array.from(new Set((body.coupon_nums || []).map(Number).filter(n => n > 0)));
    if (newTitle) {
      const segRow = await db.prepare(`SELECT target_qty FROM segments WHERE title = ?`).bind(newTitle).first();
      const maxQty = segRow ? Math.max(1, Number(segRow.target_qty) || 1) : 9999;
      const { results: curSegWinners } = await db.prepare(`SELECT coupon_num FROM coupons WHERE prize_title = ? AND prize_status != 'NONE'`).bind(newTitle).all();
      const existingSet = new Set((curSegWinners || []).map(r => Number(r.coupon_num)));
      const netAdditions = nums.filter(n => !existingSet.has(n));
      if (existingSet.size + netAdditions.length > maxQty) return jsonRes({ error: `Segment "${newTitle}" quota exceeded (max ${maxQty}).` }, 400);
    }
    const stmts = nums.map(num =>
      db.prepare(`UPDATE coupons SET prize_title = ?, prize_rank = ?, prize_status = ?, draw_date = ? WHERE coupon_num = ?`)
        .bind(newTitle, newTitle ? Number(body.prize_rank) : 999, newTitle ? (body.prize_status || 'WON') : 'NONE', body.draw_date || '', Number(num))
    );
    if (stmts.length) await db.batch(stmts);
    return jsonRes({ ok: true, updated: stmts.length });
  }

  if (path === '/api/segments/reset-official' && method === 'POST') {
    await seedOfficialSegmentsIfEmpty(db, true);
    return jsonRes({ ok: true });
  }

  if (path === '/api/segments' && method === 'POST') {
    const body = await request.json();
    if (body.id) await db.prepare(`UPDATE segments SET rank = ?, title = ?, target_qty = ?, icon = ? WHERE id = ?`).bind(Number(body.rank), body.title, Number(body.target_qty), body.icon || '🎁', Number(body.id)).run();
    else await db.prepare(`INSERT INTO segments (rank, title, target_qty, icon) VALUES (?, ?, ?, ?)`).bind(Number(body.rank), body.title, Number(body.target_qty), body.icon || '🎁').run();
    return jsonRes({ ok: true });
  }

  if (path.startsWith('/api/segments/') && method === 'DELETE') {
    await db.prepare(`DELETE FROM segments WHERE id = ?`).bind(Number(path.split('/').pop())).run();
    return jsonRes({ ok: true });
  }

  // 11. SHEET / EXCEL / BACKUP IMPORT
  if (path === '/api/import/gsheet' && method === 'POST') {
    const body = await request.json();
    const m = String(body.sheet_url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!m || !m[1]) return jsonRes({ error: 'Invalid Google Sheet URL' }, 400);
    const gRes = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`);
    if (!gRes.ok) return jsonRes({ error: 'Sheet is not public. Set sharing to Anyone with the link.' }, 400);
    const bytes = new Uint8Array(await gRes.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return jsonRes({ ok: true, xlsx_base64: btoa(bin) });
  }

  if (path === '/api/import' && method === 'POST') {
    const body = await request.json();
    const settings = await loadAllSettings(db, false);
    if (body.full_restore) {
      await db.batch([db.prepare(`DELETE FROM deliveries`), db.prepare(`DELETE FROM coupons`), db.prepare(`DELETE FROM retailers`), db.prepare(`DELETE FROM segments`)]);
      if (body.settings && typeof body.settings === 'object') {
        const sStmts = Object.entries(body.settings).filter(([k]) => !k.startsWith('pad_vid_c_') && k !== 'pin_enabled' && k !== 'gemini_key_saved')
          .map(([k, v]) => db.prepare(`INSERT OR REPLACE INTO settings (key, val) VALUES (?, ?)`).bind(k, String(v ?? '')));
        if (sStmts.length) await db.batch(sStmts);
      }
      if (Array.isArray(body.segments) && body.segments.length) {
        await db.batch(body.segments.map(s => db.prepare(`INSERT INTO segments (id, rank, title, target_qty, icon) VALUES (?, ?, ?, ?, ?)`).bind(s.id, s.rank, s.title, s.target_qty, s.icon || '🎁')));
      } else await seedOfficialSegmentsIfEmpty(db, true);

      for (let i = 0; i < (body.retailers || []).length; i += 50) {
        await db.batch(body.retailers.slice(i, i + 50).map(r => db.prepare(`INSERT INTO retailers (id, name, area, phone) VALUES (?, ?, ?, ?)`).bind(r.id, String(r.name).toUpperCase(), String(r.area || '').toUpperCase(), r.phone || '')));
      }
      for (let i = 0; i < (body.deliveries || []).length; i += 50) {
        await db.batch(body.deliveries.slice(i, i + 50).map(d => db.prepare(`INSERT INTO deliveries (id, dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(d.id, d.dl_code || '', d.entry_date, d.retailer_id, d.bags || 0, d.loose_kg || 0, d.total_kg, d.remarks || '')));
      }
      for (let i = 0; i < (body.coupons || []).length; i += 50) {
        await db.batch(body.coupons.slice(i, i + 50).map(c => db.prepare(`INSERT INTO coupons (id, coupon_num, coupon_code, retailer_id, issue_date, prize_rank, prize_title, prize_status, draw_date, handover_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.coupon_num, c.coupon_code, c.retailer_id, c.issue_date, c.prize_rank || 999, c.prize_title || '', c.prize_status || 'NONE', c.draw_date || '', c.handover_note || '')));
      }
      return jsonRes({ ok: true });
    }

    for (const r of (body.retailers || [])) {
      const nm = String(typeof r === 'string' ? r : r.name || '').trim().toUpperCase();
      if (nm) await db.prepare(`INSERT OR IGNORE INTO retailers (name, area, phone) VALUES (?, ?, ?)`).bind(nm, String(r.area || '').toUpperCase(), String(r.phone || '')).run();
    }
    const { results: allRets } = await db.prepare(`SELECT id, name FROM retailers`).all();
    const rByName = new Map((allRets || []).map(r => [String(r.name).toUpperCase(), r.id]));

    let importedDels = 0;
    for (const d of (body.deliveries || [])) {
      const nm = String(d.retailer_name || '').trim().toUpperCase();
      if (!nm || !(Number(d.total_kg) > 0)) continue;
      let rid = rByName.get(nm);
      if (!rid) {
        await db.prepare(`INSERT OR IGNORE INTO retailers (name) VALUES (?)`).bind(nm).run();
        rid = (await db.prepare(`SELECT id FROM retailers WHERE name = ?`).bind(nm).first())?.id;
        if (rid) rByName.set(nm, rid);
      }
      if (!rid) continue;
      if (d.dl_code && (await db.prepare(`SELECT id FROM deliveries WHERE dl_code = ?`).bind(d.dl_code).first())) continue;
      await db.prepare(`INSERT INTO deliveries (dl_code, entry_date, retailer_id, bags, loose_kg, total_kg, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(d.dl_code || ('DL-' + Math.random().toString(16).slice(2, 8).toUpperCase()), d.entry_date || new Date().toISOString().slice(0, 10), rid, Number(d.bags) || 0, Number(d.loose_kg) || 0, Number(d.total_kg), d.remarks || '').run();
      importedDels++;
    }
    for (const c of (body.coupons || [])) {
      const nm = String(c.retailer_name || '').trim().toUpperCase(), num = Number(c.coupon_num) || 0;
      if (!nm || num <= 0) continue;
      let rid = rByName.get(nm);
      if (!rid) {
        await db.prepare(`INSERT OR IGNORE INTO retailers (name) VALUES (?)`).bind(nm).run();
        rid = (await db.prepare(`SELECT id FROM retailers WHERE name = ?`).bind(nm).first())?.id;
        if (rid) rByName.set(nm, rid);
      }
      if (rid) {
        const pt = String(c.prize_title || '').trim();
        await db.prepare(`INSERT OR IGNORE INTO coupons (coupon_num, coupon_code, retailer_id, issue_date, prize_title, prize_status) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(num, padCouponCode(num, settings), rid, c.issue_date || new Date().toISOString().slice(0, 10), pt, pt ? 'WON' : 'NONE').run();
      }
    }
    return jsonRes({ ok: true, imported_deliveries: importedDels });
  }

  // 12. GEMINI AI ROUTES
  if (path.startsWith('/api/ai/') && method === 'POST') {
    const fullSet = await loadAllSettings(db, true);
    const apiKey = fullSet.gemini_api_key || env.GEMINI_API_KEY || '';
    if (!apiKey) return jsonRes({ error: 'Reports & Settings टैब में अपनी Gemini API Key सेव करें।' }, 400);
    const body = await request.json();

    if (path === '/api/ai/parse-voice') {
      if (body.context_mode === 'PRIZES') {
        return jsonRes({ ok: true, ...(await callGeminiFromWorker(apiKey, [{ text: `Extract winning coupon numbers from: "${body.transcript}". Return JSON: {"coupon_nums":[1,2]}` }], true)) });
      }
      return jsonRes({ ok: true, ...(await callGeminiFromWorker(apiKey, [{
        text: `Parse Hindi/Hinglish dispatch entry (1 bag = ${body.bag_kg || 30}kg, today = ${body.today}). Existing parties: ${JSON.stringify((body.retailer_names || []).slice(0, 250))}. Spoken: "${body.transcript}". Return JSON: {"retailer_name":"","area":"","bags":0,"loose_kg":0,"total_kg":0,"entry_date":"${body.today}","remarks":""}`
      }], true)) });
    }
    if (path === '/api/ai/scan-bill') {
      const p = await callGeminiFromWorker(apiKey, [
        { text: `Extract dispatch entries from this bill image (1 bag = ${body.bag_kg || 30}kg, default date ${body.today}). Match closest party: ${JSON.stringify((body.retailer_names || []).slice(0, 250))}. Return JSON: {"entries":[{"entry_date":"${body.today}","retailer_name":"","area":"","bags":0,"loose_kg":0,"total_kg":0,"remarks":""}]}` },
        { inlineData: { mimeType: body.mime_type || 'image/jpeg', data: body.image_base64 } }
      ], true);
      return jsonRes({ ok: true, entries: p.entries || [] });
    }
    if (path === '/api/ai/scan-prizes') {
      const p = await callGeminiFromWorker(apiKey, [
        { text: `Extract valid coupon numbers (1 to ${body.max_coupons || 301}) from this sheet image. Return JSON: {"coupon_nums":[1,2]}` },
        { inlineData: { mimeType: body.mime_type || 'image/jpeg', data: body.image_base64 } }
      ], true);
      return jsonRes({ ok: true, coupon_nums: p.coupon_nums || [] });
    }
    if (path === '/api/ai/ask-munim') {
      const ans = await callGeminiFromWorker(apiKey, [{ text: `आप आर्युष फूड्स (कैलारस) के बिज़नेस AI असिस्टेंट हैं। डेटा: ${JSON.stringify(body.stats_context)}। प्रश्न: "${body.question}"। संक्षिप्त हिंदी/हिंग्लिश में उत्तर दें।` }], false);
      return jsonRes({ ok: true, answer: ans });
    }
    if (path === '/api/ai/product-khasiyat') {
      const p = await callGeminiFromWorker(apiKey, [
        { text: `Analyze this Aryush Rasoi Dhan food/spice/mustard oil product pack image (or product name hint: "${body.hint || ''}"). Return pure professional Hindi product details in JSON: {"hi":"हिंदी नाम","name":"English Name","tag":"छोटी आकर्षक टैगलाइन (अधिकतम 7 शब्द)","khasiyat":["विशेषता 1","विशेषता 2","विशेषता 3"]}` },
        ...(body.image_base64 ? [{ inlineData: { mimeType: body.mime_type || 'image/jpeg', data: body.image_base64 } }] : [])
      ], true);
      return jsonRes({ ok: true, ...p });
    }
    if (path === '/api/ai/stage-commentary') {
      const ans = await callGeminiFromWorker(apiKey, [{
        text: `आप आर्युष फूड्स (कैलारस, मुरैना) के भव्य लकी ड्रॉ स्टेज शो के ऊर्जावान एंकर हैं। विजेता फर्म: "${body.shop}" (क्षेत्र: ${body.area}, कुल सप्लाई: ${body.total_kg || 0} kg), लकी कूपन नं: #${body.coupon}, जीता गया पुरस्कार: "${body.prize}"। उनके लिए मात्र 2 जोशीली, सम्मानजनक और ताली बजवाने वाली शुद्ध हिंदी पंक्तियाँ लिखें (बिना किसी अतिरिक्त भूमिका के)।`
      }], false);
      return jsonRes({ ok: true, speech: ans });
    }
    if (path === '/api/ai/campaign-copy') {
      const ans = await callGeminiFromWorker(apiKey, [{
        text: `आर्युष फूड्स (आर्युष रसोई धन — शुद्ध कच्ची घानी सरसों तेल व मसाले) के दुकानदारों के लिए "${body.topic || 'त्योहारी धमाका व लकी कूपन ऑफर'}" विषय पर एक छोटा (अधिकतम 8 लाइन), आकर्षक और प्रोफेशनल हिंदी WhatsApp प्रमोशनल मैसेज लिखें।`
      }], false);
      return jsonRes({ ok: true, copy: ans });
    }
  }

  return jsonRes({ error: 'API route not found: ' + path }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApiRequest(request, env, url);
      } catch (err) {
        return jsonRes({ error: err.message || 'Server error' }, 500);
      }
    }
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Worker API running.', { status: 200 });
  }
};
