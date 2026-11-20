# Aryush Foods — Lucky Draw Coupon & Prize Manager (Cloudflare Workers + D1)

Is ZIP me saari files **seedha root level (bina kisi subfolder ke)** rakhi gayi hain taaki mobile browser se GitHub par ek hi baar me upload ho jayein:
- `worker.js` — Full-Stack App + D1 Backend (Auto-creates all database tables on first load)
- `wrangler.toml` — Pre-configured with your D1 Database (`aryush_lucky_draw_db`)
- `package.json` — Configured with Wrangler v4
- `schema.sql` — SQL reference

## Upload Steps (Mobile / PC)
1. ZIP ko Extract (Unzip) karein.
2. GitHub repo (`aryush-lucky-draw`) kholein -> **Add file** -> **Upload files**.
3. Sabhi files (`worker.js`, `wrangler.toml`, `package.json`, `schema.sql`) ek sath select karke **Commit changes** daba dein!
4. Cloudflare apne aap build chalu karega aur app live ho jayega.
