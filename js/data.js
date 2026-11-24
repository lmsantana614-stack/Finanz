// Datenquellen: Kurse, News und Marktstimmung (alle kostenlos & CORS-fähig).
// Anlagen-Liste: siehe js/assets.js

// Kraken-Handelspaare in EUR
const KRAKEN = { BTC: 'XBTEUR', ETH: 'ETHEUR', SOL: 'SOLEUR', XRP: 'XRPEUR', ADA: 'ADAEUR', DOGE: 'XDGEUR', AVAX: 'AVAXEUR', LINK: 'LINKEUR', DOT: 'DOTEUR' };

const Data = {
  async getJSON(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  },

  // Stündliche Kerzen in EUR -> [{t (ms), c, h, l, v}]
  async candles(sym, limit, apiKey) {
    const key = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
    try {
      const j = await Data.getJSON(
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${sym}&tsym=EUR&limit=${Math.min(limit, 2000)}${key}`
      );
      if (j.Response !== 'Success' || !j.Data || !Array.isArray(j.Data.Data)) throw new Error(j.Message || 'CryptoCompare-Fehler');
      const rows = j.Data.Data.filter((d) => d.close > 0).map((d) => ({ t: d.time * 1000, c: d.close, h: d.high, l: d.low, v: d.volumeto }));
      if (rows.length < 60) throw new Error('zu wenige Daten');
      return { rows, source: 'CryptoCompare' };
    } catch (e) {
      // Fallback 1: Kraken (bis 720 Stundenkerzen)
      if (KRAKEN[sym]) {
        try {
          const j = await Data.getJSON(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN[sym]}&interval=60`);
          const key = j.result && Object.keys(j.result).find((k) => k !== 'last');
          if (!key) throw new Error((j.error || []).join(', ') || 'Kraken-Fehler');
          const rows = j.result[key].map((d) => ({ t: d[0] * 1000, c: +d[4], h: +d[2], l: +d[3], v: +d[6] })).slice(-limit);
          if (rows.length >= 60) return { rows, source: 'Kraken' };
        } catch (e2) { /* weiter zu CoinGecko */ }
      }
      // Fallback 2: CoinGecko (stündliche Auflösung bei 2–90 Tagen)
      const days = Math.max(2, Math.min(90, Math.ceil(limit / 24)));
      const j = await Data.getJSON(
        `https://api.coingecko.com/api/v3/coins/${COINS[sym].gecko}/market_chart?vs_currency=eur&days=${days}`
      );
      if (!j.prices || !j.prices.length) throw new Error(`Keine Kurse für ${sym}`);
      const rows = j.prices.map(([t, p]) => ({ t, c: p, h: p, l: p, v: 0 }));
      return { rows, source: 'CoinGecko' };
    }
  },

  // Krypto-News -> [{t, title, body, url, source, tags}]
  async news(apiKey) {
    const key = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
    const j = await Data.getJSON(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN${key}`);
    if (!Array.isArray(j.Data)) throw new Error(j.Message || 'News nicht verfügbar');
    return j.Data.map((n) => ({
      t: n.published_on * 1000,
      title: n.title || '',
      body: (n.body || '').slice(0, 400),
      url: n.url || n.guid,
      source: (n.source_info && n.source_info.name) || n.source || '',
      tags: ((n.categories || '') + '|' + (n.tags || '')).toUpperCase(),
    }));
  },

  // Crypto Fear & Greed Index (0 = extreme Angst, 100 = extreme Gier)
  async fearGreed() {
    const j = await Data.getJSON('https://api.alternative.me/fng/?limit=1');
    const d = j.data && j.data[0];
    if (!d) throw new Error('kein F&G');
    return { value: Number(d.value), label: d.value_classification };
  },

  // Synthetische Daten für den Demo-Modus (wenn APIs nicht erreichbar sind)
  demoCandles(sym, limit) {
    let seed = [...sym].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const base = { BTC: 80000, ETH: 3000, SOL: 150, XRP: 2, ADA: 0.7, DOGE: 0.18, AVAX: 30, LINK: 15, DOT: 6, BNB: 600 }[sym] || 10;
    const now = Math.floor(Date.now() / 3600000) * 3600000;
    let p = base, drift = 0;
    const rows = [];
    for (let i = limit - 1; i >= 0; i--) {
      if (rnd() < 0.02) drift = (rnd() - 0.5) * 0.004; // Regimewechsel
      const g = (rnd() + rnd() + rnd() - 1.5) * 0.012;
      p *= 1 + drift + g;
      rows.push({ t: now - i * 3600000, c: p, h: p * 1.003, l: p * 0.997, v: 0 });
    }
    return { rows, source: 'Demo' };
  },
};
