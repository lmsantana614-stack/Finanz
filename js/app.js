// Dashboard: zeigt den Stand des Bots, der alle 30 Minuten bei GitHub läuft.
const REPO_RAW = 'https://raw.githubusercontent.com/lmsantana614-stack/Finanz/main/';
const REFRESH_MS = 5 * 60e3;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);
const price = (v) => v == null ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumSignificantDigits: v < 1 ? 4 : v < 1000 ? 5 : 7 }).format(v);
const pct = (v, d = 1) => v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d).replace('.', ',')} %`;
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${eur(Math.abs(v))}`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const when = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} Min.` : m < 1440 ? `vor ${Math.round(m / 60)} Std.` : `vor ${Math.round(m / 1440)} Tagen`; };
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SIDE = { KAUFEN: ['long', 'LONG'], SHORT: ['short', 'SHORT'], VERKAUFEN: ['sell', 'VERKAUFEN'], HALTEN: ['hold', 'HALTEN'] };

const R = { M: null, S: null, BT: null, charts: {}, group: 'all', metric: 'ch1d', newsKind: 'all' };
try { const p = JSON.parse(localStorage.getItem('fb.view') || '{}'); Object.assign(R, { group: p.group || 'all', metric: p.metric || 'ch1d', newsKind: p.newsKind || 'all' }); } catch (e) { /* egal */ }
const saveView = () => { try { localStorage.setItem('fb.view', JSON.stringify({ group: R.group, metric: R.metric, newsKind: R.newsKind })); } catch (e) { /* egal */ } };

// ---------------------------------------------------------------- Laden
async function getData(file) {
  const bust = `?t=${Math.floor(Date.now() / 60e3)}`;
  for (const base of ['', REPO_RAW]) {
    try {
      const r = await fetch(base + file + bust, { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch (e) { /* nächste Quelle */ }
  }
  return null;
}

async function load() {
  const [M, S, BT] = await Promise.all([getData('bot/market.json'), getData('bot/state.json'), getData('bot/backtest.json')]);
  if (!M || !S) {
    $('error').hidden = false;
    $('error').innerHTML = 'Die Bot-Daten konnten nicht geladen werden. Prüfe deine Internetverbindung oder öffne den <a href="https://github.com/lmsantana614-stack/Finanz/blob/main/STATUS.md" target="_blank" rel="noopener">Status bei GitHub</a>.';
    $('updated').textContent = 'Keine Daten';
    return;
  }
  $('error').hidden = true;
  Object.assign(R, { M, S, BT });
  render();
}

// ---------------------------------------------------------------- Darstellung
function render() {
  const { M, S } = R;
  const next = new Date(M.updatedAt + 30 * 60e3);
  $('updated').textContent = `Aktualisiert ${ago(M.updatedAt)} · nächster Lauf ca. ${next.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  renderDepot();
  renderSignals();
  renderTreemap();
  renderPositions();
  renderTrades();
  renderHistory();
  renderNews();
  renderBacktest();
  renderHow();
}

function prices() { return Object.fromEntries(Object.entries(R.M.assets).map(([s, a]) => [s, a.price])); }

function renderDepot() {
  const { M, S } = R;
  const eq = Engine.equity(S.pf, prices());
  const pnl = eq - S.startCapital;
  $('equity').textContent = eur(eq);
  const p = $('pnl');
  p.textContent = `${signed(pnl)} · ${pct((pnl / S.startCapital) * 100, 2)}`;
  p.className = 'pill ' + cls(pnl);
  $('since').textContent = `seit ${new Date(S.createdAt).toLocaleDateString('de-DE')} mit ${eur(S.startCapital)} Startkapital`;
  $('cash').textContent = eur(S.pf.cash);
  $('npos').textContent = `${Object.keys(S.pf.positions).length} / ${M.config.maxPositions}`;
  const closed = S.pf.trades.filter((t) => t.action === 'CLOSE');
  const wins = closed.filter((t) => t.pnl > 0).length;
  $('ntrades').textContent = closed.length;
  $('winrate').textContent = closed.length ? `${Math.round((wins / closed.length) * 100)} % mit Gewinn` : 'noch keine';
  const mood = (v) => v == null ? '–' : v <= 25 ? 'Extreme Angst' : v < 45 ? 'Angst' : v <= 55 ? 'Neutral' : v < 75 ? 'Gier' : 'Extreme Gier';
  const fc = M.fng ? M.fng.value : null;
  $('fngC').textContent = fc == null ? '–' : `${fc} · ${mood(fc)}`;
  $('fngCm').style.left = `${fc ?? 50}%`;
  $('fngS').textContent = M.stockFng == null ? '–' : `${M.stockFng} · ${mood(M.stockFng)}`;
  $('fngSm').style.left = `${M.stockFng ?? 50}%`;

  const h = S.equityHistory.length ? S.equityHistory : [{ t: S.createdAt, v: S.startCapital }];
  const pts = h.length === 1 ? [h[0], { t: Date.now(), v: eq }] : h;
  const up = pts[pts.length - 1].v >= S.startCapital;
  const color = up ? css('--up') : css('--down');
  chart('equityChart', {
    type: 'line',
    data: { labels: pts.map((x) => when(x.t)), datasets: [
      { data: pts.map((x) => x.v), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25, fill: true,
        backgroundColor: (c) => { const g = c.chart.ctx.createLinearGradient(0, 0, 0, c.chart.height); g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00'); return g; } },
      { data: pts.map(() => S.startCapital), borderColor: css('--muted'), borderDash: [3, 4], borderWidth: 1, pointRadius: 0 },
    ] },
    options: baseOpts(eur, { legend: false, xTicks: false }),
  });
}

function scoreBar(score) {
  const w = Math.min(50, Math.abs(score) / 2);
  return `<div class="scorebar"><i style="${score >= 0 ? `left:50%;width:${w}%;background:var(--up)` : `right:50%;width:${w}%;background:var(--down)`}"></i></div>`;
}

function renderSignals() {
  const { M, S } = R;
  const list = Object.entries(M.assets).filter(([, a]) => a.action === 'KAUFEN' || a.action === 'SHORT').sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));
  $('planNote').textContent = list.length ? `${list.length} Signal${list.length > 1 ? 'e' : ''} · Long ab Score +35, Short ab −40` : '';
  if (!list.length) { $('signals').innerHTML = '<div class="empty">Gerade kein Signal. Der Bot wartet auf eine bessere Gelegenheit.</div>'; return; }
  $('signals').innerHTML = list.map(([s, a]) => {
    const plan = M.plan.find((p) => p.sym === s);
    const held = S.pf.positions[s];
    const status = held ? `Im Depot: ${held.side === 'SHORT' ? 'Short' : 'Long'} ${held.lev}x`
      : !a.tradeable ? 'Börse geschlossen, handelt bei Öffnung'
      : plan ? `Würde ${eur(plan.margin)} einsetzen (${eur(plan.margin * plan.lev)} Volumen)` : 'Kein freies Geld oder max. Positionen';
    const [c, t] = SIDE[a.action];
    return `<button class="sig" data-sym="${esc(s)}">
      <div class="sig-head"><b>${esc(a.label)}</b><span class="name">${esc(a.name)}</span><span class="side ${c}">${t} ${a.lev}x</span></div>
      <div class="row gap8"><span class="mono" style="font-size:18px;font-weight:600">${price(a.price)}</span><span class="mono small ${cls(a.ch1d)}">${pct(a.ch1d)}</span><span class="mono small muted" style="margin-left:auto">Score ${a.score}</span></div>
      ${scoreBar(a.score)}
      <ul>${a.reasons.slice(0, 3).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="status ${plan && !held ? '' : 'dim'}">${esc(status)}</div>
    </button>`;
  }).join('');
}

// ---------------------------------------------------------------- Heatmap (Treemap)
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((a, b) => a + b.w, 0);
  if (!total || w <= 0 || h <= 0) return out;
  let nodes = items.map((i) => ({ ...i, ar: (i.w / total) * w * h })).sort((a, b) => b.ar - a.ar);
  const worst = (row, side) => {
    const s = row.reduce((a, r) => a + r.ar, 0);
    return Math.max(...row.map((r) => Math.max((side * side * r.ar) / (s * s), (s * s) / (side * side * r.ar))));
  };
  const place = (row) => {
    const s = row.reduce((a, r) => a + r.ar, 0);
    if (w >= h) {
      const cw = s / h; let yy = y;
      for (const r of row) { const hh = r.ar / cw; out.push({ ...r, x, y: yy, w: cw, h: hh }); yy += hh; }
      x += cw; w -= cw;
    } else {
      const rh = s / w; let xx = x;
      for (const r of row) { const ww = r.ar / rh; out.push({ ...r, x: xx, y, w: ww, h: rh }); xx += ww; }
      y += rh; h -= rh;
    }
  };
  let row = [];
  while (nodes.length) {
    const side = Math.min(w, h), n = nodes[0];
    if (!row.length || worst([...row, n], side) <= worst(row, side)) { row.push(n); nodes.shift(); }
    else { place(row); row = []; }
  }
  if (row.length) place(row);
  return out;
}

function hex2rgb(h) { const m = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)); }
function heat(v) {
  const range = R.metric === 'score' ? 70 : R.metric === 'ch7d' ? 12 : 5;
  const t = v == null ? 0 : Math.max(-1, Math.min(1, v / range));
  const mid = hex2rgb(css('--heat-mid')), end = hex2rgb(t >= 0 ? css('--heat-up') : css('--heat-down'));
  const k = Math.pow(Math.abs(t), 0.75);
  return `rgb(${mid.map((m, i) => Math.round(m + (end[i] - m) * k)).join(',')})`;
}

function renderTreemap() {
  const box = $('treemap');
  const W = box.clientWidth, H = box.clientHeight;
  const A = Object.entries(R.M.assets).map(([s, a]) => ({ s, a, w: Math.sqrt(a.cap) }));
  const groups = R.group === 'all'
    ? [['crypto', 'Krypto', 0.4], ['stock', 'Aktien', 0.6]]
    : [[R.group, R.group === 'crypto' ? 'Krypto' : 'Aktien', 1]];
  const vertical = W < 560;
  let off = 0, html = '';
  for (const [type, label, share] of groups) {
    const items = A.filter((i) => i.a.type === type);
    if (!items.length) continue;
    const gx = vertical ? 0 : off * W, gy = vertical ? off * H : 0;
    const gw = vertical ? W : W * share, gh = vertical ? H * share : H;
    off += share;
    if (groups.length > 1) html += `<span class="gl" style="left:${gx}px;top:${gy}px">${label}</span>`;
    for (const r of squarify(items, gx, gy, gw, gh)) {
      const a = r.a, v = a[R.metric];
      const size = Math.min(r.w, r.h);
      const fs = Math.max(9, Math.min(30, size / 3.6, r.w / (a.label.length * 0.68 + 0.6)));
      const showVal = r.w > 46 && r.h > 36, showName = r.w > 90 && r.h > 70, showBadge = r.w > 72 && r.h > 52;
      const pos = R.S.pf.positions[r.s];
      const valTxt = R.metric === 'score' ? (v > 0 ? '+' : '') + v : pct(v);
      html += `<button class="tile" data-sym="${esc(r.s)}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${heat(v)}"
        aria-label="${esc(a.name)} ${esc(valTxt)}">
        ${pos && showBadge ? `<span class="badge">${pos.side === 'SHORT' ? '▼' : '▲'} ${pos.lev}x</span>` : ''}
        ${a.type === 'stock' && !a.tradeable && size > 40 ? '<span class="moon" title="Börse geschlossen">●</span>' : ''}
        <span class="t-l" style="font-size:${fs}px">${esc(a.label)}</span>
        ${showVal ? `<span class="t-v" style="font-size:${Math.max(10, fs * 0.55)}px">${esc(valTxt)}</span>` : ''}
        ${showName ? `<span class="t-n">${esc(a.name)} · ${price(a.price)}</span>` : ''}
      </button>`;
    }
  }
  box.innerHTML = html;
  const lg = { ch1d: ['−5 %', '+5 %'], ch7d: ['−12 %', '+12 %'], score: ['Short −70', 'Long +70'] }[R.metric];
  $('lgLo').textContent = lg[0]; $('lgHi').textContent = lg[1];
}

// ---------------------------------------------------------------- Depot & Listen
function renderPositions() {
  const pos = Object.entries(R.S.pf.positions);
  if (!pos.length) { $('positions').innerHTML = '<div class="empty">Keine offenen Positionen. Das Geld liegt frei bereit.</div>'; return; }
  $('positions').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Anlage</th><th>Richtung</th><th>Einsatz</th><th>Einstieg</th><th>Aktuell</th><th>Gewinn/Verlust</th><th>Stop</th><th>Liquidation</th></tr></thead><tbody>${pos.map(([s, p]) => {
    const a = R.M.assets[s] || {};
    const cur = a.price ?? p.entry, val = Engine.value(p, cur), g = val - p.invested, lv = Engine.levels(p);
    return `<tr data-sym="${esc(s)}" style="cursor:pointer"><td><b>${esc(a.label || s)}</b> <span class="muted small">${esc(a.name || '')}</span></td>
      <td><span class="side ${p.side === 'SHORT' ? 'short' : 'long'}">${p.side} ${p.lev}x</span></td>
      <td class="num">${eur(p.invested)}</td><td class="num">${price(p.entry)}</td><td class="num">${price(cur)}</td>
      <td class="num ${cls(g)}">${signed(g)} <span class="small">(${pct((g / p.invested) * 100)})</span></td>
      <td class="num">${price(lv.stop)}${lv.trail != null ? ' <span class="small muted">mitlaufend</span>' : ''}</td><td class="num muted">${price(lv.liq)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

const label = (s) => (R.M.assets[s] ? R.M.assets[s].label : ASSETS[s] ? ASSETS[s].label : s);

function renderTrades() {
  const t = R.S.pf.trades.slice().reverse().slice(0, 60);
  $('trades').innerHTML = t.length ? t.map((x) => {
    const side = x.side === 'SHORT' ? 'short' : 'long';
    const head = x.action === 'OPEN'
      ? `<span class="side ${side}">${x.side} ${x.lev}x</span>`
      : `<span class="side ${x.pnl >= 0 ? 'long' : 'short'}">ZU</span>`;
    const body = x.action === 'OPEN'
      ? `<b>${esc(label(x.sym))}</b> · ${eur(x.eur)} zu <span class="mono">${price(x.price)}</span>`
      : `<b>${esc(label(x.sym))}</b> ${x.side === 'SHORT' ? 'Short' : 'Long'} ${x.lev}x zu <span class="mono">${price(x.price)}</span> · <b class="mono ${cls(x.pnl)}">${signed(x.pnl)}</b>`;
    return `<div class="item">${head}<div>${body}</div><span class="when">${when(x.t)}</span><div class="why">${esc(x.reason)}</div></div>`;
  }).join('') : '<div class="empty">Noch keine Trades.</div>';
}

function renderHistory() {
  const h = (R.S.signals || []).slice(0, 80);
  $('history').innerHTML = h.length ? h.map((x) => {
    const [c, t] = SIDE[x.action] || SIDE.HALTEN;
    return `<div class="item"><span class="side ${c}">${t}</span><div><b>${esc(label(x.sym))}</b> <span class="mono">${price(x.price)}</span> · Score ${x.score}${x.action === 'KAUFEN' || x.action === 'SHORT' ? ` · ${x.lev}x` : ''}</div><span class="when">${when(x.t)}</span><div class="why">${esc((x.reasons || []).join(' · '))}</div></div>`;
  }).join('') : '<div class="empty">Noch keine Signale.</div>';
}

function newsItem(n) {
  const d = n.score > 0.1 ? ['pos', '▲'] : n.score < -0.1 ? ['neg', '▼'] : ['', '●'];
  const tag = n.url ? 'a' : 'div';
  const attrs = n.url ? ` href="${esc(n.url)}" target="_blank" rel="noopener"` : '';
  return `<${tag} class="news"${attrs}><span class="nd ${d[0]}">${d[1]}</span><span><span class="nt">${esc(n.title)}</span>
    <span class="nm">${(n.syms || []).slice(0, 4).map((s) => `<span class="chip">${esc(label(s))}</span>`).join('')}<span>${esc(n.source)} · ${when(n.t)}</span></span></span></${tag}>`;
}

function renderNews() {
  const list = R.M.news.filter((n) => R.newsKind === 'all' || n.kind === R.newsKind);
  $('newsList').innerHTML = list.length ? list.slice(0, 50).map(newsItem).join('') : '<div class="empty">Keine News geladen.</div>';
}

function renderBacktest() {
  const b = R.BT;
  if (!b) { $('btStats').innerHTML = '<div class="empty">Der Backtest wird beim nächsten Lauf berechnet.</div>'; return; }
  const stat = (l, v, c = '', sub = '') => `<div class="stat"><span>${l}</span><b class="mono ${c}">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('btStats').innerHTML =
    stat('Aus 50 € wurden', eur(b.end), cls(b.end - 50), pct((b.end / 50 - 1) * 100)) +
    (b.btcHold ? stat('Nur BTC halten', eur(b.btcHold), cls(b.btcHold - 50), pct((b.btcHold / 50 - 1) * 100)) : '') +
    stat('Trades', b.trades, '', `${b.trades ? Math.round((b.wins / b.trades) * 100) : 0} % Gewinner · ${b.longs} Long / ${b.shorts} Short`) +
    stat('Größter Rückgang', pct(-b.maxDD * 100), 'down', `${b.liquidations} Liquidationen · Gebühren ${eur(b.fees)}`);
  chart('btChart', {
    type: 'line',
    data: { labels: b.curve.map((p) => when(p[0])), datasets: [
      { label: 'Bot-Strategie', data: b.curve.map((p) => p[1]), borderColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
      { label: 'Startkapital', data: b.curve.map(() => 50), borderColor: css('--muted'), borderDash: [3, 4], borderWidth: 1, pointRadius: 0 },
    ] },
    options: baseOpts(eur, { legend: true }),
  });
}

function renderHow() {
  const c = R.M.config;
  const p = (v) => (v * 100).toFixed(1).replace('.', ',') + ' %';
  $('howto').innerHTML = `
    <p>Alle 30 Minuten bewertet der Bot ${Object.keys(R.M.assets).length} Anlagen mit einem Score von etwa −100 bis +100. Er setzt sich aus Trend (EMA20/50), MACD, RSI, Bollinger-Bändern, der Bewegung des letzten Tages, News-Stimmung zur Anlage und zum Markt sowie dem Angst-Gier-Index zusammen (Krypto: Fear &amp; Greed, Aktien: VIX).</p>
    <ul>
      <li><b>Long</b> ab Score +${c.buyThreshold}, <b>Short</b> ab ${c.shortThreshold}. Long schließt bei ${c.sellThreshold}, Short bei +${c.coverThreshold}.</li>
      <li><b>Hebel</b> 1–${c.maxLeverage}x: je stärker das Signal, desto höher. Bei hoher Schwankung (über 4 % pro Tag) höchstens 3x, über 6 % höchstens 2x.</li>
      <li><b>Stop-Loss</b> ${p(c.stopLoss)} Kursbewegung bei 1x, enger mit Hebel (5x: ${p(c.stopLoss / Math.sqrt(5))}). <b>Gewinnmitnahme</b> bei ${p(c.takeProfit)} (5x: ${p(c.takeProfit / Math.sqrt(5))}), dazu ein mitlaufender Stop.</li>
      <li>Höchstens ${c.maxPositions} Positionen, je bis ${p(c.maxPosPct)} des Depots als Einsatz. Gebühren: ${p(c.fee)} aufs Volumen, bei Hebel/Short zusätzlich ${p(c.holdFeeHourly * 24)} pro Tag.</li>
      <li>Aktien handelt er nur zu Börsenzeiten (Xetra 9–17:30 Uhr, USA 15:30–22 Uhr). Warnmeldungen wie Hacks oder Betrug sperren Käufe.</li>
    </ul>`;
}

// ---------------------------------------------------------------- Detailansicht
function openDetail(sym) {
  const a = R.M.assets[sym];
  if (!a) return;
  const pos = R.S.pf.positions[sym];
  const [c, t] = SIDE[a.action];
  const news = R.M.news.filter((n) => (n.syms || []).includes(sym)).slice(0, 6);
  $('dBody').innerHTML = `
    <div class="eyebrow">${a.type === 'crypto' ? 'Kryptowährung' : a.market === 'DE' ? 'Aktie · Xetra' : 'Aktie · USA'}${a.type === 'stock' ? (a.tradeable ? ' · Börse offen' : ' · Börse geschlossen') : ''}</div>
    <h2 id="dTitle" style="font-size:26px">${esc(a.name)} <span class="muted">${esc(a.label)}</span></h2>
    <div class="row gap8 wrapflex" style="margin-top:6px"><span class="d-price mono">${price(a.price)}</span><span class="pill ${cls(a.ch1d)}">${pct(a.ch1d)} heute</span></div>
    <div class="d-chart"><canvas id="dChart"></canvas></div>
    <div class="row gap8"><span class="side ${c}">${t}${a.action === 'KAUFEN' || a.action === 'SHORT' ? ' ' + a.lev + 'x' : ''}</span><span class="mono">Score ${a.score}</span></div>
    <div style="margin-top:8px">${scoreBar(a.score)}</div>
    <div class="d-grid">
      <div class="stat"><span>7 Tage</span><b class="mono ${cls(a.ch7d)}">${pct(a.ch7d)}</b></div>
      <div class="stat"><span>RSI</span><b class="mono">${a.rsi != null ? a.rsi.toFixed(0) : '–'}</b></div>
      <div class="stat"><span>Schwankung</span><b class="mono">${a.vol != null ? a.vol.toFixed(1).replace('.', ',') + ' %' : '–'}</b></div>
    </div>
    ${pos ? `<p><b>Im Depot:</b> ${pos.side === 'SHORT' ? 'Short' : 'Long'} ${pos.lev}x seit ${when(pos.openedAt)}, Einstieg ${price(pos.entry)}, Stop ${price(Engine.levels(pos).stop)}.</p>` : ''}
    <h3 style="font-size:15px">Begründung</h3>
    <ul class="d-why">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>Keine starken Signale</li>'}</ul>
    <h3 style="font-size:15px;margin-top:14px">News</h3>
    ${news.length ? news.map(newsItem).join('') : '<p class="muted small">Keine aktuellen Meldungen zu dieser Anlage.</p>'}`;
  $('drawer').hidden = false;
  const s = a.spark;
  const color = (s.length && s[s.length - 1][1] >= s[0][1]) ? css('--up') : css('--down');
  const trades = R.S.pf.trades.filter((x) => x.sym === sym);
  const mark = (fn) => s.map((p, i) => {
    const nxt = s[i + 1] ? s[i + 1][0] : Infinity;
    const tr = trades.find((x) => fn(x) && x.t >= p[0] && x.t < nxt);
    return tr ? tr.price : null;
  });
  chart('dChart', {
    type: 'line',
    data: { labels: s.map((p) => when(p[0])), datasets: [
      { label: 'Kurs', data: s.map((p) => p[1]), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.15 },
      { label: 'Einstieg', data: mark((x) => x.action === 'OPEN'), showLine: false, pointRadius: 6, pointStyle: 'triangle', backgroundColor: css('--accent') },
      { label: 'Ausstieg', data: mark((x) => x.action === 'CLOSE'), showLine: false, pointRadius: 6, pointStyle: 'rectRot', backgroundColor: css('--fg') },
    ] },
    options: baseOpts(price, { legend: false }),
  });
  $('drawer').querySelector('.x').focus();
}
function closeDetail() { $('drawer').hidden = true; }

// ---------------------------------------------------------------- Charts
function baseOpts(fmt, o = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: !!o.legend, labels: { color: css('--muted'), boxWidth: 10, usePointStyle: true } },
      tooltip: { callbacks: { label: (c) => (c.raw == null ? null : `${c.dataset.label || 'Wert'}: ${fmt(c.raw)}`) } },
    },
    scales: {
      x: { display: o.xTicks !== false, ticks: { color: css('--muted'), maxTicksLimit: 5, maxRotation: 0, font: { size: 11 } }, grid: { display: false } },
      y: { position: 'right', ticks: { color: css('--muted'), callback: fmt, maxTicksLimit: 5, font: { size: 11 } }, grid: { color: css('--line') }, border: { display: false } },
    },
  };
}
function chart(id, cfg) {
  if (typeof Chart === 'undefined') return;
  if (R.charts[id]) R.charts[id].destroy();
  R.charts[id] = new Chart($(id), cfg);
}

// ---------------------------------------------------------------- Bedienung
function seg(id, key, after) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === R[key]);
    b.addEventListener('click', () => {
      R[key] = b.dataset.v; saveView();
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (R.M) after();
    });
  });
}
seg('hmGroup', 'group', renderTreemap);
seg('hmMetric', 'metric', renderTreemap);
seg('newsFilter', 'newsKind', renderNews);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closeDetail();
  const t = e.target.closest('[data-sym]');
  if (t && !e.target.closest('a')) openDetail(t.dataset.sym);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => R.M && renderTreemap(), 150); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => R.M && render());

load();
setInterval(load, REFRESH_MS);
