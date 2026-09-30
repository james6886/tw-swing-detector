// Usage: node scripts/scan.mjs <mode> [--force]
//   backfill  : build ~90 days of daily history (run once after setup)
//   premarket : 07:50 — sync history + announcements, stamp "last check"
//   open      : 09:15 — first 15-min K snapshot (今日開盤)
//   volk      : 13:00 / 13:30 — 量增K scan (previous day ≥9% and today's volume > yesterday's)
//   close     : 15:10 — 明日觀察 + 熱門族群漲停
import path from 'node:path';
import {
  PUB, tw, sleep, readJSON, writeJSON, misQuotes, loadHistory, syncHistory, universe,
  syncAnnouncements, loadAnnouncements, news, touchMeta, ymdToDate,
} from './lib.mjs';

const mode = process.argv[2];
const force = process.argv.includes('--force');
const now = tw();

// scan floors (what gets recorded — the UI can only filter within these)
const OPEN_FLOOR = { chg: 3, vol: 1000 };
const GAP = 5; // 🚀 open > prev close * 1.05
const WATCH = { lockedValue: 3e8, topN: 100, topChg: 9, bigValue: 1e9, streakChg: 9 };

function isTradingSnapshot(quotes) {
  const any = Object.values(quotes).find((q) => q.d);
  return any && any.d === now.ymd && Object.values(quotes).some((q) => q.vol > 0);
}

// history arrays for a code, excluding today's date if already appended
function histOf(h, code) {
  const s = h.s[code];
  if (!s) return null;
  let n = h.dates.length;
  if (h.dates[n - 1] === now.ymd) n--;
  return { c: s.c.slice(0, n), v: s.v.slice(0, n), p: s.p.slice(0, n) };
}

function ma(closes, todayClose, len = 60) {
  const arr = [...closes.filter((x) => x != null), todayClose].slice(-len);
  if (arr.length < len) return null;
  return arr.reduce((a, b) => a + b, 0) / len;
}

async function modeOpen() {
  const file = path.join(PUB, 'today.json');
  const prev = readJSON(file, null);
  if (!force && prev && prev.date === now.date) { console.log('today.json already recorded for', now.date); return; }
  // wait for 09:15:05 if started early
  const target = 9 * 3600 + 15 * 60 + 5;
  if (!process.env.NO_WAIT && now.seconds < target && target - now.seconds < 3600) {
    console.log(`waiting ${target - now.seconds}s for 09:15`);
    await sleep((target - now.seconds) * 1000);
  }
  const h = await syncHistory(7);
  const uni = universe(h);
  const scanTime = tw().time;
  const quotes = await misQuotes(uni);
  if (!isTradingSnapshot(quotes)) { console.log('not a trading day / no data'); return; }
  const items = [];
  let dataTime = '00:00:00';
  let scanned = 0;
  for (const s of uni) {
    const q = quotes[s.code];
    if (!q || !(q.y > 0)) continue;
    scanned++;
    if (q.t && q.t > dataTime) dataTime = q.t;
    const gap = q.o > 0 && q.o > q.y * (1 + GAP / 100);
    if (!((q.chg >= OPEN_FLOOR.chg && q.vol >= OPEN_FLOOR.vol) || gap)) continue;
    items.push({
      code: s.code, name: s.name, m: s.m,
      chg: +q.chg.toFixed(2), price: q.price, open: q.o, prev: q.y, limitUp: q.u, vol: q.vol,
      gap, gapPct: q.o > 0 ? +(((q.o - q.y) / q.y) * 100).toFixed(2) : null,
    });
  }
  items.sort((a, b) => b.chg - a.chg);
  writeJSON(file, { date: now.date, scanTime, dataTime, scanned, floor: OPEN_FLOOR, gapPct: GAP, items }, true);
  console.log(`open: ${items.length} candidates of ${scanned}`);
}

async function modeVolK() {
  const file = path.join(PUB, 'volk.json');
  const h = await syncHistory(7);
  const lastDay = h.dates.filter((d) => d < now.ymd).pop();
  if (!lastDay) return;
  const idx = h.dates.indexOf(lastDay);
  const cands = Object.entries(h.s)
    .filter(([, s]) => s.p[idx] != null && s.p[idx] >= 9)
    .map(([code, s]) => ({ code, m: s.m, name: s.n, prevChg: s.p[idx], prevVol: s.v[idx], prevClose: s.c[idx] }));
  const quotes = await misQuotes(cands);
  if (!isTradingSnapshot(quotes)) { console.log('not a trading day'); return; }
  const old = readJSON(file, null);
  const keep = old && old.date === now.date ? old : { date: now.date, prevDate: ymdToDate(lastDay), scans: [], items: [] };
  const t = tw().hm;
  keep.scans.push(t);
  for (const c of cands) {
    const q = quotes[c.code];
    if (!q) continue;
    const hit = q.vol > c.prevVol;
    const ex = keep.items.find((x) => x.code === c.code);
    const row = { ...c, vol: q.vol, price: q.price, chg: +q.chg.toFixed(2), at: t };
    if (ex) Object.assign(ex, { vol: q.vol, price: q.price, chg: row.chg, lastCheck: t });
    else if (hit) keep.items.push(row);
  }
  keep.items.sort((a, b) => b.vol / (b.prevVol || 1) - a.vol / (a.prevVol || 1));
  writeJSON(file, keep, true);
  console.log(`volk: ${keep.items.length} hits`);
}

async function modeClose() {
  const h = await syncHistory(7, true);
  const ann = await syncAnnouncements();
  const uni = universe(h);
  const quotes = await misQuotes(uni);
  if (!isTradingSnapshot(quotes)) { console.log('not a trading day'); return; }

  // volume rank across listed + OTC
  const ranked = Object.values(quotes).filter((q) => q.vol > 0).sort((a, b) => b.vol - a.vol);
  const rank = {};
  ranked.forEach((q, i) => { rank[q.code] = i + 1; });
  const volk = readJSON(path.join(PUB, 'volk.json'), {});
  const volkSet = new Set(volk.date === now.date ? volk.items.map((x) => x.code) : []);

  const rows = [];
  for (const s of uni) {
    const q = quotes[s.code];
    if (!q || !(q.price > 0) || !(q.y > 0)) continue;
    const value = q.price * q.vol * 1000; // NTD
    const locked = q.u > 0 && Math.abs(q.price - q.u) < 1e-6;
    const byValue = locked && value >= WATCH.lockedValue;
    const byRank = rank[s.code] <= WATCH.topN && q.chg >= WATCH.topChg;
    if (!byValue && !byRank) continue;
    const hs = histOf(h, s.code);
    const ma60 = hs ? ma(hs.c, q.price) : null;
    if (!ma60 || q.price <= ma60) continue; // must be above 季線
    let streak = 1;
    if (hs) for (let i = hs.p.length - 1; i >= 0 && hs.p[i] != null && hs.p[i] >= WATCH.streakChg; i--) streak++;
    rows.push({
      code: s.code, name: s.name, m: s.m,
      chg: +q.chg.toFixed(2), close: q.price, vol: q.vol, value, ma60: +ma60.toFixed(2),
      locked, val: byValue, rank: byRank ? rank[s.code] : null,
      next: streak + 1, volk: volkSet.has(s.code),
    });
  }

  // 熱門族群: everything ≥9% right now
  const hotCands = uni.map((s) => quotes[s.code] && { ...s, q: quotes[s.code] }).filter((x) => x && x.q.chg >= 9);

  // news for watch rows + hot candidates (one fetch per code)
  const newsCache = {};
  const needNews = new Map([...rows.map((r) => [r.code, r.name]), ...hotCands.map((x) => [x.code, x.name])]);
  for (const [code, name] of needNews) newsCache[code] = await news(code, name, 3, 8);

  for (const r of rows) {
    r.news = newsCache[r.code] || [];
    r.ann = (ann[r.code] || []).slice(0, 4);
  }
  rows.sort((a, b) => b.chg - a.chg);
  writeJSON(path.join(PUB, 'tomorrow.json'), {
    date: now.date, scanTime: now.hm, rules: WATCH, volkDate: volk.date === now.date ? volk : null, items: rows,
  }, true);

  const hot = [];
  for (const x of hotCands) {
    const todays = (newsCache[x.code] || []).filter((n) => tw(new Date(n.pub)).date === now.date && n.themes.length);
    if (!todays.length) continue;
    hot.push({ code: x.code, name: x.name, m: x.m, chg: +x.q.chg.toFixed(2), price: x.q.price, value: x.q.price * x.q.vol * 1000, news: todays });
  }
  hot.sort((a, b) => b.chg - a.chg);
  writeJSON(path.join(PUB, 'hot.json'), { date: now.date, scanTime: tw().hm, total9: hotCands.length, items: hot }, true);
  console.log(`close: watch ${rows.length}, hot ${hot.length}/${hotCands.length}`);
}

async function modeBackfill() {
  await syncHistory(Number(process.argv[3]) || 100, now.minutes >= 14 * 60 + 30);
  await syncAnnouncements();
}

async function modePremarket() {
  await syncHistory(10);
  await syncAnnouncements();
}

const modes = { open: modeOpen, volk: modeVolK, close: modeClose, backfill: modeBackfill, premarket: modePremarket };
if (!modes[mode]) { console.error('unknown mode', mode); process.exit(1); }
await modes[mode]();
touchMeta({ [`last_${mode}`]: `${tw().date} ${tw().hm}` });
