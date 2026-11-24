// Strategie: technische Analyse + News-Stimmung + Angst/Gier -> Score -> Long/Short mit Hebel.

const CONFIG = {
  buyThreshold: 35,      // Score ab dem LONG gegangen wird
  sellThreshold: -20,    // Long wird geschlossen
  shortThreshold: -40,   // Score ab dem SHORT gegangen wird
  coverThreshold: 20,    // Short wird geschlossen
  allowShort: true,
  maxLeverage: 5,        // höchster Hebel (nur bei sehr starken Signalen und ruhigem Markt)
  // Risiko bei 1x Hebel – wird mit 1/√Hebel enger (5x: Stop-Loss −2,7 % Kurs = −13 % Einsatz)
  stopLoss: 0.06,
  takeProfit: 0.15,
  trailStart: 0.05,
  trailPct: 0.04,
  maintenance: 0.1,      // Liquidation, wenn nur noch 10 % des Einsatzes übrig sind
  maxPosPct: 0.3,        // max. 30 % des Depots als Einsatz pro Position
  maxPositions: 4,
  fee: 0.001,            // 0,1 % auf das Handelsvolumen (inkl. Hebel) pro Kauf/Verkauf
  holdFeeHourly: 0.00001, // 0,024 %/Tag aufs Volumen für Hebel- und Short-Positionen
  minOrder: 5,
  cooldownH: 6,
};

const POS_WORDS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'bull', 'bullish', 'gain', 'gains', 'jump', 'jumps',
  'record', 'all-time high', 'ath', 'approval', 'approved', 'approves', 'adoption', 'partnership', 'partners', 'upgrade', 'upgrades',
  'launch', 'launches', 'inflow', 'inflows', 'breakout', 'rebound', 'recover', 'recovers', 'recovery', 'climb', 'climbs',
  'buy', 'buys', 'accumulate', 'accumulation', 'optimism', 'optimistic', 'outperform', 'boost', 'boosts', 'milestone',
  'integration', 'institutional', 'rate cut', 'skyrocket', 'spike', 'beats', 'beat estimates', 'strong demand', 'raises guidance',
  'profit', 'growth', 'expands', 'wins', 'deal'];
const NEG_WORDS = ['crash', 'crashes', 'plunge', 'plunges', 'bear', 'bearish', 'drop', 'drops', 'fall', 'falls', 'slump',
  'hack', 'hacked', 'exploit', 'exploited', 'lawsuit', 'sue', 'sues', 'ban', 'bans', 'fraud', 'outflow', 'outflows',
  'sell-off', 'selloff', 'liquidation', 'liquidations', 'dump', 'dumps', 'decline', 'declines', 'warning', 'warns', 'scam',
  'bankrupt', 'bankruptcy', 'investigation', 'delist', 'delisting', 'tumble', 'tumbles', 'fear', 'sink', 'sinks',
  'rate hike', 'crackdown', 'loss', 'losses', 'collapse', 'vulnerability', 'stolen', 'misses', 'downgrade', 'downgrades',
  'cuts guidance', 'layoffs', 'recall', 'probe', 'antitrust', 'tariff', 'tariffs', 'weak'];
const RED_FLAGS = ['hack', 'hacked', 'exploit', 'exploited', 'stolen', 'delist', 'delisting', 'bankrupt', 'bankruptcy', 'fraud', 'charges', 'collapse'];

const WORD_RE = {};
function countWords(text, words) {
  let n = 0;
  for (const w of words) {
    const re = WORD_RE[w] || (WORD_RE[w] = new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i'));
    if (re.test(text)) n++;
  }
  return n;
}

const Strategy = {
  headlineScore(item) {
    const text = `${item.title} ${item.title} ${item.body || ''}`;
    const p = countWords(text, POS_WORDS), n = countWords(text, NEG_WORDS);
    return p + n === 0 ? 0 : (p - n) / (p + n);
  },

  mentions(item, sym) {
    if ((item.tags || '').split('|').includes(sym.toUpperCase())) return true;
    return ASSETS[sym].aliases.some((a) => new RegExp(`\\b${a}\\b`, 'i').test(item.title));
  },

  analyzeNews(news, symbols, now = Date.now()) {
    const recent = news.filter((n) => now - n.t < 48 * 3600e3);
    recent.forEach((n) => (n.score = Strategy.headlineScore(n)));
    const weighted = (items) => {
      let s = 0, w = 0;
      for (const it of items) { const wt = Math.exp(-((now - it.t) / 3600e3) / 12); s += wt * it.score; w += wt; }
      return w ? s / w : 0;
    };
    const cryptoNews = recent.filter((n) => n.kind !== 'stock');
    const stockNews = recent.filter((n) => n.kind === 'stock');
    const perCoin = {};
    for (const sym of symbols) {
      const items = recent.filter((n) => Strategy.mentions(n, sym));
      const redFlag = items.find((n) => now - n.t < 12 * 3600e3 && countWords(n.title, RED_FLAGS) > 0);
      perCoin[sym] = { score: weighted(items) * Math.min(1, items.length / 3), count: items.length, redFlag: redFlag ? redFlag.title : null, headlines: items.slice(0, 5) };
    }
    return { market: weighted(cryptoNews), stockMarket: weighted(stockNews), perCoin, count: recent.length };
  },

  // closes = Schlusskurse bis jetzt; ctx = { news, market, fng, barsPerDay }
  evaluate(closes, ctx = {}) {
    const i = closes.length - 1;
    const bpd = ctx.barsPerDay || 24;
    const reasons = [];
    let score = 0;
    if (closes.length < 60) return { score: 0, action: 'HALTEN', reasons: ['Zu wenige Kursdaten'], ind: {} };

    const price = closes[i];
    const ema20 = Ind.ema(closes, 20)[i];
    const ema50 = Ind.ema(closes, 50)[i];
    const rsi = Ind.rsi(closes, 14)[i];
    const m = Ind.macd(closes);
    const hist = m.hist[i], histPrev = m.hist[i - 1];
    const bb = Ind.bollinger(closes, 20, 2);
    const mom = closes.length > bpd ? (price / closes[i - bpd] - 1) * 100 : 0;
    // Tagesvolatilität aus Stundenrenditen der letzten ~2 Tage
    const rets = [];
    for (let k = Math.max(1, i - 2 * bpd); k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(bpd) * 100;

    if (price > ema50 && ema20 > ema50) { score += 20; reasons.push('Aufwärtstrend (Kurs > EMA50)'); }
    else if (price < ema50 && ema20 < ema50) { score -= 20; reasons.push('Abwärtstrend (Kurs < EMA50)'); }

    if (hist != null && histPrev != null) {
      if (hist > 0 && hist > histPrev) { score += 15; reasons.push('MACD steigt'); }
      else if (hist < 0 && hist < histPrev) { score -= 15; reasons.push('MACD fällt'); }
      else if (histPrev < 0 && hist > 0) { score += 10; reasons.push('MACD-Kreuzung nach oben'); }
      else if (histPrev > 0 && hist < 0) { score -= 10; reasons.push('MACD-Kreuzung nach unten'); }
    }

    if (rsi < 30) { score += 25; reasons.push(`RSI ${rsi.toFixed(0)} – überverkauft`); }
    else if (rsi < 45) { score += 8; reasons.push(`RSI ${rsi.toFixed(0)} – günstig`); }
    else if (rsi > 75) { score -= 25; reasons.push(`RSI ${rsi.toFixed(0)} – stark überkauft`); }
    else if (rsi > 65) { score -= 10; reasons.push(`RSI ${rsi.toFixed(0)} – überkauft`); }

    if (bb.lower[i] != null && price < bb.lower[i]) { score += 10; reasons.push('Unter unterem Bollinger-Band'); }
    else if (bb.upper[i] != null && price > bb.upper[i]) { score -= 10; reasons.push('Über oberem Bollinger-Band'); }

    score += Math.max(-15, Math.min(15, mom * 2));
    if (Math.abs(mom) >= 2) reasons.push(`1 Tag: ${mom > 0 ? '+' : ''}${mom.toFixed(1).replace('.', ',')} %`);

    if (ctx.news && ctx.news.count) {
      const pts = ctx.news.score * 30;
      score += pts;
      if (Math.abs(pts) >= 3) reasons.push(`News ${pts > 0 ? 'positiv' : 'negativ'} (${ctx.news.count})`);
    }
    if (ctx.market) {
      const pts = ctx.market * 10;
      score += pts;
      if (Math.abs(pts) >= 3) reasons.push(`Marktnachrichten ${pts > 0 ? 'positiv' : 'negativ'}`);
    }
    if (ctx.fng != null) {
      score += ((50 - ctx.fng) / 50) * 10;
      if (ctx.fng <= 25) reasons.push(`Extreme Angst (${ctx.fng}) – antizyklische Chance`);
      if (ctx.fng >= 75) reasons.push(`Extreme Gier (${ctx.fng}) – Vorsicht`);
    }

    let action = 'HALTEN';
    if (score >= CONFIG.buyThreshold) action = 'KAUFEN';
    else if (score <= CONFIG.shortThreshold && CONFIG.allowShort) action = 'SHORT';
    else if (score <= CONFIG.sellThreshold) action = 'VERKAUFEN';

    if (ctx.news && ctx.news.redFlag) {
      score -= 40;
      action = CONFIG.allowShort && score <= CONFIG.shortThreshold ? 'SHORT' : 'VERKAUFEN';
      reasons.unshift(`⚠ Warn-Meldung: „${ctx.news.redFlag}“`);
    }
    score = Math.round(score);
    const lev = Strategy.leverage(score, vol);
    return { score, action, reasons, lev, ind: { price, ema20, ema50, rsi, mom, vol } };
  },

  // Hebel: je stärker das Signal und je ruhiger der Markt, desto höher
  leverage(score, vol) {
    const thr = score >= 0 ? CONFIG.buyThreshold : -CONFIG.shortThreshold;
    const conf = Math.max(0, Math.min(1, (Math.abs(score) - thr) / 40));
    let lev = 1 + Math.round((CONFIG.maxLeverage - 1) * conf);
    const cap = vol > 6 ? 2 : vol > 4 ? 3 : CONFIG.maxLeverage;
    return Math.max(1, Math.min(lev, cap));
  },
};

// ---------------------------------------------------------------- Depot mit Hebel & Short
const Engine = {
  newPortfolio(capital) {
    return { version: 2, cash: capital, positions: {}, trades: [], lastSell: {} };
  },

  risk(lev) {
    const s = 1 / Math.sqrt(lev);
    return { sl: CONFIG.stopLoss * s, tp: CONFIG.takeProfit * s, trailStart: CONFIG.trailStart * s, trail: CONFIG.trailPct * s };
  },

  dir: (p) => (p.side === 'SHORT' ? -1 : 1),
  pnl: (p, price) => Engine.dir(p) * (price - p.entry) * p.qty,
  value: (p, price) => Math.max(0, p.margin + Engine.pnl(p, price)),
  liqPrice(p) { return p.entry - Engine.dir(p) * (p.margin - CONFIG.maintenance * p.initMargin) / p.qty; },

  // Stop-Kurse einer Position
  levels(p) {
    const r = Engine.risk(p.lev), d = Engine.dir(p);
    const sl = p.entry * (1 - d * r.sl);
    const tp = p.entry * (1 + d * r.tp);
    const favorable = d * (p.best - p.entry) / p.entry;
    const trail = favorable >= r.trailStart ? p.best * (1 - d * r.trail) : null;
    const stop = trail == null ? sl : d > 0 ? Math.max(sl, trail) : Math.min(sl, trail);
    return { sl, tp, trail, stop, liq: Engine.liqPrice(p) };
  },

  equity(pf, prices) {
    let v = pf.cash;
    for (const [s, p] of Object.entries(pf.positions)) v += Engine.value(p, prices[s] ?? p.entry);
    return v;
  },

  // quotes[sym] = { price, hi, lo, tradeable } (hi/lo = Extremwerte seit der letzten Prüfung)
  decide(pf, evals, quotes, now) {
    const orders = [];
    for (const [sym, p] of Object.entries(pf.positions)) {
      const q = quotes[sym];
      if (!q) continue;
      // Haltegebühr für Hebel/Short
      if (p.lev > 1 || p.side === 'SHORT') {
        const h = Math.max(0, (now - (p.lastFeeAt ?? now)) / 3600e3);
        const fee = p.qty * q.price * CONFIG.holdFeeHourly * h;
        p.margin -= fee; p.fees = (p.fees || 0) + fee;
      }
      p.lastFeeAt = now;
      if (!q.tradeable) continue; // Börse geschlossen
      const d = Engine.dir(p);
      const adverse = d > 0 ? q.lo : q.hi, favorable = d > 0 ? q.hi : q.lo;
      const lv = Engine.levels(p); // Stops auf Basis des bisherigen Bestkurses
      const hit = (level) => (d > 0 ? adverse <= level : adverse >= level);
      let reason = null, px = q.price;
      if (hit(lv.liq) && !hit(lv.stop)) { reason = `Liquidation (${p.lev}x)`; px = lv.liq; }
      else if (hit(lv.stop)) {
        px = lv.stop; // Stop-Order wird zum Stop-Kurs ausgeführt
        reason = lv.trail != null && lv.stop === lv.trail ? 'Trailing-Stop' : 'Stop-Loss';
      } else if (d > 0 ? favorable >= lv.tp : favorable <= lv.tp) { reason = 'Gewinnmitnahme'; px = lv.tp; }
      else {
        const ev = evals[sym];
        if (ev && d > 0 && ev.score <= CONFIG.sellThreshold) reason = `Verkaufssignal (Score ${ev.score})`;
        if (ev && d < 0 && ev.score >= CONFIG.coverThreshold) reason = `Short-Ende (Score ${ev.score})`;
      }
      p.best = d > 0 ? Math.max(p.best, q.hi) : Math.min(p.best, q.lo);
      if (reason) orders.push({ action: 'CLOSE', sym, price: px, reason });
    }

    const closing = new Set(orders.map((o) => o.sym));
    let cash = pf.cash;
    for (const o of orders) { const p = pf.positions[o.sym]; cash += Math.max(0, p.margin + Engine.pnl(p, o.price) - p.qty * o.price * CONFIG.fee); }
    let n = Object.keys(pf.positions).length - closing.size;
    const prices = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.price]));
    const equity = Engine.equity(pf, prices);
    const cands = Object.entries(evals)
      .filter(([s, ev]) => (ev.action === 'KAUFEN' || ev.action === 'SHORT') && quotes[s] && quotes[s].tradeable)
      .filter(([s]) => !pf.positions[s] && !closing.has(s))
      .filter(([s]) => !pf.lastSell[s] || now - pf.lastSell[s] > CONFIG.cooldownH * 3600e3)
      .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));
    for (const [sym, ev] of cands) {
      if (n >= CONFIG.maxPositions) break;
      const margin = Engine.suggestAmount(equity, cash, ev.score);
      if (margin < CONFIG.minOrder) break;
      const side = ev.action === 'SHORT' ? 'SHORT' : 'LONG';
      orders.push({ action: 'OPEN', side, sym, margin, lev: ev.lev, price: quotes[sym].price, reason: `${side === 'LONG' ? 'Kaufsignal' : 'Short-Signal'} (Score ${ev.score}): ${ev.reasons.slice(0, 3).join(', ')}` });
      cash -= margin; n++;
    }
    return orders;
  },

  suggestAmount(equity, cash, score) {
    const thr = score >= 0 ? CONFIG.buyThreshold : -CONFIG.shortThreshold;
    const conf = Math.max(0, Math.min(1, (Math.abs(score) - thr) / 40));
    let amount = Math.min(equity * CONFIG.maxPosPct * (0.6 + 0.4 * conf), cash);
    if (cash - amount < CONFIG.minOrder) amount = cash;
    return Math.floor(amount * 100) / 100;
  },

  execute(pf, o, now) {
    if (o.action === 'OPEN') {
      const fee = o.margin * o.lev * CONFIG.fee;
      const margin = o.margin - fee;
      const qty = (margin * o.lev) / o.price;
      pf.cash -= o.margin;
      pf.positions[o.sym] = { side: o.side, lev: o.lev, entry: o.price, qty, margin, initMargin: margin, invested: o.margin, openedAt: now, best: o.price, lastFeeAt: now, fees: fee };
      const tr = { t: now, action: 'OPEN', side: o.side, sym: o.sym, lev: o.lev, price: o.price, eur: o.margin, volume: margin * o.lev, fee, reason: o.reason };
      pf.trades.push(tr);
      return tr;
    }
    const p = pf.positions[o.sym];
    const fee = p.qty * o.price * CONFIG.fee;
    const back = Math.max(0, p.margin + Engine.pnl(p, o.price) - fee);
    pf.cash += back;
    delete pf.positions[o.sym];
    pf.lastSell[o.sym] = now;
    const tr = { t: now, action: 'CLOSE', side: p.side, sym: o.sym, lev: p.lev, entry: p.entry, price: o.price, eur: back, pnl: back - p.invested, roe: (back - p.invested) / p.invested, fee: fee + (p.fees || 0), heldH: (now - p.openedAt) / 3600e3, reason: o.reason };
    pf.trades.push(tr);
    return tr;
  },

  // Backtest über eine gemeinsame Zeitachse (Aktien nur zu Börsenzeiten handelbar)
  // series[sym] = [{t,c,h,l}], ctxFor(sym) -> { barsPerDay }
  backtest(series, capital, ctxFor = () => ({})) {
    const syms = Object.keys(series).filter((s) => series[s].length > 80);
    const times = [...new Set(syms.flatMap((s) => series[s].map((r) => r.t)))].sort((a, b) => a - b);
    const idx = Object.fromEntries(syms.map((s) => [s, -1]));
    const evals = {}, closes = {};
    const pf = Engine.newPortfolio(capital);
    const curve = [];
    syms.forEach((s) => (closes[s] = series[s].map((r) => r.c)));
    const start = times[Math.min(times.length - 1, 60)];
    for (const t of times) {
      const quotes = {};
      let fresh = false;
      for (const s of syms) {
        const rows = series[s];
        let j = idx[s];
        const isNew = j + 1 < rows.length && rows[j + 1].t === t;
        if (isNew) idx[s] = ++j;
        if (j < 0) continue;
        const r = rows[j];
        quotes[s] = { price: r.c, hi: isNew ? r.h : r.c, lo: isNew ? r.l : r.c, tradeable: isNew };
        if (isNew && j >= 60) { evals[s] = Strategy.evaluate(closes[s].slice(Math.max(0, j - 199), j + 1), ctxFor(s)); fresh = true; }
      }
      if (t < start) continue;
      if (fresh) for (const o of Engine.decide(pf, evals, quotes, t)) Engine.execute(pf, o, t);
      curve.push({ t, v: Engine.equity(pf, Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.price]))) });
    }
    return { pf, curve };
  },
};
