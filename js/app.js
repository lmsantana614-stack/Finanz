// Haupt-App: Zustand, Analysezyklus, Darstellung.
const STORE_KEY = 'finanzbot.v1';
const START_CAPITAL = 50;
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK'];

const $ = (id) => document.getElementById(id);
const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);
const price = (v) => v == null ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumSignificantDigits: v < 1 ? 4 : 6, minimumFractionDigits: v >= 1 ? 2 : undefined }).format(v);
const pct = (v, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d).replace('.', ',')} %`;
const time = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function freshState() {
  return {
    startCapital: START_CAPITAL,
    createdAt: Date.now(),
    pf: Engine.newPortfolio(START_CAPITAL),
    equityHistory: [{ t: Date.now(), v: START_CAPITAL }],
    signals: [],
    lastAction: {},
    settings: { autoTrade: true, coins: DEFAULT_COINS.slice(), interval: 5, notify: false, sound: false, apiKey: '' },
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.pf) {
      const f = freshState();
      s.settings = Object.assign(f.settings, s.settings);
      s.pf.lastSell = s.pf.lastSell || {};
      return s;
    }
  } catch (e) { /* ignorieren */ }
  return freshState();
}

let S = loadState();
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* voll/blockiert */ } };

// Laufzeitdaten (nicht gespeichert)
const R = { market: {}, news: [], newsAnalysis: null, fng: null, demo: false, lastRun: null, running: false, timer: null, selected: null, charts: {} };

// ---------------------------------------------------------------- Analysezyklus
async function cycle() {
  if (R.running) return;
  R.running = true;
  $('btnRefresh').disabled = true;
  setStatus('Analysiere Märkte …');
  const notes = [];
  try {
    const syms = [...new Set([...S.settings.coins, ...Object.keys(S.pf.positions)])];
    const key = S.settings.apiKey;

    const [candleRes, newsRes, fngRes] = await Promise.all([
      Promise.allSettled(syms.map((s) => Data.candles(s, 250, key))),
      Data.news(key).then((v) => ({ ok: v }), (e) => ({ err: e })),
      Data.fearGreed().then((v) => ({ ok: v }), (e) => ({ err: e })),
    ]);

    const okCount = candleRes.filter((r) => r.status === 'fulfilled').length;
    R.demo = okCount === 0;
    R.market = {};
    syms.forEach((s, i) => {
      const r = candleRes[i];
      if (r.status === 'fulfilled') R.market[s] = r.value;
      else if (R.demo) R.market[s] = Data.demoCandles(s, 250);
      else notes.push(`${s}: Kurse nicht abrufbar`);
    });
    if (R.demo) notes.push('Kursdaten-APIs nicht erreichbar → <b>Demo-Modus</b> mit simulierten Kursen. Es werden keine Trades ausgeführt.');

    R.news = newsRes.ok || [];
    if (newsRes.err) notes.push('News-Feed nicht erreichbar – Bot entscheidet nur technisch' + (key ? '' : ' (ggf. API-Key in den Einstellungen eintragen)') + '.');
    R.fng = fngRes.ok || null;

    const now = Date.now();
    R.newsAnalysis = Strategy.analyzeNews(R.news, Object.keys(R.market), now);

    const prices = {}, evals = {};
    for (const [sym, m] of Object.entries(R.market)) {
      const closes = m.rows.map((r) => r.c);
      prices[sym] = closes[closes.length - 1];
      const ev = Strategy.evaluate(closes, {
        news: R.newsAnalysis.perCoin[sym],
        market: R.newsAnalysis.market,
        fng: R.fng ? R.fng.value : null,
      });
      m.ev = ev;
      m.price = prices[sym];
      m.ch24 = closes.length > 24 ? (prices[sym] / closes[closes.length - 25] - 1) * 100 : 0;
      if (S.settings.coins.includes(sym)) evals[sym] = ev;
    }
    // Gehaltene, abgewählte Coins dürfen weiterhin verkauft werden
    for (const sym of Object.keys(S.pf.positions)) if (R.market[sym]) evals[sym] = R.market[sym].ev;

    // Was würde der Bot tun? (auf einer Kopie berechnen)
    const simPf = JSON.parse(JSON.stringify(S.pf));
    R.plan = Engine.decide(simPf, evals, prices, now);

    // Signale protokollieren (nur bei Wechsel der Empfehlung)
    const newBuys = [];
    for (const [sym, ev] of Object.entries(evals)) {
      if (S.lastAction[sym] !== ev.action) {
        S.signals.unshift({ t: now, sym, action: ev.action, score: ev.score, price: prices[sym], reasons: ev.reasons.slice(0, 4), demo: R.demo });
        if (ev.action === 'KAUFEN') newBuys.push(sym);
        S.lastAction[sym] = ev.action;
      }
    }
    S.signals = S.signals.slice(0, 300);

    // Automatisch handeln
    if (S.settings.autoTrade && !R.demo) {
      for (const o of Engine.decide(S.pf, evals, prices, now)) {
        const tr = Engine.execute(S.pf, o, prices[o.sym], now);
        toast(tr.side === 'BUY'
          ? `🟢 Gekauft: ${o.sym} für ${eur(tr.eur)}`
          : `🔴 Verkauft: ${o.sym} für ${eur(tr.eur)} (${tr.pnl >= 0 ? '+' : ''}${eur(tr.pnl)})`, tr.side === 'BUY' ? 'buy' : 'sell');
      }
    } else if (!R.demo) {
      // Auch ohne Auto-Handel Positions-Höchststände für Trailing-Stops nachführen
      for (const [sym, pos] of Object.entries(S.pf.positions)) if (prices[sym]) pos.peak = Math.max(pos.peak || 0, prices[sym]);
    }

    if (newBuys.length && !R.demo) alertBuys(newBuys);

    if (!R.demo) {
      const eq = Engine.equity(S.pf, prices);
      const last = S.equityHistory[S.equityHistory.length - 1];
      if (!last || now - last.t > 50e3) S.equityHistory.push({ t: now, v: eq });
      if (S.equityHistory.length > 3000) S.equityHistory = S.equityHistory.filter((_, i) => i % 2 === 0 || i > 2500);
    }
    R.prices = prices;
    R.lastRun = now;
    R.source = [...new Set(Object.values(R.market).map((m) => m.source))].join(', ');
    save();
  } catch (e) {
    console.error(e);
    notes.push('Fehler bei der Analyse: ' + esc(e.message));
  } finally {
    R.running = false;
    $('btnRefresh').disabled = false;
    banner(notes);
    render();
    schedule();
  }
}

function schedule() {
  clearTimeout(R.timer);
  R.nextRun = Date.now() + S.settings.interval * 60e3;
  R.timer = setTimeout(cycle, S.settings.interval * 60e3);
}

// ---------------------------------------------------------------- Benachrichtigungen
function alertBuys(syms) {
  const lines = syms.map((s) => {
    const plan = (R.plan || []).find((o) => o.side === 'BUY' && o.sym === s);
    return `${s} (${COINS[s].name}) zu ${price(R.market[s].price)}${plan ? ` – ca. ${eur(plan.eur)}` : ''}`;
  });
  toast('🔔 Kaufsignal: ' + lines.join(' · '), 'buy', 9000);
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Trading-Bot: Kaufsignal', { body: lines.join('\n') }); } catch (e) { /* mobil ggf. nicht erlaubt */ }
  }
  if (S.settings.sound) beep();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.16);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
  } catch (e) { /* kein Audio */ }
}

function toast(msg, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function banner(notes) {
  const b = $('banner');
  b.innerHTML = notes.map((n) => `<div>${n}</div>`).join('');
  b.classList.toggle('hidden', !notes.length);
}

function setStatus(txt) { $('status').textContent = txt; }

setInterval(() => {
  if (R.running || !R.lastRun) return;
  const left = Math.max(0, Math.round((R.nextRun - Date.now()) / 1000));
  setStatus(`Letzte Analyse ${new Date(R.lastRun).toLocaleTimeString('de-DE')} · nächste in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · Quelle: ${R.source || '–'}${R.demo ? ' (Demo)' : ''}`);
}, 1000);

// ---------------------------------------------------------------- Darstellung
function render() {
  const prices = R.prices || {};
  const eq = Engine.equity(S.pf, prices);
  const pnl = eq - S.startCapital;
  $('kEquity').textContent = eur(eq);
  $('kStart').textContent = `Start: ${eur(S.startCapital)} am ${new Date(S.createdAt).toLocaleDateString('de-DE')}`;
  $('kPnl').textContent = (pnl >= 0 ? '+' : '') + eur(pnl);
  $('kPnl').className = cls(pnl);
  $('kPnlPct').textContent = pct((pnl / S.startCapital) * 100, 2);
  $('kCash').textContent = eur(S.pf.cash);
  $('kPos').textContent = `${Object.keys(S.pf.positions).length} offene Position(en)`;
  const closed = S.pf.trades.filter((t) => t.side === 'SELL');
  const wins = closed.filter((t) => t.pnl > 0).length;
  $('kTrades').textContent = closed.length;
  $('kWin').textContent = closed.length ? `Trefferquote ${Math.round((wins / closed.length) * 100)} %` : 'noch keine';
  if (R.fng) {
    const de = { 'Extreme Fear': 'Extreme Angst', Fear: 'Angst', Neutral: 'Neutral', Greed: 'Gier', 'Extreme Greed': 'Extreme Gier' }[R.fng.label] || R.fng.label;
    $('kFng').textContent = `${R.fng.value} · ${de}`;
  } else $('kFng').textContent = '–';
  if (R.newsAnalysis) {
    const m = R.newsAnalysis.market;
    $('kNews').textContent = R.newsAnalysis.count ? `News: ${m > 0.05 ? 'positiv' : m < -0.05 ? 'negativ' : 'neutral'} (${R.newsAnalysis.count} Meldungen)` : 'News: keine Daten';
  }
  $('autoTrade').checked = S.settings.autoTrade;

  renderBuyNow();
  renderMarket();
  renderPositions(prices);
  renderTrades();
  renderSignals();
  renderNews();
  renderEquityChart();
  if (R.selected) renderCoinDetail(R.selected);
}

function renderBuyNow() {
  const el = $('buyNow');
  const entries = Object.entries(R.market).filter(([s, m]) => m.ev && m.ev.action === 'KAUFEN' && S.settings.coins.includes(s)).sort((a, b) => b[1].ev.score - a[1].ev.score);
  const sells = (R.plan || []).filter((o) => o.side === 'SELL');
  if (!R.lastRun) { el.innerHTML = '<p class="muted">Analyse läuft …</p>'; return; }
  let html = '';
  if (!entries.length) {
    html += '<p class="muted big">Aktuell kein Kaufsignal – der Bot wartet auf eine bessere Gelegenheit.</p>';
  } else {
    html += '<div class="buycards">';
    for (const [sym, m] of entries) {
      const plan = (R.plan || []).find((o) => o.side === 'BUY' && o.sym === sym);
      let status;
      if (S.pf.positions[sym]) status = '<span class="tag ok">✔ im Depot</span>';
      else if (plan && S.settings.autoTrade && !R.demo) status = `<span class="tag ok">wird gekauft: ${eur(plan.eur)}</span>`;
      else if (plan) status = `<span class="tag buy">Würde kaufen für ${eur(plan.eur)}</span>`;
      else if (S.pf.lastSell[sym] && Date.now() - S.pf.lastSell[sym] < CONFIG.cooldownH * 3600e3) status = '<span class="tag">Abkühlphase nach Verkauf</span>';
      else if (Object.keys(S.pf.positions).length >= CONFIG.maxPositions) status = '<span class="tag">Max. Positionen erreicht</span>';
      else status = '<span class="tag">Kein freies Geld</span>';
      html += `<div class="buycard" data-sym="${sym}">
        <div class="bc-head"><b>${sym}</b> <span>${COINS[sym].name}</span><span class="score s-buy">${m.ev.score}</span></div>
        <div class="bc-price">${price(m.price)} <small class="${cls(m.ch24)}">${pct(m.ch24)}</small></div>
        ${status}
        <ul>${m.ev.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>`;
    }
    html += '</div>';
  }
  if (sells.length) {
    html += `<p><b>Verkaufen würde er:</b> ${sells.map((o) => `${o.sym} – ${esc(o.reason)}`).join('<br>')}</p>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.buycard').forEach((c) => c.addEventListener('click', () => selectCoin(c.dataset.sym)));
}

function renderMarket() {
  const tb = $('market').querySelector('tbody');
  const rows = Object.entries(R.market).sort((a, b) => (b[1].ev?.score ?? -999) - (a[1].ev?.score ?? -999));
  tb.innerHTML = rows.map(([sym, m]) => {
    const ev = m.ev || { score: 0, action: 'HALTEN', ind: {} };
    const n = R.newsAnalysis?.perCoin[sym];
    const ns = n && n.count ? `<span class="${cls(n.score)}">${n.score > 0.05 ? '▲' : n.score < -0.05 ? '▼' : '●'} ${n.count}</span>` : '<span class="muted">–</span>';
    const w = Math.min(100, Math.abs(ev.score));
    const act = { KAUFEN: 'buy', VERKAUFEN: 'sell', HALTEN: 'hold' }[ev.action];
    return `<tr data-sym="${sym}" class="${R.selected === sym ? 'sel' : ''}">
      <td><b>${sym}</b> <span class="muted">${COINS[sym].name}</span>${S.pf.positions[sym] ? ' <span class="tag ok">Depot</span>' : ''}</td>
      <td>${price(m.price)}</td>
      <td class="${cls(m.ch24)}">${pct(m.ch24)}</td>
      <td>${ev.ind.rsi != null ? ev.ind.rsi.toFixed(0) : '–'}</td>
      <td>${ns}</td>
      <td><div class="bar"><span class="${ev.score >= 0 ? 'bp' : 'bn'}" style="width:${w / 2}%;${ev.score >= 0 ? 'left:50%' : `right:50%`}"></span></div><small>${ev.score}</small></td>
      <td><span class="act ${act}">${ev.action}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">Noch keine Daten</td></tr>';
  tb.querySelectorAll('tr[data-sym]').forEach((tr) => tr.addEventListener('click', () => selectCoin(tr.dataset.sym)));
}

function selectCoin(sym) {
  R.selected = R.selected === sym ? null : sym;
  renderMarket();
  if (R.selected) { renderCoinDetail(sym); $('coinDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  else $('coinDetail').classList.add('hidden');
}

function renderCoinDetail(sym) {
  const m = R.market[sym];
  if (!m) return;
  $('coinDetail').classList.remove('hidden');
  $('cdTitle').innerHTML = `${sym} – ${COINS[sym].name}: <span class="act ${{ KAUFEN: 'buy', VERKAUFEN: 'sell', HALTEN: 'hold' }[m.ev.action]}">${m.ev.action}</span> (Score ${m.ev.score})`;
  $('cdReasons').innerHTML = m.ev.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>Keine starken Signale</li>';
  const n = R.newsAnalysis?.perCoin[sym];
  $('cdNews').innerHTML = n && n.headlines.length
    ? '<h4>News zu ' + sym + '</h4>' + n.headlines.map(newsItem).join('')
    : '<p class="muted">Keine aktuellen News zu diesem Coin.</p>';

  const rows = m.rows.slice(-168);
  const closes = m.rows.map((r) => r.c);
  const e20 = Ind.ema(closes, 20).slice(-168), e50 = Ind.ema(closes, 50).slice(-168);
  const labels = rows.map((r) => time(r.t));
  // Jeden Trade der Kerze zuordnen, in deren Stunde er stattfand
  const tradePts = (side) => {
    const pts = rows.map(() => null);
    for (const tr of S.pf.trades) {
      if (tr.sym !== sym || tr.side !== side || tr.t < rows[0].t) continue;
      let idx = rows.length - 1;
      while (idx > 0 && rows[idx].t > tr.t) idx--;
      pts[idx] = tr.price;
    }
    return pts;
  };
  drawChart('coinChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Kurs', data: rows.map((r) => r.c), borderColor: cssVar('--accent'), borderWidth: 2, pointRadius: 0, tension: 0.1 },
        { label: 'EMA20', data: e20, borderColor: cssVar('--c2'), borderWidth: 1, pointRadius: 0 },
        { label: 'EMA50', data: e50, borderColor: cssVar('--c3'), borderWidth: 1, pointRadius: 0 },
        { label: 'Kauf', data: tradePts('BUY'), showLine: false, pointRadius: 7, pointStyle: 'triangle', backgroundColor: cssVar('--pos'), borderColor: cssVar('--pos') },
        { label: 'Verkauf', data: tradePts('SELL'), showLine: false, pointRadius: 7, pointStyle: 'triangle', rotation: 180, backgroundColor: cssVar('--neg'), borderColor: cssVar('--neg') },
      ],
    },
    options: chartOpts((v) => price(v)),
  });
}

function renderPositions(prices) {
  const pos = Object.entries(S.pf.positions);
  if (!pos.length) { $('positions').innerHTML = '<p class="muted">Keine offenen Positionen – alles in Bargeld.</p>'; return; }
  $('positions').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Coin</th><th>Einstand</th><th>Aktuell</th><th>Wert</th><th>G/V</th></tr></thead><tbody>${pos.map(([sym, p]) => {
    const cur = prices[sym] || p.avgPrice;
    const val = p.qty * cur, g = val - p.invested;
    return `<tr><td><b>${sym}</b><br><small class="muted">${p.qty.toPrecision(5)} Stk. · seit ${time(p.openedAt)}</small></td>
      <td>${price(p.avgPrice)}</td><td>${price(cur)}</td><td>${eur(val)}</td>
      <td class="${cls(g)}">${g >= 0 ? '+' : ''}${eur(g)}<br><small>${pct((g / p.invested) * 100)}</small></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderTrades() {
  const t = S.pf.trades.slice().reverse();
  $('trades').innerHTML = t.length ? t.map((tr) => `<div class="logrow">
    <span class="act ${tr.side === 'BUY' ? 'buy' : 'sell'}">${tr.side === 'BUY' ? 'KAUF' : 'VERKAUF'}</span>
    <b>${tr.sym}</b> ${eur(tr.eur)} @ ${price(tr.price)}
    ${tr.side === 'SELL' ? `<b class="${cls(tr.pnl)}">${tr.pnl >= 0 ? '+' : ''}${eur(tr.pnl)}</b>` : ''}
    <small class="muted">${time(tr.t)}</small>
    <div class="muted small">${esc(tr.reason)}</div></div>`).join('') : '<p class="muted">Noch keine Trades.</p>';
}

function renderSignals() {
  $('signals').innerHTML = S.signals.length ? S.signals.slice(0, 80).map((s) => `<div class="logrow">
    <span class="act ${{ KAUFEN: 'buy', VERKAUFEN: 'sell', HALTEN: 'hold' }[s.action]}">${s.action}</span>
    <b>${s.sym}</b> @ ${price(s.price)} · Score ${s.score}${s.demo ? ' <span class="tag">Demo</span>' : ''}
    <small class="muted">${time(s.t)}</small>
    <div class="muted small">${s.reasons.map(esc).join(' · ')}</div></div>`).join('') : '<p class="muted">Noch keine Signale.</p>';
}

function newsItem(n) {
  const s = n.score ?? Strategy.headlineScore(n);
  return `<a class="news ${s > 0.1 ? 'npos' : s < -0.1 ? 'nneg' : ''}" href="${esc(n.url)}" target="_blank" rel="noopener">
    <span class="nscore">${s > 0.1 ? '▲' : s < -0.1 ? '▼' : '●'}</span>
    <span><b>${esc(n.title)}</b><br><small class="muted">${esc(n.source)} · ${time(n.t)}</small></span></a>`;
}

function renderNews() {
  $('news').innerHTML = R.news.length ? R.news.slice(0, 40).map(newsItem).join('') : '<p class="muted">Keine News geladen.</p>';
}

function renderEquityChart() {
  const h = S.equityHistory;
  drawChart('equityChart', {
    type: 'line',
    data: {
      labels: h.map((p) => time(p.t)),
      datasets: [
        { label: 'Depotwert', data: h.map((p) => p.v), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent-soft'), fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Startkapital', data: h.map(() => S.startCapital), borderColor: cssVar('--muted'), borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: chartOpts((v) => eur(v)),
  });
}

// ---------------------------------------------------------------- Charts
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function chartOpts(fmt) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: cssVar('--muted'), boxWidth: 12 } },
      tooltip: { callbacks: { label: (c) => c.raw == null ? null : `${c.dataset.label}: ${fmt(c.raw)}` } },
    },
    scales: {
      x: { ticks: { color: cssVar('--muted'), maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
      y: { ticks: { color: cssVar('--muted'), callback: fmt }, grid: { color: cssVar('--grid') } },
    },
  };
}

function drawChart(id, cfg) {
  if (typeof Chart === 'undefined') return;
  if (R.charts[id]) R.charts[id].destroy();
  R.charts[id] = new Chart($(id), cfg);
}

// ---------------------------------------------------------------- Backtest
async function runBacktest() {
  const btn = $('btnBacktest');
  btn.disabled = true; btn.textContent = 'Lade historische Daten …';
  const syms = S.settings.coins;
  let demo = false;
  const series = {};
  const res = await Promise.allSettled(syms.map((s) => Data.candles(s, 2000, S.settings.apiKey)));
  res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.rows.length > 200) series[syms[i]] = r.value.rows; });
  if (!Object.keys(series).length) { demo = true; syms.forEach((s) => (series[s] = Data.demoCandles(s, 2000).rows)); }
  btn.textContent = 'Rechne …';
  await new Promise((r) => setTimeout(r, 20));
  const { pf, curve, hold } = Engine.backtest(series, START_CAPITAL);
  const end = curve[curve.length - 1].v;
  const sells = pf.trades.filter((t) => t.side === 'SELL');
  const wins = sells.filter((t) => t.pnl > 0).length;
  let peak = -Infinity, mdd = 0;
  curve.forEach((p) => { peak = Math.max(peak, p.v); mdd = Math.max(mdd, (peak - p.v) / peak); });
  const holdEnd = hold[hold.length - 1].v;
  const days = Math.round((curve[curve.length - 1].t - curve[0].t) / 864e5);
  $('btResult').innerHTML = `
    ${demo ? '<p class="warn">Keine echten Kursdaten erreichbar – Backtest mit simulierten Demo-Kursen.</p>' : ''}
    <div class="kpis small">
      <div class="kpi"><label>Endwert nach ${days} Tagen</label><b class="${cls(end - START_CAPITAL)}">${eur(end)}</b><small>${pct((end / START_CAPITAL - 1) * 100)}</small></div>
      <div class="kpi"><label>Vergleich: nur BTC halten</label><b>${eur(holdEnd)}</b><small>${pct((holdEnd / START_CAPITAL - 1) * 100)}</small></div>
      <div class="kpi"><label>Trades</label><b>${sells.length}</b><small>Trefferquote ${sells.length ? Math.round((wins / sells.length) * 100) : 0} %</small></div>
      <div class="kpi"><label>Max. Rückgang</label><b class="neg">${pct(-mdd * 100)}</b><small>Gebühren: ${eur(pf.trades.reduce((a, t) => a + t.fee, 0))}</small></div>
    </div>`;
  const step = Math.max(1, Math.floor(curve.length / 400));
  const c = curve.filter((_, i) => i % step === 0), hh = hold.filter((_, i) => i % step === 0);
  drawChart('btChart', {
    type: 'line',
    data: {
      labels: c.map((p) => time(p.t)),
      datasets: [
        { label: 'Bot-Strategie', data: c.map((p) => p.v), borderColor: cssVar('--accent'), borderWidth: 2, pointRadius: 0 },
        { label: 'BTC halten', data: hh.map((p) => p.v), borderColor: cssVar('--c3'), borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: chartOpts((v) => eur(v)),
  });
  btn.disabled = false; btn.textContent = 'Backtest erneut starten';
}

// ---------------------------------------------------------------- Einstellungen
function openSettings() {
  $('coinPicker').innerHTML = Object.entries(COINS).map(([s, c]) =>
    `<label class="chip"><input type="checkbox" value="${s}" ${S.settings.coins.includes(s) ? 'checked' : ''}> ${s} <small>${c.name}</small></label>`).join('');
  $('interval').value = String(S.settings.interval);
  $('notify').checked = S.settings.notify;
  $('sound').checked = S.settings.sound;
  $('apiKey').value = S.settings.apiKey;
  $('settings').showModal();
}

function wire() {
  $('btnRefresh').addEventListener('click', cycle);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnBacktest').addEventListener('click', () => runBacktest().catch((e) => { $('btResult').innerHTML = `<p class="warn">Backtest fehlgeschlagen: ${esc(e.message)}</p>`; $('btnBacktest').disabled = false; }));
  $('autoTrade').addEventListener('change', (e) => { S.settings.autoTrade = e.target.checked; save(); if (e.target.checked) cycle(); });
  $('notify').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; toast('Benachrichtigungen wurden vom Browser blockiert.'); }
    }
  });
  $('settings').addEventListener('close', () => {
    const coins = [...$('coinPicker').querySelectorAll('input:checked')].map((i) => i.value);
    S.settings.coins = coins.length ? coins : DEFAULT_COINS.slice();
    S.settings.interval = Number($('interval').value);
    S.settings.notify = $('notify').checked;
    S.settings.sound = $('sound').checked;
    S.settings.apiKey = $('apiKey').value.trim();
    save();
    cycle();
  });
  $('btnReset').addEventListener('click', () => {
    if (!confirm('Depot, Trades und Signale löschen und mit 50 € neu starten?')) return;
    const settings = S.settings;
    S = freshState(); S.settings = settings; save();
    $('settings').close();
  });
  $('btnExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }));
    a.download = `tradingbot-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  document.addEventListener('visibilitychange', () => {
    // Nach Rückkehr in den Tab sofort aktualisieren, falls überfällig
    if (!document.hidden && R.nextRun && Date.now() > R.nextRun) cycle();
  });
}

wire();
render();
cycle();
