// Strategie: technische Analyse + News-Stimmung + Fear & Greed -> Score -> Entscheidungen.

const CONFIG = {
  buyThreshold: 35,    // Score ab dem gekauft wird
  sellThreshold: -20,  // Score ab dem eine Position verkauft wird
  stopLoss: 0.06,      // -6 % -> raus
  takeProfit: 0.15,    // +15 % -> Gewinne sichern
  trailStart: 0.05,    // ab +5 % Gewinn wird ein Trailing-Stop aktiv …
  trailPct: 0.04,      // … der 4 % unter dem Höchststand liegt
  maxPosPct: 0.35,     // max. 35 % des Depots pro Position
  maxPositions: 3,
  fee: 0.001,          // 0,1 % Gebühr pro Trade (realistisch für Kryptobörsen)
  minOrder: 5,         // Mindestorder in €
  cooldownH: 6,        // nach einem Verkauf 6 h kein Wiedereinstieg in denselben Coin
};

const POS_WORDS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'bull', 'bullish', 'gain', 'gains', 'jump', 'jumps',
  'record', 'all-time high', 'ath', 'approval', 'approved', 'approves', 'adoption', 'partnership', 'partners', 'upgrade',
  'launch', 'launches', 'inflow', 'inflows', 'breakout', 'rebound', 'recover', 'recovers', 'recovery', 'climb', 'climbs',
  'buy', 'buys', 'accumulate', 'accumulation', 'optimism', 'optimistic', 'outperform', 'boost', 'boosts', 'milestone',
  'integration', 'institutional', 'rate cut', 'skyrocket', 'spike'];
const NEG_WORDS = ['crash', 'crashes', 'plunge', 'plunges', 'bear', 'bearish', 'drop', 'drops', 'fall', 'falls', 'slump',
  'hack', 'hacked', 'exploit', 'exploited', 'lawsuit', 'sue', 'sues', 'ban', 'bans', 'fraud', 'outflow', 'outflows',
  'sell-off', 'selloff', 'liquidation', 'liquidations', 'dump', 'dumps', 'decline', 'declines', 'warning', 'warns', 'scam',
  'bankrupt', 'bankruptcy', 'investigation', 'delist', 'delisting', 'tumble', 'tumbles', 'fear', 'sink', 'sinks',
  'rate hike', 'crackdown', 'loss', 'losses', 'collapse', 'vulnerability', 'stolen'];
const RED_FLAGS = ['hack', 'hacked', 'exploit', 'exploited', 'stolen', 'delist', 'delisting', 'bankrupt', 'bankruptcy', 'fraud', 'charges', 'collapse'];

function countWords(text, words) {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) n++;
  }
  return n;
}

const Strategy = {
  // Stimmung einer einzelnen Schlagzeile, -1 … +1
  headlineScore(item) {
    const text = `${item.title} ${item.title} ${item.body}`; // Titel doppelt gewichtet
    const p = countWords(text, POS_WORDS), n = countWords(text, NEG_WORDS);
    if (p + n === 0) return 0;
    return (p - n) / (p + n);
  },

  mentions(item, sym) {
    if (item.tags.split('|').includes(sym)) return true;
    return COINS[sym].aliases.some((a) => new RegExp(`\\b${a}\\b`, 'i').test(item.title));
  },

  // News für alle Coins auswerten
  analyzeNews(news, symbols, now = Date.now()) {
    const recent = news.filter((n) => now - n.t < 36 * 3600e3);
    const weighted = (items) => {
      let s = 0, w = 0;
      for (const it of items) {
        const age = (now - it.t) / 3600e3;
        const wt = Math.exp(-age / 12);
        s += wt * it.score; w += wt;
      }
      return w ? s / w : 0;
    };
    recent.forEach((n) => (n.score = Strategy.headlineScore(n)));
    const market = weighted(recent);
    const perCoin = {};
    for (const sym of symbols) {
      const items = recent.filter((n) => Strategy.mentions(n, sym));
      const conf = Math.min(1, items.length / 3); // wenige Meldungen = weniger Gewicht
      const redFlag = items.find((n) => now - n.t < 12 * 3600e3 && countWords(n.title, RED_FLAGS) > 0);
      perCoin[sym] = {
        score: weighted(items) * conf,
        count: items.length,
        redFlag: redFlag ? redFlag.title : null,
        headlines: items.slice(0, 5),
      };
    }
    return { market, perCoin, count: recent.length };
  },

  // Bewertung eines Coins. closes = Schlusskurse bis "jetzt".
  // ctx = { news: {score, count, redFlag}, market: -1..1, fng: 0..100|null }
  evaluate(closes, ctx = {}) {
    const i = closes.length - 1;
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
    const mom24 = closes.length > 24 ? (price / closes[i - 24] - 1) * 100 : 0;

    // 1) Trend
    if (price > ema50 && ema20 > ema50) { score += 20; reasons.push('Aufwärtstrend (Kurs > EMA50, EMA20 > EMA50)'); }
    else if (price < ema50 && ema20 < ema50) { score -= 20; reasons.push('Abwärtstrend (Kurs < EMA50)'); }

    // 2) MACD-Momentum
    if (hist != null && histPrev != null) {
      if (hist > 0 && hist > histPrev) { score += 15; reasons.push('MACD steigt (positives Momentum)'); }
      else if (hist < 0 && hist < histPrev) { score -= 15; reasons.push('MACD fällt (negatives Momentum)'); }
      else if (histPrev < 0 && hist > 0) { score += 10; reasons.push('MACD-Kreuzung nach oben'); }
    }

    // 3) RSI
    if (rsi < 30) { score += 25; reasons.push(`RSI ${rsi.toFixed(0)} – überverkauft`); }
    else if (rsi < 45) { score += 8; reasons.push(`RSI ${rsi.toFixed(0)} – günstig`); }
    else if (rsi > 75) { score -= 25; reasons.push(`RSI ${rsi.toFixed(0)} – stark überkauft`); }
    else if (rsi > 65) { score -= 10; reasons.push(`RSI ${rsi.toFixed(0)} – überkauft`); }

    // 4) Bollinger-Bänder
    if (bb.lower[i] != null && price < bb.lower[i]) { score += 10; reasons.push('Kurs unter unterem Bollinger-Band'); }
    else if (bb.upper[i] != null && price > bb.upper[i]) { score -= 10; reasons.push('Kurs über oberem Bollinger-Band'); }

    // 5) 24h-Momentum
    const momPts = Math.max(-15, Math.min(15, mom24 * 2));
    score += momPts;
    if (Math.abs(mom24) >= 2) reasons.push(`24h: ${mom24 > 0 ? '+' : ''}${mom24.toFixed(1)} %`);

    // 6) News zum Coin
    if (ctx.news && ctx.news.count) {
      const pts = ctx.news.score * 30;
      score += pts;
      if (Math.abs(pts) >= 3) reasons.push(`News ${pts > 0 ? 'positiv' : 'negativ'} (${ctx.news.count} Meldungen)`);
    }
    // 7) Allgemeine Marktnachrichten
    if (ctx.market) {
      const pts = ctx.market * 10;
      score += pts;
      if (Math.abs(pts) >= 3) reasons.push(`Marktnachrichten ${pts > 0 ? 'positiv' : 'negativ'}`);
    }
    // 8) Fear & Greed (antizyklisch: kaufen wenn andere Angst haben)
    if (ctx.fng != null) {
      const pts = ((50 - ctx.fng) / 50) * 10;
      score += pts;
      if (ctx.fng <= 25) reasons.push(`Extreme Angst im Markt (${ctx.fng}) – antizyklische Chance`);
      if (ctx.fng >= 75) reasons.push(`Extreme Gier im Markt (${ctx.fng}) – Vorsicht`);
    }

    let action = 'HALTEN';
    if (score >= CONFIG.buyThreshold) action = 'KAUFEN';
    else if (score <= CONFIG.sellThreshold) action = 'VERKAUFEN';

    // Warn-News blockieren Käufe
    if (ctx.news && ctx.news.redFlag) {
      score -= 40;
      action = 'VERKAUFEN';
      reasons.unshift(`⚠ Warn-Meldung: „${ctx.news.redFlag}“`);
    }

    return { score: Math.round(score), action, reasons, ind: { price, ema20, ema50, rsi, mom24 } };
  },
};

// Portfolio-Logik – identisch für Live-Betrieb und Backtest.
const Engine = {
  newPortfolio(capital) {
    return { cash: capital, positions: {}, trades: [], lastSell: {} };
  },

  equity(pf, prices) {
    let v = pf.cash;
    for (const [s, p] of Object.entries(pf.positions)) v += p.qty * (prices[s] || p.avgPrice);
    return v;
  },

  // Liefert Liste von Orders {side, sym, eur|qty, reason}
  decide(pf, evals, prices, now) {
    const orders = [];
    // Verkäufe zuerst
    for (const [sym, pos] of Object.entries(pf.positions)) {
      const price = prices[sym];
      if (!price) continue;
      pos.peak = Math.max(pos.peak || pos.avgPrice, price);
      const pnl = price / pos.avgPrice - 1;
      const peakGain = pos.peak / pos.avgPrice - 1;
      const ev = evals[sym];
      let reason = null;
      if (pnl <= -CONFIG.stopLoss) reason = `Stop-Loss (${(pnl * 100).toFixed(1)} %)`;
      else if (pnl >= CONFIG.takeProfit) reason = `Gewinnmitnahme (+${(pnl * 100).toFixed(1)} %)`;
      else if (peakGain >= CONFIG.trailStart && price <= pos.peak * (1 - CONFIG.trailPct)) reason = `Trailing-Stop (${(pnl * 100).toFixed(1)} %)`;
      else if (ev && ev.action === 'VERKAUFEN') reason = `Verkaufssignal (Score ${ev.score}): ${ev.reasons[0] || ''}`;
      if (reason) orders.push({ side: 'SELL', sym, qty: pos.qty, reason });
    }

    // Käufe
    const selling = new Set(orders.map((o) => o.sym));
    let cash = pf.cash + orders.reduce((a, o) => a + o.qty * prices[o.sym] * (1 - CONFIG.fee), 0);
    let nPos = Object.keys(pf.positions).length - selling.size;
    const equity = Engine.equity(pf, prices);
    const cands = Object.entries(evals)
      .filter(([sym, ev]) => ev.action === 'KAUFEN' && !pf.positions[sym] && !selling.has(sym))
      .filter(([sym]) => !pf.lastSell[sym] || now - pf.lastSell[sym] > CONFIG.cooldownH * 3600e3)
      .sort((a, b) => b[1].score - a[1].score);
    for (const [sym, ev] of cands) {
      if (nPos >= CONFIG.maxPositions) break;
      const amount = Engine.suggestAmount(equity, cash, ev.score);
      if (amount < CONFIG.minOrder) break;
      orders.push({ side: 'BUY', sym, eur: amount, reason: `Kaufsignal (Score ${ev.score}): ${ev.reasons.slice(0, 3).join(', ')}` });
      cash -= amount; nPos++;
    }
    return orders;
  },

  suggestAmount(equity, cash, score) {
    const conf = Math.max(0, Math.min(1, (score - CONFIG.buyThreshold) / 40));
    let amount = equity * CONFIG.maxPosPct * (0.6 + 0.4 * conf);
    amount = Math.min(amount, cash);
    // Wenn nur ein kleiner Rest übrig bliebe, alles nehmen
    if (cash - amount < CONFIG.minOrder) amount = cash;
    return Math.floor(amount * 100) / 100;
  },

  execute(pf, order, price, now) {
    if (order.side === 'BUY') {
      const fee = order.eur * CONFIG.fee;
      const qty = (order.eur - fee) / price;
      pf.cash -= order.eur;
      pf.positions[order.sym] = { qty, avgPrice: price, invested: order.eur, openedAt: now, peak: price };
      const tr = { t: now, side: 'BUY', sym: order.sym, qty, price, eur: order.eur, fee, reason: order.reason };
      pf.trades.push(tr);
      return tr;
    } else {
      const pos = pf.positions[order.sym];
      const gross = pos.qty * price;
      const fee = gross * CONFIG.fee;
      const net = gross - fee;
      pf.cash += net;
      delete pf.positions[order.sym];
      pf.lastSell[order.sym] = now;
      const tr = { t: now, side: 'SELL', sym: order.sym, qty: pos.qty, price, eur: net, fee, pnl: net - pos.invested, reason: order.reason };
      pf.trades.push(tr);
      return tr;
    }
  },

  // Backtest auf historischen Stundenkerzen (ohne News – die gibt es rückwirkend nicht)
  backtest(series, capital, step = 1) {
    const syms = Object.keys(series);
    const len = Math.min(...syms.map((s) => series[s].length));
    const aligned = {};
    syms.forEach((s) => (aligned[s] = series[s].slice(-len)));
    const pf = Engine.newPortfolio(capital);
    const curve = [];
    const warm = 60;
    for (let i = warm; i < len; i += step) {
      const now = aligned[syms[0]][i].t;
      const prices = {}, evals = {};
      for (const s of syms) {
        const closes = aligned[s].slice(Math.max(0, i - 200), i + 1).map((r) => r.c);
        prices[s] = closes[closes.length - 1];
        evals[s] = Strategy.evaluate(closes, {});
      }
      for (const o of Engine.decide(pf, evals, prices, now)) Engine.execute(pf, o, prices[o.sym], now);
      curve.push({ t: now, v: Engine.equity(pf, prices) });
    }
    // Buy & Hold BTC (bzw. erster Coin) zum Vergleich
    const ref = aligned[syms.includes('BTC') ? 'BTC' : syms[0]];
    const hold = curve.map((p) => {
      const r = ref.find((x) => x.t === p.t);
      return { t: p.t, v: r ? (capital * r.c) / ref[warm].c : null };
    });
    return { pf, curve, hold };
  },
};
