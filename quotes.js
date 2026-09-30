// Vercel serverless function: live quotes proxy for TWSE MIS (browsers can't call MIS directly because of CORS).
// GET /api/quotes?codes=tse_2330,otc_6207
export default async function handler(req, res) {
  const codes = String(req.query.codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^(tse|otc)_[0-9A-Z]{4,6}$/.test(s))
    .slice(0, 300);
  const out = {};
  for (let i = 0; i < codes.length; i += 60) {
    const chunk = codes.slice(i, i + 60).map((c) => `${c}.tw`).join('|');
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chunk)}&json=1&delay=0&_=${Date.now()}`;
    try {
      const r = await fetch(url, { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp', 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      for (const m of j.msgArray || []) {
        const n = (s) => { const x = parseFloat(String(s ?? '').split('_')[0]); return Number.isFinite(x) ? x : NaN; };
        let price = n(m.z);
        if (!(price > 0)) price = n(m.pz);
        if (!(price > 0)) price = n(m.b) > 0 ? n(m.b) : n(m.a);
        const y = n(m.y);
        out[m.c] = {
          price: price > 0 ? price : null,
          chg: price > 0 && y > 0 ? +(((price - y) / y) * 100).toFixed(2) : null,
          vol: n(m.v) || 0,
          u: n(m.u) || null,
          t: m.t || null,
          d: m.d || null,
        };
      }
    } catch (e) {
      // skip failed chunk
    }
  }
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
  res.status(200).json({ at: new Date().toISOString(), quotes: out });
}
