// Trading-Bot für GitHub Actions: läuft stündlich, handelt mit virtuellen 50 €,
// schreibt STATUS.md und meldet Kaufsignale/Trades als Kommentar in einem GitHub-Issue
// (-> Push-Benachrichtigung in der GitHub-App).
// Nutzt dieselbe Strategie wie die Webseite (js/*.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state.json');
const STATUS_FILE = path.join(ROOT, 'STATUS.md');
const START_CAPITAL = 50;
const COIN_LIST = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK'];
const DRY = process.argv.includes('--dry'); // lokal testen ohne GitHub-API
const STATUS_URL = `https://github.com/${process.env.GITHUB_REPOSITORY || 'OWNER/REPO'}/blob/main/STATUS.md`;

// ---- Strategie-Code der Webseite laden
const ctx = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console });
const lib = vm.runInContext(
  ['js/indicators.js', 'js/data.js', 'js/strategy.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') +
    '\n({ Ind, COINS, Data, Strategy, Engine, CONFIG })',
  ctx
);
const { COINS, Data, Strategy, Engine, CONFIG } = lib;

// ---- Hilfen
const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);
const price = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumSignificantDigits: v < 1 ? 4 : 6 }).format(v);
const pct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} %`;
const when = (t) => new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const md = (s) => String(s).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').replace(/@/g, '@​');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* neu */ }
  return { startCapital: START_CAPITAL, createdAt: Date.now(), pf: Engine.newPortfolio(START_CAPITAL), equityHistory: [], lastAction: {}, issue: null, runs: 0 };
}

// ---- News: CryptoCompare, sonst RSS-Feeds (auf dem Server gibt es keine CORS-Probleme)
async function loadNews() {
  try {
    const n = await Data.news(process.env.CRYPTOCOMPARE_KEY || '');
    if (n.length) return { items: n, source: 'CryptoCompare' };
  } catch (e) { /* Fallback */ }
  const feeds = [
    ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
    ['Cointelegraph', 'https://cointelegraph.com/rss'],
    ['Decrypt', 'https://decrypt.co/feed'],
  ];
  const items = [];
  for (const [name, url] of feeds) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (trading-bot)' } });
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
        const get = (tag) => {
          const x = m[0].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
          return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
        };
        const t = Date.parse(get('pubDate')) || Date.now();
        items.push({ t, title: get('title'), body: get('description').slice(0, 400), url: get('link'), source: name, tags: '' });
      }
    } catch (e) { /* nächster Feed */ }
  }
  items.sort((a, b) => b.t - a.t);
  return { items, source: items.length ? 'RSS' : null };
}

// ---- GitHub-Issue für Benachrichtigungen
async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${url}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function notify(S, text) {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const msg = `@${owner}\n\n${text}`;
  if (DRY || !process.env.GITHUB_TOKEN) { console.log('--- Benachrichtigung ---\n' + msg); return; }
  if (!S.issue) {
    const iss = await gh('POST', '/issues', {
      title: '🔔 Trading-Bot: Signale & Trades',
      body: `@${owner} Hier meldet sich dein Trading-Bot, sobald er etwas kaufen oder verkaufen würde.\n\n` +
        'Den aktuellen Stand siehst du jederzeit in [STATUS.md](${STATUS_URL}).\n\n' +
        '_Papier-Trading mit virtuellem Geld – keine Anlageberatung._',
    });
    S.issue = iss.number;
  }
  await gh('POST', `/issues/${S.issue}/comments`, { body: msg });
}

// ---- Hauptlauf
(async () => {
  const S = loadState();
  const now = Date.now();
  const problems = [];
  const syms = [...new Set([...COIN_LIST, ...Object.keys(S.pf.positions)])];

  const market = {};
  for (const sym of syms) {
    try { market[sym] = await Data.candles(sym, 250, process.env.CRYPTOCOMPARE_KEY || ''); }
    catch (e) { problems.push(`${sym}: keine Kurse (${e.message})`); }
  }
  const news = await loadNews();
  if (!news.source) problems.push('Keine News abrufbar – Entscheidung nur technisch.');
  let fng = null;
  try { fng = await Data.fearGreed(); } catch (e) { problems.push('Fear & Greed nicht abrufbar.'); }

  const analysis = Strategy.analyzeNews(news.items, Object.keys(market), now);
  const prices = {}, evals = {};
  for (const [sym, m] of Object.entries(market)) {
    const closes = m.rows.map((r) => r.c);
    prices[sym] = closes[closes.length - 1];
    m.price = prices[sym];
    m.ch24 = closes.length > 24 ? (prices[sym] / closes[closes.length - 25] - 1) * 100 : 0;
    m.ev = Strategy.evaluate(closes, { news: analysis.perCoin[sym], market: analysis.market, fng: fng ? fng.value : null });
    evals[sym] = m.ev;
  }
  // Ohne Kurs für eine gehaltene Position nicht handeln (sonst falscher Depotwert)
  const missingHeld = Object.keys(S.pf.positions).filter((s) => !prices[s]);
  const canTrade = Object.keys(prices).length > 0 && !missingHeld.length;

  // Neue Kaufsignale erkennen
  const newBuys = [];
  for (const [sym, ev] of Object.entries(evals)) {
    if (S.lastAction[sym] !== ev.action && ev.action === 'KAUFEN') newBuys.push(sym);
    S.lastAction[sym] = ev.action;
  }

  // Handeln
  const executed = [];
  if (canTrade) {
    for (const o of Engine.decide(S.pf, evals, prices, now)) executed.push(Engine.execute(S.pf, o, prices[o.sym], now));
  }

  const equity = Engine.equity(S.pf, prices);
  if (canTrade) S.equityHistory.push({ t: now, v: Math.round(equity * 100) / 100 });
  S.equityHistory = S.equityHistory.slice(-2000);
  S.runs = (S.runs || 0) + 1;
  S.lastRun = now;

  // Benachrichtigung
  const lines = [];
  for (const tr of executed) {
    if (tr.side === 'BUY') lines.push(`🟢 **Gekauft: ${tr.sym}** für ${eur(tr.eur)} zu ${price(tr.price)}\n> ${md(tr.reason)}`);
    else lines.push(`🔴 **Verkauft: ${tr.sym}** für ${eur(tr.eur)} zu ${price(tr.price)} → ${tr.pnl >= 0 ? 'Gewinn' : 'Verlust'} **${tr.pnl >= 0 ? '+' : ''}${eur(tr.pnl)}**\n> ${md(tr.reason)}`);
  }
  for (const sym of newBuys) {
    if (executed.some((t) => t.sym === sym && t.side === 'BUY')) continue;
    const m = market[sym];
    const why = S.pf.positions[sym] ? 'schon im Depot' : Object.keys(S.pf.positions).length >= CONFIG.maxPositions ? 'max. Positionen erreicht' : 'gerade kein freies Geld';
    lines.push(`🔔 **Kaufsignal: ${sym}** (${COINS[sym].name}) zu ${price(m.price)}, Score ${m.ev.score} – nicht gekauft, ${why}\n> ${md(m.ev.reasons.slice(0, 3).join(' · '))}`);
  }
  if (lines.length) {
    const pnl = equity - S.startCapital;
    await notify(S, `${lines.join('\n\n')}\n\n**Depot:** ${eur(equity)} (${pnl >= 0 ? '+' : ''}${eur(pnl)}) · Bargeld ${eur(S.pf.cash)} · [Status ansehen](${STATUS_URL})`)
      .catch((e) => problems.push('Benachrichtigung fehlgeschlagen: ' + e.message));
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 1));
  fs.writeFileSync(STATUS_FILE, renderStatus(S, market, prices, equity, analysis, news, fng, problems, canTrade));
  console.log(`Lauf ${S.runs}: Depot ${eur(equity)}, ${executed.length} Trades, ${newBuys.length} neue Kaufsignale, Quellen: ${[...new Set(Object.values(market).map((m) => m.source))].join(', ')}, News: ${news.source} (${news.items.length})`);
  if (problems.length) console.log('Hinweise:\n' + problems.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });

function renderStatus(S, market, prices, equity, analysis, news, fng, problems, canTrade) {
  const pnl = equity - S.startCapital;
  const closed = S.pf.trades.filter((t) => t.side === 'SELL');
  const wins = closed.filter((t) => t.pnl > 0).length;
  const fngDe = fng ? ({ 'Extreme Fear': 'Extreme Angst', Fear: 'Angst', Neutral: 'Neutral', Greed: 'Gier', 'Extreme Greed': 'Extreme Gier' }[fng.label] || fng.label) : null;
  const act = { KAUFEN: '🟢 KAUFEN', VERKAUFEN: '🔴 VERKAUFEN', HALTEN: '⚪ HALTEN' };
  const o = [];
  o.push('# 📊 Trading-Bot – Status', '');
  o.push(`**Stand:** ${when(S.lastRun)} Uhr · aktualisiert sich stündlich · Lauf Nr. ${S.runs}`, '');
  if (!canTrade) o.push('> ⚠️ In diesem Lauf fehlten Kursdaten – es wurde nicht gehandelt.', '');
  o.push('| Depotwert | Gewinn / Verlust | Bargeld | Abgeschl. Trades | Marktstimmung |', '|---|---|---|---|---|');
  o.push(`| **${eur(equity)}** | **${pnl >= 0 ? '+' : ''}${eur(pnl)}** (${pct((pnl / S.startCapital) * 100)}) | ${eur(S.pf.cash)} | ${closed.length}${closed.length ? ` (${Math.round((wins / closed.length) * 100)} % Gewinner)` : ''} | ${fng ? `${fng.value} – ${fngDe}` : '–'} |`, '');
  o.push(`Gestartet mit ${eur(S.startCapital)} am ${new Date(S.createdAt).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}.`, '');

  o.push('## 🔔 Was der Bot jetzt kaufen würde', '');
  const buys = Object.entries(market).filter(([, m]) => m.ev.action === 'KAUFEN').sort((a, b) => b[1].ev.score - a[1].ev.score);
  if (!buys.length) o.push('Aktuell kein Kaufsignal – der Bot wartet auf eine bessere Gelegenheit.', '');
  for (const [sym, m] of buys) {
    const held = S.pf.positions[sym] ? ' ✅ im Depot' : '';
    o.push(`- **${sym}** (${COINS[sym].name}) zu ${price(m.price)} · Score **${m.ev.score}**${held}  `, `  ${md(m.ev.reasons.slice(0, 4).join(' · '))}`);
  }
  o.push('');

  o.push('## 💼 Offene Positionen', '');
  const pos = Object.entries(S.pf.positions);
  if (!pos.length) o.push('Keine – alles in Bargeld.', '');
  else {
    o.push('| Coin | Gekauft | Einstand | Aktuell | Wert | G/V |', '|---|---|---|---|---|---|');
    for (const [sym, p] of pos) {
      const cur = prices[sym] || p.avgPrice, val = p.qty * cur, g = val - p.invested;
      o.push(`| **${sym}** | ${when(p.openedAt)} | ${price(p.avgPrice)} | ${price(cur)} | ${eur(val)} | ${g >= 0 ? '🟢 +' : '🔴 '}${eur(g)} (${pct((g / p.invested) * 100)}) |`);
    }
    o.push('');
  }

  const hist = S.equityHistory.slice(-48);
  if (hist.length >= 3) {
    const vals = hist.map((h) => h.v);
    const lo = Math.floor(Math.min(...vals, S.startCapital) * 0.98), hi = Math.ceil(Math.max(...vals, S.startCapital) * 1.02);
    o.push('## 📈 Depotverlauf (letzte 48 Läufe)', '', '```mermaid', 'xychart-beta', `  y-axis "€" ${lo} --> ${hi}`,
      `  x-axis [${hist.map((h, i) => (i % 8 === 0 || i === hist.length - 1 ? `"${when(h.t).replace(',', '')}"` : '" "')).join(', ')}]`,
      `  line [${vals.join(', ')}]`, '```', '');
  }

  o.push('## 🧭 Marktübersicht', '', '| Coin | Kurs | 24h | RSI | News | Score | Empfehlung |', '|---|---|---|---|---|---|---|');
  for (const [sym, m] of Object.entries(market).sort((a, b) => b[1].ev.score - a[1].ev.score)) {
    const n = analysis.perCoin[sym];
    const ns = n && n.count ? `${n.score > 0.05 ? '▲' : n.score < -0.05 ? '▼' : '●'} ${n.count}` : '–';
    o.push(`| **${sym}** | ${price(m.price)} | ${pct(m.ch24)} | ${m.ev.ind.rsi != null ? m.ev.ind.rsi.toFixed(0) : '–'} | ${ns} | ${m.ev.score} | ${act[m.ev.action]} |`);
  }
  o.push('', 'Score ab +35 → Kaufen, ab −20 → Verkaufen. Er setzt sich zusammen aus Trend, MACD, RSI, Bollinger-Bändern, 24h-Bewegung, News-Stimmung und Fear & Greed.', '');

  o.push('## 🧾 Letzte Trades', '');
  const tr = S.pf.trades.slice(-15).reverse();
  if (!tr.length) o.push('Noch keine Trades.', '');
  else {
    o.push('| Zeit | Aktion | Coin | Betrag | Kurs | Ergebnis |', '|---|---|---|---|---|---|');
    for (const t of tr) o.push(`| ${when(t.t)} | ${t.side === 'BUY' ? '🟢 Kauf' : '🔴 Verkauf'} | ${t.sym} | ${eur(t.eur)} | ${price(t.price)} | ${t.side === 'SELL' ? `${t.pnl >= 0 ? '+' : ''}${eur(t.pnl)}` : ''} |`);
    o.push('');
  }

  o.push(`## 📰 Aktuelle News${news.source ? ` (${news.source})` : ''}`, '');
  const top = news.items.slice(0, 10);
  if (!top.length) o.push('Keine News abrufbar.', '');
  for (const n of top) {
    const s = Strategy.headlineScore(n);
    const link = /^https:\/\//.test(n.url || '') ? `[${md(n.title)}](${n.url})` : md(n.title);
    o.push(`- ${s > 0.1 ? '▲' : s < -0.1 ? '▼' : '●'} ${link} – _${md(n.source)}, ${when(n.t)}_`);
  }
  o.push('');
  if (problems.length) o.push('<details><summary>Technische Hinweise</summary>', '', ...problems.map((p) => `- ${md(p)}`), '', '</details>', '');
  o.push('---', '_Papier-Trading mit virtuellem Geld. Automatisch berechnete Signale, keine Anlageberatung. Kryptowährungen sind hochriskant._', '');
  return o.join('\n');
}
