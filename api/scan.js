// Vercel serverless function: live full-market scan from TWSE MIS.
// GET /api/scan  -> { at, dataTime, date, scanned, items:[{code,name,m,chg,price,open,prev,limitUp,vol,gap,gapPct}] }
// Records everything with gain >= 3% and volume >= 1,000 lots, or a 5% gap-up; the page filters further.
// Responses are shared through Vercel's CDN cache for 20 s, so many viewers still mean ~3 MIS sweeps a minute.
export const config = { maxDuration: 30 };

const FLOOR = { chg: 3, vol: 1000 };
const GAP = 5;
const n = (s) => { const x = parseFloat(String(s ?? '').split('_')[0]); return Number.isFinite(x) ? x : NaN; };

async function batch(list) {
  const chunk = list.map(([code, m]) => `${m}_${code}.tw`).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chunk)}&json=1&delay=0&_=${Date.now()}`;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp', 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      return j.msgArray || [];
    } catch { /* retry once */ }
  }
  return [];
}

export default async function handler(req, res) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const uni = await fetch(`${proto}://${req.headers.host}/data/universe.json`).then((r) => r.json());
    const names = Object.fromEntries(uni.map(([c, m, name]) => [c, { m, name }]));
    const chunks = [];
    for (let i = 0; i < uni.length; i += 60) chunks.push(uni.slice(i, i + 60));
    const rows = [];
    // 6 requests in flight at a time
    for (let i = 0; i < chunks.length; i += 6) {
      const got = await Promise.all(chunks.slice(i, i + 6).map(batch));
      got.forEach((g) => rows.push(...g));
    }
    let dataTime = '', date = '', scanned = 0;
    const items = [];
    for (const m of rows) {
      if (!m.c || !names[m.c]) continue;
      const y = n(m.y);
      if (!(y > 0)) continue;
      scanned++;
      if (m.t && m.t > dataTime) dataTime = m.t;
      if (m.d) date = m.d;
      let price = n(m.z);
      if (!(price > 0)) price = n(m.pz);
      if (!(price > 0)) price = n(m.b) > 0 ? n(m.b) : n(m.a);
      const vol = n(m.v) || 0;
      const o = n(m.o);
      const chg = price > 0 ? ((price - y) / y) * 100 : NaN;
      const gap = o > 0 && o > y * (1 + GAP / 100);
      if (!((chg >= FLOOR.chg && vol >= FLOOR.vol) || gap)) continue;
      items.push({
        code: m.c, name: names[m.c].name, m: names[m.c].m,
        chg: +chg.toFixed(2), price, open: o, prev: y, limitUp: n(m.u), vol,
        gap, gapPct: o > 0 ? +(((o - y) / y) * 100).toFixed(2) : null,
      });
    }
    items.sort((a, b) => b.chg - a.chg);
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=20');
    res.status(200).json({ at: new Date().toISOString(), date, dataTime, scanned, floor: FLOOR, items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
