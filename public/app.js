(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (n) => (n == null || isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${+Number(n).toFixed(2)}%`);
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'muted');
  const yi = (v) => `${(v / 1e8).toFixed(2)} 億`;
  const price = (p) => (p >= 100 ? fmt(p, p % 1 ? 1 : 0) : +Number(p).toFixed(2)).toString();
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (m < 60) return `${m} 分鐘前`;
    if (m < 1440) return `${Math.round(m / 60)} 小時前`;
    return `${Math.round(m / 1440)} 天前`;
  };

  const state = {
    data: { today: null, tomorrow: null, hot: null, meta: null, volk: null },
    f: { chg: 7, vol: 7000, gapOnly: false, all: false },
    sort: 'big', filter: 'all', open: new Set(), hotOpen: new Set(),
    live: {},
  };

  async function load() {
    const get = (f) => fetch(`data/${f}?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [today, tomorrow, hot, meta, volk] = await Promise.all(['today.json', 'tomorrow.json', 'hot.json', 'meta.json', 'volk.json'].map(get));
    Object.assign(state.data, { today, tomorrow, hot, meta, volk });
    if (meta?.lastCheck) $('#lastCheck').textContent = `最後檢查 ${meta.lastCheck.slice(11)}`;
    renderAll();
    liveQuotes();
  }

  // ---------- 今日開盤 ----------
  function todayRows() {
    const d = state.data.today;
    if (!d) return [];
    const { chg, vol, gapOnly, all } = state.f;
    return d.items.filter((x) => (all || (x.chg >= chg && x.vol >= vol)) && (!gapOnly || x.gap));
  }
  function renderToday() {
    const d = state.data.today;
    const rows = todayRows();
    $('#cntToday').textContent = rows.length;
    $('#sMatch').textContent = rows.length;
    $('#sGap').textContent = rows.filter((x) => x.gap).length;
    $('#sScanned').textContent = fmt(d?.scanned || 0);
    if (d) {
      const [, mm, dd] = d.date.split('-');
      const [h, m] = (d.dataTime || d.scanTime).split(':').map(Number);
      $('#sTime').textContent = `${mm}/${dd} ${h < 12 ? '上午' : '下午'} ${h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')}`;
    }
    $('#subChg').textContent = state.f.all ? d?.floor?.chg ?? 3 : state.f.chg;
    $('#subVol').textContent = fmt(state.f.all ? d?.floor?.vol ?? 1000 : state.f.vol);
    const late = d && d.scanTime > '09:16:00';
    $('#todayBody').innerHTML = rows.length ? rows.map((x) => {
      const live = state.live[x.code];
      const cur = live?.price ?? null;
      const ref = cur ?? x.price;
      const toLimit = x.limitUp > 0 && ref > 0 ? Math.max(0, ((x.limitUp - ref) / ref) * 100) : null;
      const notes = [];
      if (x.gap) notes.push(`🚀 跳空 ${pct(x.gapPct)}`);
      if (late) notes.push(`${d.scanTime} 掃描，量已含 09:15 之後`);
      return `<tr>
        <td class="code">${esc(x.code)}</td><td>${esc(x.name)}</td>
        <td class="${cls(x.chg)}">${pct(x.chg)}</td>
        <td class="${cls(live?.chg)}">${live?.chg != null && live.d === d.date.replace(/-/g, '') ? pct(live.chg) : '—'}</td>
        <td>${fmt(x.vol)} 張</td>
        <td>${toLimit == null ? '—' : `${+toLimit.toFixed(2)}%`}</td>
        <td class="note">${esc(notes.join('；'))}</td></tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">${d ? '沒有符合條件的股票' : '尚無資料（每個交易日 09:15 掃描）'}</td></tr>`;
    $$('#presets .btn').forEach((b) => b.classList.toggle('on', b.dataset.p === (state.f.all ? 'all' : `${state.f.chg},${state.f.vol}`)));
    $('#gapOnly').classList.toggle('on', state.f.gapOnly);
  }

  // ---------- 明日觀察 ----------
  function tmRows() {
    const d = state.data.tomorrow;
    if (!d) return [];
    let rows = d.items.slice();
    if (state.filter === 'second') rows = rows.filter((x) => x.next === 2);
    if (state.filter === 'big') rows = rows.filter((x) => x.value >= 1e9);
    const by = {
      chg: (a, b) => b.chg - a.chg,
      vol: (a, b) => b.vol - a.vol,
      value: (a, b) => b.value - a.value,
      volk: (a, b) => (b.volk - a.volk) || (b.chg - a.chg),
      big: (a, b) => ((b.value >= 1e9) - (a.value >= 1e9)) || (b.chg - a.chg),
    }[state.sort];
    return rows.sort(by);
  }
  function detail(x) {
    const ann = (x.ann || []).length ? `<div class="ann"><b>公司重訊</b>${x.ann.map((a) => `
      <div>· ${esc(a.date.slice(5))} ${esc(a.time)} ${esc(a.subject)} <a href="https://mops.twse.com.tw/mops/#/web/t05st01" target="_blank" rel="noopener">原文</a></div>
      ${a.summary ? `<div class="s">摘要：${esc(a.summary)}</div>` : ''}`).join('')}</div>` : '';
    const news = (x.news || []).length ? `<ul class="news">${x.news.map(newsLi).join('')}</ul>` : '<div class="muted">近三日沒有相關新聞</div>';
    return ann + news;
  }
  const newsLi = (n) => `<li><span class="score ${n.score > 0 ? 'p' : n.score < 0 ? 'n' : ''}">${n.score > 0 ? '+' : ''}${n.score}</span><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>${(n.themes || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span class="meta">${ago(n.pub)} · ${esc(n.source)}</span></li>`;

  function renderTomorrow() {
    const d = state.data.tomorrow;
    $('#cntTomorrow').textContent = d ? d.items.length : 0;
    if (d) {
      const big = d.items.filter((x) => x.value >= 1e9).length;
      const second = d.items.filter((x) => x.next === 2).length;
      $('#tmDesc').innerHTML = `${esc(d.date)} 收盤：鎖漲停且成交值 ≥ 3 億，或成量排行前 100 名且漲幅 ≥ 9%；都要在季線上。共 <b>${d.items.length}</b> 檔，其中 <b>${big}</b> 檔成交值 ≥ 10 億、<b>${second}</b> 檔明天正好是第 2 根。`;
    } else $('#tmDesc').textContent = '尚無資料（每個交易日收盤後掃描）';
    const rows = tmRows();
    let html = '';
    rows.forEach((x, i) => {
      const isBig = x.value >= 1e9;
      if (state.sort === 'big' && !isBig && i > 0 && rows[i - 1].value >= 1e9) {
        html += '<tr class="divider"><td colspan="7">以下成交值未達 10 億</td></tr>';
      }
      const open = state.open.has(x.code);
      html += `<tr class="clickable ${isBig ? 'big' : ''}" data-code="${esc(x.code)}">
        <td class="code">${esc(x.code)}</td>
        <td>${esc(x.name)}${x.val ? '<span class="badge b-val">值</span>' : ''}${x.rank ? `<span class="badge b-rank">量${x.rank}</span>` : ''}${x.volk ? '<span class="badge b-volk">量增K</span>' : ''}</td>
        <td><span class="streak ${x.next === 2 ? 's2' : ''}">明天第 ${x.next} 根</span></td>
        <td class="num ${cls(x.chg)}">${pct(x.chg)}</td>
        <td class="num">${price(x.close)}</td>
        <td class="num">${fmt(x.vol)} 張</td>
        <td class="num valcell">${yi(x.value)}<span class="caret">${open ? '▾' : '▸'}</span></td></tr>`;
      if (open) html += `<tr class="detail"><td colspan="7">${detail(x)}</td></tr>`;
    });
    $('#tmBody').innerHTML = html || '<tr><td colspan="7" class="empty">沒有資料</td></tr>';
    $$('[data-sort]').forEach((b) => b.classList.toggle('on', b.dataset.sort === state.sort));
    $$('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));

    const v = state.data.volk;
    $('#volkBox').innerHTML = v && v.items.length ? `<div class="sec-title">量增K（${esc(v.date)}，掃描 ${esc(v.scans.join('、'))}）</div>
      <div class="card tbl"><div class="tbl-scroll"><table><thead><tr><th>代號</th><th>名稱</th><th class="num">昨漲幅</th><th class="num">昨量</th><th class="num">今量</th><th class="num">今漲幅</th><th class="num">現價</th></tr></thead><tbody>
      ${v.items.map((x) => `<tr><td class="code">${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num up">${pct(x.prevChg)}</td><td class="num">${fmt(x.prevVol)} 張</td><td class="num warn">${fmt(x.vol)} 張</td><td class="num ${cls(x.chg)}">${pct(x.chg)}</td><td class="num">${price(x.price)}</td></tr>`).join('')}
      </tbody></table></div></div>` : '';
  }

  // ---------- 熱門族群漲停 ----------
  function renderHot() {
    const d = state.data.hot;
    $('#cntHot').textContent = d ? d.items.length : 0;
    $('#hotDesc').innerHTML = d ? `${esc(d.date)} ｜ 熱門族群新聞匯流最後掃描 ${esc(d.date)} ${esc(d.scanTime)}，目前漲幅 ≥ 9% 共 <b>${d.items.length}</b> 檔` : '尚無資料';
    $('#hotList').innerHTML = d && d.items.length ? d.items.map((x) => {
      const open = state.hotOpen.has(x.code);
      return `<div class="card hot">
        <div class="hot-h" data-hot="${esc(x.code)}">
          <div><b style="font-size:16px">${esc(x.code)}</b> <span class="muted" style="font-size:15px">${esc(x.name)}</span> <span class="meta">${x.news.length} 則新聞</span></div>
          <div><div class="k">漲幅</div><div class="v ${cls(x.chg)}">${pct(x.chg)}</div></div>
          <div><div class="k">現價</div><div class="v">${price(x.price)} 元</div></div>
          <div><div class="k">成交值</div><div class="v">${yi(x.value)}</div></div>
          <div class="caret">${open ? '▾' : '▸'}</div>
        </div>
        ${open ? `<div class="hot-b"><div class="muted">${esc(d.date)} 相關熱門族群新聞</div><ul>${x.news.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>${n.themes.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span class="meta">${ago(n.pub)} · ${esc(n.source)}</span></li>`).join('')}</ul></div>` : ''}
      </div>`;
    }).join('') : '<div class="card empty">目前沒有符合的熱門族群漲停股</div>';
  }

  function renderAll() { renderToday(); renderTomorrow(); renderHot(); }

  // ---------- live 現價 (via /api/quotes during market hours) ----------
  async function liveQuotes() {
    const d = state.data.today;
    if (!d || !d.items.length) return;
    const codes = todayRows().slice(0, 150).map((x) => `${x.m}_${x.code}`);
    if (!codes.length) return;
    try {
      const j = await fetch(`/api/quotes?codes=${codes.join(',')}`).then((r) => r.json());
      Object.assign(state.live, j.quotes || {});
      renderToday();
    } catch { /* api unavailable (e.g. opened as static file) */ }
  }
  setInterval(() => {
    const h = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
    if (+h >= 9 && +h < 14 && !document.hidden) liveQuotes();
  }, 60000);

  // ---------- events ----------
  function setTab(t) {
    if (!['today', 'tomorrow', 'hot'].includes(t)) t = 'today';
    $$('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
    ['today', 'tomorrow', 'hot'].forEach((k) => { $(`#view-${k}`).hidden = k !== t; });
    if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`);
  }
  $$('.tab').forEach((x) => x.addEventListener('click', () => setTab(x.dataset.tab)));
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
  setTab(location.hash.slice(1));

  $('#apply').addEventListener('click', () => {
    state.f.chg = parseFloat($('#fChg').value) || 0;
    state.f.vol = parseFloat($('#fVol').value) || 0;
    state.f.all = false;
    renderToday(); liveQuotes();
  });
  $$('#presets .btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.p === 'all') state.f.all = true;
    else {
      const [c, v] = b.dataset.p.split(',').map(Number);
      Object.assign(state.f, { chg: c, vol: v, all: false });
      $('#fChg').value = c; $('#fVol').value = v;
    }
    renderToday(); liveQuotes();
  }));
  $('#gapOnly').addEventListener('click', () => { state.f.gapOnly = !state.f.gapOnly; renderToday(); });
  $$('[data-sort]').forEach((b) => b.addEventListener('click', () => { state.sort = b.dataset.sort; renderTomorrow(); }));
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderTomorrow(); }));
  $('#tmBody').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-code]');
    if (!tr) return;
    const c = tr.dataset.code;
    state.open.has(c) ? state.open.delete(c) : state.open.add(c);
    renderTomorrow();
  });
  $('#hotList').addEventListener('click', (e) => {
    const h = e.target.closest('[data-hot]');
    if (!h) return;
    const c = h.dataset.hot;
    state.hotOpen.has(c) ? state.hotOpen.delete(c) : state.hotOpen.add(c);
    renderHot();
  });
  $('#refresh').addEventListener('click', load);

  load();
})();
