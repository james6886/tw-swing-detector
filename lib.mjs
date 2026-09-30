// Shared helpers: Taipei time, HTTP with retry, TWSE MIS realtime quotes,
// TWSE/TPEx daily closing quotes, company announcements, Google News RSS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUB = path.join(ROOT, 'public', 'data');
export const PRIV = path.join(ROOT, 'data');

export const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.FAST ? 0 : ms));

// ---------- time (Asia/Taipei) ----------
export function tw(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hh}:${parts.minute}:${parts.second}`,
    hm: `${hh}:${parts.minute}`,
    weekday: parts.weekday,
    minutes: Number(hh) * 60 + Number(parts.minute),
    seconds: Number(hh) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}
export const ymdToDate = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

// ---------- json files ----------
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, obj, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, pretty ? 1 : 0));
}

// ---------- http ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export async function get(url, { tries = 3, headers = {}, type = 'json' } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', ...headers } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return type === 'json' ? await r.json() : await r.text();
    } catch (e) {
      err = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw err;
}

const num = (s) => {
  if (s == null) return NaN;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
export { num };

// ---------- TWSE MIS realtime ----------
// ex_ch keys look like "tse_2330.tw" / "otc_6207.tw". Returns map code -> quote.
export async function misQuotes(list, batch = 60) {
  const out = {};
  for (let i = 0; i < list.length; i += batch) {
    const chunk = list.slice(i, i + batch).map((s) => `${s.m}_${s.code}.tw`).join('|');
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chunk)}&json=1&delay=0&_=${Date.now()}`;
    try {
      const j = await get(url, { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' } });
      for (const r of j.msgArray || []) {
        const q = parseMis(r);
        if (q) out[q.code] = q;
      }
    } catch (e) {
      console.warn('MIS batch failed', i, e.message);
    }
    await sleep(350);
  }
  return out;
}

export function parseMis(r) {
  if (!r || !r.c) return null;
  const first = (s) => num(String(s || '').split('_')[0]);
  const y = num(r.y);
  const u = num(r.u);
  let price = num(r.z);
  if (!(price > 0)) price = num(r.pz);
  if (!(price > 0)) {
    // no trade on the last tick: use best bid (locked limit-up shows bid = limit price)
    const b = first(r.b), a = first(r.a);
    price = b > 0 ? b : a > 0 ? a : NaN;
  }
  const v = num(r.v);
  return {
    code: r.c,
    m: r.ex,
    name: r.n,
    y,
    o: num(r.o),
    h: num(r.h),
    l: num(r.l),
    u,
    w: num(r.w),
    price,
    vol: Number.isFinite(v) ? v : 0, // accumulated volume in lots (張)
    chg: price > 0 && y > 0 ? ((price - y) / y) * 100 : NaN,
    d: r.d,
    t: r.t,
  };
}

// ---------- daily closing quotes (official) ----------
// Returns array of {code, name, m, close, vol(lots), chg(%)} or null if no trading that day.
export async function twseDaily(ymd) {
  const j = await get(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`);
  if (j.stat !== 'OK' || !j.tables) return null;
  const t = j.tables.find((x) => (x.fields || []).includes('證券代號') && (x.fields || []).includes('收盤價'));
  if (!t || !t.data?.length) return null;
  const f = (k) => t.fields.indexOf(k);
  const iC = f('證券代號'), iN = f('證券名稱'), iV = f('成交股數'), iP = f('收盤價'), iS = f('漲跌(+/-)'), iD = f('漲跌價差');
  const rows = [];
  for (const r of t.data) {
    const code = String(r[iC]).trim();
    if (!/^[1-9]\d{3}$/.test(code)) continue; // common stocks only (skip ETFs 00xx, warrants)
    const close = num(r[iP]);
    const sign = /-/.test(r[iS]) ? -1 : /\+/.test(r[iS]) ? 1 : 0;
    const diff = sign * (num(r[iD]) || 0);
    const prev = close - diff;
    rows.push({
      code, name: String(r[iN]).trim(), m: 'tse',
      close: close > 0 ? close : null,
      vol: Math.round((num(r[iV]) || 0) / 1000),
      chg: close > 0 && prev > 0 ? +((diff / prev) * 100).toFixed(2) : null,
    });
  }
  return rows;
}

export async function tpexDaily(ymd) {
  const d = `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
  const j = await get(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(d)}&id=&response=json`);
  if (!j.tables || String(j.date) !== ymd) return null;
  const t = j.tables.find((x) => (x.fields || []).includes('代號') && (x.fields || []).includes('收盤'));
  if (!t || !t.data?.length) return null;
  const f = (k) => t.fields.indexOf(k);
  const iC = f('代號'), iN = f('名稱'), iP = f('收盤'), iD = f('漲跌'), iV = f('成交股數');
  const rows = [];
  for (const r of t.data) {
    const code = String(r[iC]).trim();
    if (!/^[1-9]\d{3}$/.test(code)) continue;
    const close = num(r[iP]);
    const diff = num(r[iD]);
    const prev = close - (Number.isFinite(diff) ? diff : 0);
    rows.push({
      code, name: String(r[iN]).trim(), m: 'otc',
      close: close > 0 ? close : null,
      vol: Math.round((num(r[iV]) || 0) / 1000),
      chg: close > 0 && prev > 0 && Number.isFinite(diff) ? +((diff / prev) * 100).toFixed(2) : null,
    });
  }
  return rows;
}

// ---------- history store (for 60-day MA, streaks, 量增K) ----------
// data/history.json = { dates:[ymd...], s:{ code:{m,n,c:[close],v:[lots],p:[chg%]} } }
const HIST = path.join(PRIV, 'history.json');
const KEEP = 80;
export const loadHistory = () => readJSON(HIST, { dates: [], s: {} });
export const saveHistory = (h) => writeJSON(HIST, h);

export function appendDay(h, ymd, rows) {
  if (h.dates.includes(ymd)) return false;
  // insert keeping ascending order
  const idx = h.dates.findIndex((d) => d > ymd);
  const pos = idx === -1 ? h.dates.length : idx;
  h.dates.splice(pos, 0, ymd);
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.code);
    let s = h.s[r.code];
    if (!s) {
      s = h.s[r.code] = { m: r.m, n: r.name, c: [], v: [], p: [] };
      const len = h.dates.length - 1;
      s.c = Array(len).fill(null); s.v = Array(len).fill(null); s.p = Array(len).fill(null);
    }
    s.m = r.m; s.n = r.name;
    s.c.splice(pos, 0, r.close); s.v.splice(pos, 0, r.vol); s.p.splice(pos, 0, r.chg);
  }
  for (const [code, s] of Object.entries(h.s)) {
    if (!seen.has(code)) { s.c.splice(pos, 0, null); s.v.splice(pos, 0, null); s.p.splice(pos, 0, null); }
  }
  // trim
  const extra = h.dates.length - KEEP;
  if (extra > 0) {
    h.dates.splice(0, extra);
    for (const s of Object.values(h.s)) { s.c.splice(0, extra); s.v.splice(0, extra); s.p.splice(0, extra); }
  }
  // drop codes with no data in window
  for (const [code, s] of Object.entries(h.s)) if (s.c.every((x) => x == null)) delete h.s[code];
  return true;
}

export async function fetchDay(ymd) {
  const a = await twseDaily(ymd).catch((e) => { console.warn('twse', ymd, e.message); return undefined; });
  await sleep(2500);
  const b = await tpexDaily(ymd).catch((e) => { console.warn('tpex', ymd, e.message); return undefined; });
  await sleep(1500);
  if (a === undefined || b === undefined) return undefined; // network error -> retry later
  if (!a || !b) return null; // holiday / not yet published
  return [...a, ...b];
}

// Fill any missing weekdays in the last `days` calendar days (excluding today unless includeToday).
export async function syncHistory(days = 10, includeToday = false) {
  const h = loadHistory();
  const today = tw().ymd;
  let added = 0;
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const t = tw(d);
    if (t.weekday === 'Sat' || t.weekday === 'Sun') continue;
    if (t.ymd === today && !includeToday) continue;
    if (t.ymd > today) continue;
    if (h.dates.includes(t.ymd)) continue;
    const rows = await fetchDay(t.ymd);
    if (rows && rows.length > (Number(process.env.MIN_ROWS) || 500)) {
      appendDay(h, t.ymd, rows);
      added++;
      console.log('history +', t.ymd, rows.length);
    }
  }
  if (added) saveHistory(h);
  return h;
}

// Stock universe (listed + OTC common stocks) from the latest history day.
export function universe(h) {
  const last = h.dates.length - 1;
  return Object.entries(h.s)
    .filter(([, s]) => s.c[last] != null || s.c[last - 1] != null)
    .map(([code, s]) => ({ code, m: s.m, name: s.n }));
}

// ---------- company announcements (重大訊息) ----------
const ANN = path.join(PRIV, 'announcements.json');
export async function syncAnnouncements() {
  const store = readJSON(ANN, {});
  const feeds = [
    'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O',
  ];
  for (const url of feeds) {
    try {
      const arr = await get(url);
      for (const r of arr) {
        const key = (re) => { const k = Object.keys(r).find((x) => re.test(x.trim())); return k ? String(r[k]).trim() : ''; };
        const code = key(/^(公司代號|SecuritiesCompanyCode)$/);
        if (!code) continue;
        const roc = key(/^發言日期$/);
        const tm = key(/^發言時間$/).padStart(6, '0');
        const date = roc ? `${Number(roc.slice(0, roc.length - 4)) + 1911}-${roc.slice(-4, -2)}-${roc.slice(-2)}` : '';
        const item = {
          date, time: `${tm.slice(0, 2)}:${tm.slice(2, 4)}`,
          subject: key(/^主旨/).replace(/\s+/g, ' '),
          summary: key(/^說明/).replace(/\s+/g, ' ').slice(0, 220),
        };
        const list = (store[code] ||= []);
        if (!list.some((x) => x.date === item.date && x.time === item.time && x.subject === item.subject)) list.push(item);
      }
    } catch (e) {
      console.warn('announcements', url, e.message);
    }
  }
  // keep last 14 days
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const [code, list] of Object.entries(store)) {
    store[code] = list.filter((x) => x.date >= cutoff).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    if (!store[code].length) delete store[code];
  }
  writeJSON(ANN, store);
  return store;
}
export const loadAnnouncements = () => readJSON(ANN, {});

// ---------- news (Google News RSS) ----------
export const THEMES = [
  '光通訊', 'CPO', '矽光子', '共同封裝光學', '玻璃基板', '先進封裝', 'CoWoS', 'SoIC', 'FOPLP', '面板級封裝',
  'AI伺服器', 'AI 伺服器', '伺服器', 'ASIC', '矽智財', 'HBM', '記憶體', 'DRAM', 'NAND', '散熱', '液冷', '水冷',
  '機器人', '人形機器人', '低軌衛星', '衛星', '重電', '電網', '儲能', '綠能', '風電', '太陽能', '核能', '核電',
  'PCB', '載板', 'ABF', 'CCL', '銅箔基板', '被動元件', 'MLCC', '半導體設備', '設備', '量子', '無人機', '軍工', '國防',
  '生技', '新藥', '減重', '減肥藥', '電動車', '車用', '光學', '鏡頭', '網通', '交換器', '5G', '6G', '雷射',
  '碳化矽', 'SiC', '氮化鎵', 'GaN', '第三代半導體', '矽晶圓', '石英', '連接器', '電源', 'BBU', '邊緣AI', 'AI PC',
  '營建', '資產', '航運', '觀光', '蘋概', '輝達', 'NVIDIA', 'GB300', 'Rubin', '特斯拉', '光纖', '雷射封測', '概念股',
];
const POS = ['漲停', '亮燈', '大漲', '飆', '噴', '創高', '新高', '買超', '看好', '成長', '強勢', '翻倍', '旺', '上修', '利多', '搶', '急單', '擴產', '量產', '出貨', '報喜', '攻'];
const NEG = ['跌停', '大跌', '重挫', '賣超', '下修', '衰退', '虧損', '利空', '處置', '注意股', '減產', '砍', '崩', '示警', '警示', '疲', '賣壓'];

export function scoreTitle(t) {
  let s = 0;
  for (const w of POS) if (t.includes(w)) s++;
  for (const w of NEG) if (t.includes(w)) s--;
  return Math.max(-3, Math.min(3, s));
}
export function themesOf(t) {
  const out = new Set();
  for (const k of THEMES) if (k !== '概念股' && t.toLowerCase().includes(k.toLowerCase())) out.add(k.replace(/\s/g, ''));
  const m = t.match(/([一-龥A-Za-z0-9]{2,6})(概念股|族群)/g);
  if (m) for (const x of m) out.add(x.replace(/(概念股|族群)$/, '') || x);
  return [...out].slice(0, 3);
}

const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

export async function news(code, name, days = 2, limit = 8) {
  const q = `${code} ${name} when:${days}d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const xml = await get(url, { type: 'text' });
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const b = m[1];
      const pick = (tag) => { const x = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return x ? decode(x[1]) : ''; };
      let title = pick('title');
      const source = pick('source');
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
      return { title, link: pick('link'), source, pub: new Date(pick('pubDate')).toISOString(), score: scoreTitle(title), themes: themesOf(title) };
    });
    // keep only headlines that actually mention the stock
    const short = name.replace(/[-*].*$/, '').replace(/-KY$/, '');
    return items
      .filter((x) => x.title.includes(code) || x.title.includes(short))
      .sort((a, b) => b.pub.localeCompare(a.pub))
      .slice(0, limit);
  } catch (e) {
    console.warn('news', code, e.message);
    return [];
  } finally {
    await sleep(600);
  }
}

// ---------- meta ----------
export function touchMeta(patch = {}) {
  const f = path.join(PUB, 'meta.json');
  const m = readJSON(f, {});
  const t = tw();
  writeJSON(f, { ...m, ...patch, lastCheck: `${t.date} ${t.hm}` }, true);
}
