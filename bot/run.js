// Trading-Bot für GitHub Actions: Krypto + Aktien, Long/Short mit Hebel, virtuelle 50 €.
// Schreibt bot/state.json (Depot), bot/market.json (für die Webseite), bot/backtest.json,
// STATUS.md und meldet Trades/Signale als Kommentar im GitHub-Issue (-> Push-Nachricht).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const F = { state: path.join(__dirname, 'state.json'), market: path.join(__dirname, 'market.json'), bt: path.join(__dirname, 'backtest.json'), hist: path.join(__dirname, 'history.json'), news: path.join(__dirname, 'newscache.json'), status: path.join(ROOT, 'STATUS.md') };
const START_CAPITAL = 50;
const DRY = process.argv.includes('--dry');
const REPO = process.env.GITHUB_REPOSITORY || 'OWNER/REPO';
const [OWNER, NAME] = REPO.split('/');
const STATUS_URL = `https://github.com/${REPO}/blob/data/STATUS.md`;
const SITE_URL = `https://raw.githack.com/${REPO}/main/index.html`;
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

// ---- Strategie-Code der Webseite laden
const ctx = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console });
const lib = vm.runInContext(
  ['js/assets.js', 'js/indicators.js', 'js/data.js', 'js/strategy.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') +
    '\n({ ASSETS, CRYPTO, STOCKS, Data, Strategy, Engine, CONFIG })',
  ctx
);
const { ASSETS, CRYPTO, STOCKS, Data, Strategy, Engine, CONFIG } = lib;

const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);
const price = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumSignificantDigits: v < 1 ? 4 : 6 }).format(v);
const pct = (v) => `${v > 0 ? '+' : ''}${(v ?? 0).toFixed(1).replace('.', ',')} %`;
const when = (t) => new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const md = (s) => String(s).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').replace(/@/g, '@​');
const sig = (v) => Number(v.toPrecision(6));
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const L = (s) => ASSETS[s].label;

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- Aktien über den TradingView-Screener (Yahoo/Stooq sperren GitHub-Server)
// Liefert Kurs, Tages-/Wochenveränderung, Börsenstatus und Indikatoren im Stundenraster.
const TV_COLS = ['close', 'currency', 'change', 'Perf.W', 'high', 'low', 'RSI|60', 'MACD.macd|60', 'MACD.signal|60',
  'EMA20|60', 'EMA50|60', 'BB.lower|60', 'BB.upper|60', 'Volatility.D', 'current_session'];
async function tradingView(screener, tickers, cols = TV_COLS) {
  const r = await fetch(`https://scanner.tradingview.com/${screener}/scan`, {
    method: 'POST', headers: { ...UA, 'Content-Type': 'application/json', Origin: 'https://www.tradingview.com' },
    body: JSON.stringify({ symbols: { tickers }, columns: cols }),
  });
  if (!r.ok) throw new Error(`TradingView HTTP ${r.status}`);
  const j = await r.json();
  return Object.fromEntries((j.data || []).map((x) => [x.s, Object.fromEntries(cols.map((c, i) => [c, x.d[i]]))]));
}

async function eurUsdFallback() {
  const j = await getJSON('https://api.frankfurter.app/latest?from=EUR&to=USD'); // EZB-Referenzkurs
  if (!j.rates || !j.rates.USD) throw new Error('kein Kurs');
  return j.rates.USD;
}

async function rss(url, kind, tag, source) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const get = (t) => { const x = m[0].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')).trim() : ''; };
    out.push({ t: Date.parse(get('pubDate')) || Date.now(), title: get('title'), body: get('description').slice(0, 400), url: get('link'), source, tags: tag || '', kind });
  }
  return out;
}

// News nur alle 15 Minuten neu laden (der Bot läuft alle 5 Minuten)
async function loadNewsCached(problems, now) {
  const c = loadJSON(F.news, null);
  if (c && now - c.at < 15 * 60e3 && c.items && c.items.length) return c.items;
  const items = await loadNews(problems);
  if (items.length) fs.writeFileSync(F.news, JSON.stringify({ at: now, items: items.slice(0, 300) }));
  return items.length ? items : (c && c.items) || [];
}

async function loadNews(problems) {
  let crypto = [];
  try { crypto = (await Data.news(process.env.CRYPTOCOMPARE_KEY || '')).map((n) => ({ ...n, kind: 'crypto' })); } catch (e) { /* RSS */ }
  if (!crypto.length) {
    for (const [n, u] of [['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'], ['Cointelegraph', 'https://cointelegraph.com/rss'], ['Decrypt', 'https://decrypt.co/feed']]) {
      try { crypto.push(...(await rss(u, 'crypto', '', n))); } catch (e) { /* nächster */ }
    }
  }
  const stock = [];
  for (const s of STOCKS) {
    let items = [];
    try { items = await rss(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`, 'stock', s.toUpperCase(), 'Yahoo Finance'); } catch (e) { /* Ersatz */ }
    if (!items.length) {
      try {
        const q = encodeURIComponent(`"${ASSETS[s].name}" stock`);
        items = (await rss(`https://news.google.com/rss/search?q=${q}+when:2d&hl=en-US&gl=US&ceid=US:en`, 'stock', s.toUpperCase(), 'Google News')).slice(0, 8)
          .map((n) => { const m = n.title.match(/^(.*) - ([^-]+)$/); return m ? { ...n, title: m[1], source: m[2].trim() } : n; });
      } catch (e) { /* weiter */ }
    }
    stock.push(...items);
  }
  if (!crypto.length) problems.push('Keine Krypto-News abrufbar.');
  if (!stock.length) problems.push('Keine Aktien-News abrufbar.');
  // Duplikate (gleicher Titel) zusammenführen
  const seen = new Map();
  for (const n of [...crypto, ...stock]) {
    const k = n.title.toLowerCase();
    if (seen.has(k)) { const o = seen.get(k); if (n.tags && !o.tags.split('|').includes(n.tags)) o.tags = o.tags ? `${o.tags}|${n.tags}` : n.tags; }
    else seen.set(k, { ...n });
  }
  return [...seen.values()].sort((a, b) => b.t - a.t);
}

async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${url}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${url}: ${r.status}`);
  return r.json();
}
async function notify(S, text) {
  const msg = `@${OWNER}\n\n${text}`;
  if (DRY || !process.env.GITHUB_TOKEN) { console.log('--- Benachrichtigung ---\n' + msg); return; }
  if (!S.issue) {
    const iss = await gh('POST', '/issues', { title: '🔔 Trading-Bot: Signale & Trades', body: `@${OWNER} Hier meldet sich dein Trading-Bot bei jedem Trade und Signal.\n\nWebseite: ${SITE_URL}\nStatus: ${STATUS_URL}` });
    S.issue = iss.number;
  }
  await gh('POST', `/issues/${S.issue}/comments`, { body: msg });
}

function loadJSON(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } }


// ================================================================ Hauptlauf
(async () => {
  const now = Date.now();
  const problems = [];
  let S = loadJSON(F.state, null);
  if (!S || !S.pf || S.pf.version !== 2) {
    S = { startCapital: START_CAPITAL, createdAt: now, pf: Engine.newPortfolio(START_CAPITAL), equityHistory: [], lastAction: {}, signals: [], issue: S ? S.issue : null, runs: 0, restarted: !!S };
  }
  const since = S.lastRun || now - 3600e3;

  // ---- Kurse
  const market = {};
  for (const s of CRYPTO) {
    try {
      const d = await Data.candles(s, 720, process.env.CRYPTOCOMPARE_KEY || '');
      market[s] = { rows: d.rows, source: d.source, bpd: 24, tradeable: true, off: 0 };
    } catch (e) { problems.push(`${L(s)}: keine Kurse (${e.message})`); }
  }
  let eurusd = null;
  try { eurusd = await eurUsdFallback(); } catch (e) { problems.push('EUR/USD-Kurs nicht abrufbar – US-Aktien ausgelassen.'); }
  const H = loadJSON(F.hist, {}); // eigener Kursverlauf der Aktien (TradingView liefert keine Historie)
  let tv = {};
  for (const [screener, mk] of [['america', 'US'], ['germany', 'DE']]) {
    try { Object.assign(tv, await tradingView(screener, STOCKS.filter((s) => ASSETS[s].market === mk).map((s) => ASSETS[s].tv))); }
    catch (e) { problems.push(`Aktien ${mk}: ${e.message}`); }
  }
  for (const s of STOCKS) {
    const d = tv[ASSETS[s].tv];
    if (!d || d.close == null) { if (Object.keys(tv).length) problems.push(`${L(s)}: keine Kurse`); continue; }
    const fx = d.currency === 'EUR' ? 1 : d.currency === 'USD' && eurusd ? 1 / eurusd : null;
    if (fx == null) { problems.push(`${L(s)}: Währung ${d.currency} nicht umrechenbar`); continue; }
    const p = d.close * fx;
    const h = (H[s] = (H[s] || []).filter((x) => x[0] > now - 30 * 864e5));
    const prev = h.length ? h[h.length - 1] : null;
    const open = d.current_session === 'market';
    if (!prev || open || Math.abs(prev[1] / p - 1) > 1e-6) h.push([now, sig(p)]);
    market[s] = {
      tv: d, fx, price: p, tradeable: open, source: 'TradingView', bpd: ASSETS[s].market === 'US' ? 7 : 9,
      rows: h.map(([t, c]) => ({ t, c, h: c, l: c })),
      hi: Math.max(p, prev ? prev[1] : p), lo: Math.min(p, prev ? prev[1] : p),
    };
  }
  fs.writeFileSync(F.hist, JSON.stringify(H));

  // ---- Stimmung
  let fng = null, vix = null;
  try { fng = await Data.fearGreed(); } catch (e) { problems.push('Krypto Fear & Greed nicht abrufbar.'); }
  try { const v = await tradingView('cfd', ['TVC:VIX'], ['close']); vix = v['TVC:VIX'].close; } catch (e) { problems.push('VIX nicht abrufbar.'); }
  const stockFng = vix != null ? Math.round(Math.max(0, Math.min(100, 100 - (vix - 10) * 4))) : null;
  const news = await loadNewsCached(problems, now);
  const analysis = Strategy.analyzeNews(news, Object.keys(market), now);

  // ---- Bewerten
  const evals = {}, quotes = {}, prices = {};
  for (const [s, m] of Object.entries(market)) {
    const isC = ASSETS[s].type === 'crypto';
    const ctxE = { news: analysis.perCoin[s], market: isC ? analysis.market : analysis.stockMarket, fng: isC ? (fng ? fng.value : null) : stockFng, barsPerDay: m.bpd };
    if (m.tv) {
      const d = m.tv;
      m.price = prices[s] = m.price;
      m.ev = evals[s] = Strategy.score({
        price: d.close, ema20: d['EMA20|60'], ema50: d['EMA50|60'], rsi: d['RSI|60'],
        hist: d['MACD.macd|60'] != null && d['MACD.signal|60'] != null ? d['MACD.macd|60'] - d['MACD.signal|60'] : null,
        bbLower: d['BB.lower|60'], bbUpper: d['BB.upper|60'], mom: d.change, vol: d['Volatility.D'],
      }, ctxE);
      m.ch1d = d.change; m.ch7d = d['Perf.W'];
      quotes[s] = { price: m.price, hi: m.hi, lo: m.lo, tradeable: m.tradeable };
      continue;
    }
    const closes = m.rows.map((r) => r.c);
    m.price = prices[s] = closes[closes.length - 1];
    m.ev = evals[s] = Strategy.evaluate(closes.slice(-200), ctxE);
    m.ch1d = closes.length > 24 ? (m.price / closes[closes.length - 25] - 1) * 100 : null;
    m.ch7d = closes.length > 168 ? (m.price / closes[closes.length - 169] - 1) * 100 : null;
    const recent = m.rows.filter((r) => r.t >= since - 3600e3);
    const rr = recent.length ? recent : m.rows.slice(-1);
    quotes[s] = { price: m.price, hi: Math.max(m.price, ...rr.map((r) => r.h)), lo: Math.min(m.price, ...rr.map((r) => r.l)), tradeable: m.tradeable };
  }
  const missingHeld = Object.keys(S.pf.positions).filter((s) => !prices[s]);
  if (missingHeld.length) problems.push(`Kein Kurs für gehaltene Position(en): ${missingHeld.join(', ')} – kein Handel in diesem Lauf.`);
  const canTrade = Object.keys(prices).length > 0 && !missingHeld.length;

  // ---- Signale protokollieren
  const newSignals = [];
  for (const [s, ev] of Object.entries(evals)) {
    if (S.lastAction[s] !== ev.action) {
      if (ev.action === 'KAUFEN' || ev.action === 'SHORT') newSignals.push(s);
      S.signals.unshift({ t: now, sym: s, action: ev.action, score: ev.score, lev: ev.lev, price: sig(prices[s]), reasons: ev.reasons.slice(0, 4) });
      S.lastAction[s] = ev.action;
    }
  }
  S.signals = S.signals.slice(0, 300);

  // ---- Handeln
  const executed = [];
  if (canTrade) for (const o of Engine.decide(S.pf, evals, quotes, now)) executed.push(Engine.execute(S.pf, o, now));
  const equity = Engine.equity(S.pf, prices);
  if (canTrade) S.equityHistory.push({ t: now, v: Math.round(equity * 100) / 100 });
  S.equityHistory = S.equityHistory.slice(-3000);
  S.runs = (S.runs || 0) + 1;
  S.lastRun = now;

  // ---- Backtest (1x täglich)
  let bt = loadJSON(F.bt, null);
  if (!bt || now - bt.at > 20 * 3600e3 || !bt.scope) {
    try {
      const from = now - 30 * 864e5;
      const series = Object.fromEntries(Object.entries(market).filter(([, m]) => !m.tv).map(([s, m]) => [s, m.rows.filter((r) => r.t >= from - 12 * 864e5)]));
      const res = Engine.backtest(series, START_CAPITAL, (s) => ({ barsPerDay: market[s].bpd }));
      const c = res.curve.filter((p) => p.t >= from);
      let peak = -Infinity, mdd = 0;
      c.forEach((p) => { peak = Math.max(peak, p.v); mdd = Math.max(mdd, (peak - p.v) / peak); });
      const closes = res.pf.trades.filter((t) => t.action === 'CLOSE');
      const step = Math.max(1, Math.floor(c.length / 300));
      const btcRef = market.BTC ? market.BTC.rows.filter((r) => r.t >= c[0].t) : [];
      bt = {
        at: now, scope: 'crypto', from: c[0].t, to: c[c.length - 1].t, start: c[0].v, end: c[c.length - 1].v, maxDD: mdd,
        trades: closes.length, wins: closes.filter((t) => t.pnl > 0).length, longs: closes.filter((t) => t.side === 'LONG').length, shorts: closes.filter((t) => t.side === 'SHORT').length,
        liquidations: closes.filter((t) => /Liquidation/.test(t.reason)).length, fees: res.pf.trades.reduce((a, t) => a + (t.action === 'CLOSE' ? t.fee : 0), 0),
        btcHold: btcRef.length ? (btcRef[btcRef.length - 1].c / btcRef[0].c) * START_CAPITAL : null,
        curve: c.filter((_, i) => i % step === 0 || i === c.length - 1).map((p) => [p.t, Math.round(p.v * 100) / 100]),
      };
      fs.writeFileSync(F.bt, JSON.stringify(bt));
    } catch (e) { problems.push('Backtest fehlgeschlagen: ' + e.message); }
  }

  // ---- Benachrichtigen
  const lines = [];
  if (S.restarted) { lines.push('🚀 **Upgrade:** Der Bot handelt jetzt **Krypto und Aktien**, **Long und Short mit bis zu ' + CONFIG.maxLeverage + 'x Hebel**. Neustart mit 50 €.\n\n🌐 Webseite: ' + SITE_URL); delete S.restarted; }
  if (!S.issue && !lines.length) lines.push('👋 **Dein Trading-Bot ist gestartet!**');
  for (const t of executed) {
    const dirTxt = t.side === 'SHORT' ? 'Short' : 'Long';
    if (t.action === 'OPEN') lines.push(`${t.side === 'SHORT' ? '🔻' : '🟢'} **${dirTxt} ${L(t.sym)} ${t.lev}x** – Einsatz ${eur(t.eur)} (Volumen ${eur(t.volume)}) zu ${price(t.price)}\n> ${md(t.reason)}`);
    else lines.push(`${t.pnl >= 0 ? '💰' : '🔴'} **${dirTxt} ${L(t.sym)} ${t.lev}x geschlossen** zu ${price(t.price)} → **${t.pnl >= 0 ? '+' : ''}${eur(t.pnl)}** (${pct(t.roe * 100)} auf Einsatz)\n> ${md(t.reason)}`);
  }
  for (const s of newSignals) {
    if (executed.some((t) => t.sym === s && t.action === 'OPEN')) continue;
    const ev = evals[s];
    const why = !market[s].tradeable ? 'Börse geschlossen' : S.pf.positions[s] ? 'schon im Depot' : Object.keys(S.pf.positions).length >= CONFIG.maxPositions ? 'max. Positionen erreicht' : S.pf.lastSell[s] && now - S.pf.lastSell[s] < CONFIG.cooldownH * 3600e3 ? 'Abkühlphase' : 'kein freies Geld';
    lines.push(`🔔 **${ev.action === 'SHORT' ? 'Short' : 'Kauf'}-Signal ${L(s)}** (${ASSETS[s].name}) zu ${price(prices[s])}, Score ${ev.score}, ${ev.lev}x – nicht ausgeführt: ${why}\n> ${md(ev.reasons.slice(0, 3).join(' · '))}`);
  }
  if (lines.length) {
    const pnl = equity - S.startCapital;
    await notify(S, `${lines.join('\n\n')}\n\n**Depot:** ${eur(equity)} (${pnl >= 0 ? '+' : ''}${eur(pnl)}) · [Webseite](${SITE_URL}) · [Status](${STATUS_URL})`)
      .catch((e) => problems.push('Benachrichtigung fehlgeschlagen: ' + e.message));
  }

  // ---- Daten für die Webseite
  const plan = Engine.decide(JSON.parse(JSON.stringify(S.pf)), evals, Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, { ...q, hi: q.price, lo: q.price, tradeable: true }])), now)
    .filter((o) => o.action === 'OPEN').map((o) => ({ sym: o.sym, side: o.side, lev: o.lev, margin: o.margin }));
  const out = {
    updatedAt: now, eurusd, fng, vix, stockFng, problems,
    sources: [...new Set(Object.values(market).map((m) => m.source))],
    newsMood: { crypto: analysis.market, stocks: analysis.stockMarket, count: analysis.count },
    plan,
    config: { ...CONFIG },
    assets: Object.fromEntries(Object.entries(market).map(([s, m]) => {
      const ev = m.ev, n = analysis.perCoin[s];
      const sparkRows = m.rows.filter((r) => r.t >= now - 7 * 864e5);
      return [s, {
        type: ASSETS[s].type, market: ASSETS[s].market || 'Krypto', name: ASSETS[s].name, label: L(s), cap: ASSETS[s].cap,
        price: sig(m.price), ch1d: m.ch1d, ch7d: m.ch7d, tradeable: m.tradeable, source: m.source,
        score: ev.score, action: ev.action, lev: ev.lev, reasons: ev.reasons, rsi: ev.ind.rsi, vol: ev.ind.vol,
        news: { score: n ? n.score : 0, count: n ? n.count : 0 },
        spark: sparkRows.map((r) => [r.t, sig(r.c)]),
      }];
    })),
    news: news.slice(0, 80).map((n) => ({ t: n.t, title: n.title, url: /^https:\/\//.test(n.url || '') ? n.url : null, source: n.source, kind: n.kind, score: Math.round(Strategy.headlineScore(n) * 100) / 100, syms: Object.keys(market).filter((s) => Strategy.mentions(n, s)) })),
  };
  fs.writeFileSync(F.market, JSON.stringify(out));
  fs.writeFileSync(F.state, JSON.stringify(S));
  fs.writeFileSync(F.status, renderStatus(S, out, equity, bt, canTrade));
  console.log(`Lauf ${S.runs}: Depot ${eur(equity)}, ${executed.length} Trades, ${newSignals.length} neue Signale, ${Object.keys(market).length} Kurse (${out.sources.join(', ')}), ${news.length} News`);
  if (problems.length) console.log('Hinweise:\n' + problems.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });

function renderStatus(S, M, equity, bt, canTrade) {
  const pnl = equity - S.startCapital;
  const closed = S.pf.trades.filter((t) => t.action === 'CLOSE');
  const wins = closed.filter((t) => t.pnl > 0).length;
  const A = M.assets;
  const act = { KAUFEN: '🟢 LONG', SHORT: '🔻 SHORT', VERKAUFEN: '🔴 VERKAUFEN', HALTEN: '⚪ HALTEN' };
  const tile = (v) => (v == null ? '⬜' : v >= 3 ? '🟩' : v >= 0.5 ? '🟢' : v > -0.5 ? '⚪' : v > -3 ? '🔴' : '🟥');
  const o = [];
  o.push('# 📊 Trading-Bot – Status', '', `### 🌐 [Zur Webseite mit Heatmap & Charts](${SITE_URL})`, '');
  o.push(`**Stand:** ${when(S.lastRun)} Uhr · Lauf Nr. ${S.runs} · Krypto + Aktien · Long/Short bis ${CONFIG.maxLeverage}x Hebel`, '');
  if (!canTrade) o.push('> ⚠️ In diesem Lauf fehlten Kursdaten – es wurde nicht gehandelt.', '');
  o.push('| Depotwert | Gewinn / Verlust | Frei | Abgeschl. Trades | Krypto-Stimmung | Aktien-Stimmung (VIX) |', '|---|---|---|---|---|---|');
  o.push(`| **${eur(equity)}** | **${pnl >= 0 ? '+' : ''}${eur(pnl)}** (${pct((pnl / S.startCapital) * 100)}) | ${eur(S.pf.cash)} | ${closed.length}${closed.length ? ` (${Math.round((wins / closed.length) * 100)} % Gewinner)` : ''} | ${M.fng ? M.fng.value + '/100' : '–'} | ${M.stockFng != null ? `${M.stockFng}/100 (VIX ${M.vix.toFixed(1)})` : '–'} |`, '');

  o.push('## 🔔 Was der Bot jetzt tun würde', '');
  const sigs = Object.entries(A).filter(([, a]) => a.action === 'KAUFEN' || a.action === 'SHORT').sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));
  if (!sigs.length) o.push('Kein Signal – der Bot wartet auf eine bessere Gelegenheit.', '');
  for (const [s, a] of sigs) {
    const plan = M.plan.find((p) => p.sym === s);
    o.push(`- ${act[a.action]} **${a.label}** (${a.name}) ${a.lev}x zu ${price(a.price)} · Score **${a.score}**${S.pf.positions[s] ? ' · ✅ im Depot' : plan ? ` · Einsatz ${eur(plan.margin)}` : !a.tradeable ? ' · Börse zu' : ''}  `, `  ${md(a.reasons.slice(0, 4).join(' · '))}`);
  }
  o.push('');

  o.push('## 💼 Offene Positionen', '');
  const pos = Object.entries(S.pf.positions);
  if (!pos.length) o.push('Keine – alles frei.', '');
  else {
    o.push('| Anlage | Richtung | Einsatz | Einstieg | Aktuell | G/V | Stop | Liquidation |', '|---|---|---|---|---|---|---|---|');
    for (const [s, p] of pos) {
      const cur = A[s] ? A[s].price : p.entry, val = Engine.value(p, cur), g = val - p.invested, lv = Engine.levels(p);
      o.push(`| **${L(s)}** | ${p.side === 'SHORT' ? '🔻 Short' : '🟢 Long'} ${p.lev}x | ${eur(p.invested)} | ${price(p.entry)} | ${price(cur)} | ${g >= 0 ? '+' : ''}${eur(g)} (${pct((g / p.invested) * 100)}) | ${price(lv.stop)} | ${price(lv.liq)} |`);
    }
    o.push('');
  }

  o.push('## 🗺️ Heatmap (1 Tag)', '');
  for (const type of ['crypto', 'stock']) {
    const items = Object.values(A).filter((a) => a.type === type).sort((a, b) => b.cap - a.cap);
    o.push(`**${type === 'crypto' ? 'Krypto' : 'Aktien'}:** ` + items.map((a) => `${tile(a.ch1d)} ${a.label} ${a.ch1d == null ? '' : pct(a.ch1d)}`).join(' · '), '');
  }

  o.push('## 🧭 Marktübersicht', '', '| Anlage | Kurs | 1 Tag | 7 Tage | RSI | Score | Signal | Hebel |', '|---|---|---|---|---|---|---|---|');
  for (const a of Object.values(A).sort((x, y) => y.score - x.score)) {
    o.push(`| **${a.label}** ${a.type === 'stock' && !a.tradeable ? '🌙' : ''} | ${price(a.price)} | ${a.ch1d == null ? '–' : pct(a.ch1d)} | ${a.ch7d == null ? '–' : pct(a.ch7d)} | ${a.rsi != null ? a.rsi.toFixed(0) : '–'} | ${a.score} | ${act[a.action]} | ${a.lev}x |`);
  }
  o.push('', '🌙 = Börse gerade geschlossen. Score ≥ +35 → Long, ≤ −40 → Short. Hebel 1–5x je nach Signalstärke und Schwankung.', '');

  o.push('## 🧾 Letzte Trades', '');
  const tr = S.pf.trades.slice(-15).reverse();
  if (!tr.length) o.push('Noch keine Trades.', '');
  else {
    o.push('| Zeit | Aktion | Anlage | Kurs | Ergebnis |', '|---|---|---|---|---|');
    for (const t of tr) o.push(`| ${when(t.t)} | ${t.action === 'OPEN' ? (t.side === 'SHORT' ? '🔻 Short auf' : '🟢 Long auf') : '⏹ Zu'} ${t.lev}x | ${L(t.sym)} | ${price(t.price)} | ${t.action === 'CLOSE' ? `${t.pnl >= 0 ? '+' : ''}${eur(t.pnl)} (${md(t.reason)})` : `Einsatz ${eur(t.eur)}`} |`);
    o.push('');
  }
  if (bt) o.push('## 🧪 Backtest (letzte 30 Tage)', '', `Aus 50 € wären **${eur(bt.end)}** geworden (${pct((bt.end / 50 - 1) * 100)}), ${bt.trades} Trades, ${bt.trades ? Math.round((bt.wins / bt.trades) * 100) : 0} % Gewinner, max. Rückgang ${pct(-bt.maxDD * 100)}.${bt.btcHold ? ` Zum Vergleich BTC halten: ${eur(bt.btcHold)}.` : ''}`, '');
  if (M.problems.length) o.push('<details><summary>Technische Hinweise</summary>', '', ...M.problems.map((p) => `- ${md(p)}`), '', '</details>', '');
  o.push('---', '_Papier-Trading mit virtuellem Geld. Hebel vervielfacht Gewinne und Verluste. Keine Anlageberatung._', '');
  return o.join('\n');
}
