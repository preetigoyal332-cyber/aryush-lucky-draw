# Aryush Foods — Lucky Draw Coupon & Prize Manager (Cloudflare Workers + D1 + GitHub)

Yeh app aapki **Aryush Lucky Draw Coupon Tracker** Google Sheet ke pure hisab-kitab (`1 Bag = 30 kg`, `210 kg = 1 Coupon`, `300 Coupons Pool`) par banaya gaya hai:
- **Delivery Entry & Log**: 30 kg Bags + Loose KG ya direct Total KG entry, live coupon unlock preview, Edit/Delete aur Google Sheet se **1-Click Bulk Copy-Paste Import**.
- **Ek Sath Coupon Allotment (`Allot Coupons` Tab)**: Jab coupons pure ho jayein, **1-Click me sabhi pending coupons ek sath** allot karein (Sequential `001..300` ya Random Lucky Shuffle mode), ya chune hue retailers ko batch me allot karein.
- **Lucky Draw & Prize Entry (`Prize Chadhayein` Tab)**: Draw hone ke baad Coupon No. dalte hi Retailer ka naam aa jata hai — preset buttons (`1st Alto Car`, `2nd Prize`, `LED TV`, `Consolation` aadi) ya table se tezi se prize save karein.
- **4 Crisp Multi-Page PDF Reports + WhatsApp Share**:
  1. **Official Lucky Draw Prize Winners Report PDF**
  2. **Complete 300 Coupon & Prize Register PDF** (Draw se pehle blank stage register + draw ke baad filled register)
  3. **Retailer Purchase & Coupon Summary PDF**
  4. **Retailer Coupon Handover Receipt Slips PDF**

---

## Instant Local Preview (Bina Deploy Kiye Abhi Test Karein)
Zip folder ke andar **`standalone-preview.html`** file ko mobile ya computer browser me seedha open karein — saare features offline demo mode me turant kaam karenge!

---

## Cloudflare + GitHub Par Live Deploy Kaise Karein (5 Minutes Setup)

### Step 1: Cloudflare D1 Database Banayein
1. [Cloudflare Dashboard](https://dash.cloudflare.com) me login karein.
2. Left menu me **Storage & Databases** -> **D1 SQL Database** -> **Create Database** par click karein.
3. Database ka naam rakhein: `aryush_lucky_draw_db` aur **Create** dabayein.
4. Wahan dikhne wala **`Database ID`** copy karein aur is project ki `wrangler.toml` file me `PASTE_YOUR_D1_DATABASE_ID_HERE` ki jagah paste kar dein.
   *(Note: `schema.sql` alag se chalane ki bhi zaroorat nahi hai — `src/worker.js` pehli baar chalte hi saari tables apne aap bana deta hai!)*

### Step 2: GitHub Repository Banayein
1. GitHub par ek nayi repository banayein (jaise `aryush-lucky-draw`).
2. Is folder ki sabhi files (`wrangler.toml`, `package.json`, `schema.sql`, `src/worker.js`, `.github/workflows/deploy.yml`) GitHub repo me upload / push kar dein.

### Step 3: Cloudflare Workers ko GitHub se Connect Karein (Sabse Aasan Tarika)
1. Cloudflare Dashboard -> **Workers & Pages** -> **Create** -> **Import a repository** chunein.
2. Apni GitHub repository `aryush-lucky-draw` select karein aur **Deploy** par click karein!
3. Agar D1 binding verify karni ho: Worker khulne ke baad **Settings -> Bindings** me check karein ki Variable name **`DB`** aapke `aryush_lucky_draw_db` database se juda hai.

Bas! Ab aap jab bhi GitHub me koi badlav karenge, Cloudflare apne aap live app update kar dega aur aapka data Cloudflare D1 me hamesha safe rahega.
