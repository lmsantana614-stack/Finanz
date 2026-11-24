// Alle Anlagen, die der Bot beobachtet.
// cap = ungefähre Marktkapitalisierung in Mrd. USD (nur für die Kachelgröße in der Heatmap).
const ASSETS = {
  // ---- Krypto (24/7 handelbar)
  BTC: { type: 'crypto', name: 'Bitcoin', label: 'BTC', gecko: 'bitcoin', cap: 1100, aliases: ['bitcoin', 'btc'] },
  ETH: { type: 'crypto', name: 'Ethereum', label: 'ETH', gecko: 'ethereum', cap: 190, aliases: ['ethereum', 'eth', 'ether'] },
  XRP: { type: 'crypto', name: 'XRP', label: 'XRP', gecko: 'ripple', cap: 50, aliases: ['xrp', 'ripple'] },
  SOL: { type: 'crypto', name: 'Solana', label: 'SOL', gecko: 'solana', cap: 35, aliases: ['solana'] },
  DOGE: { type: 'crypto', name: 'Dogecoin', label: 'DOGE', gecko: 'dogecoin', cap: 8, aliases: ['dogecoin', 'doge'] },
  ADA: { type: 'crypto', name: 'Cardano', label: 'ADA', gecko: 'cardano', cap: 5, aliases: ['cardano'] },
  LINK: { type: 'crypto', name: 'Chainlink', label: 'LINK', gecko: 'chainlink', cap: 5, aliases: ['chainlink'] },
  AVAX: { type: 'crypto', name: 'Avalanche', label: 'AVAX', gecko: 'avalanche-2', cap: 3, aliases: ['avalanche', 'avax'] },

  // ---- US-Aktien (Handel ca. 15:30–22:00 Uhr)
  NVDA: { type: 'stock', market: 'US', name: 'Nvidia', label: 'NVDA', cap: 4000, aliases: ['nvidia'] },
  AAPL: { type: 'stock', market: 'US', name: 'Apple', label: 'AAPL', cap: 3500, aliases: ['apple', 'iphone'] },
  MSFT: { type: 'stock', market: 'US', name: 'Microsoft', label: 'MSFT', cap: 3300, aliases: ['microsoft'] },
  GOOGL: { type: 'stock', market: 'US', name: 'Alphabet', label: 'GOOGL', cap: 2500, aliases: ['alphabet', 'google'] },
  AMZN: { type: 'stock', market: 'US', name: 'Amazon', label: 'AMZN', cap: 2200, aliases: ['amazon', 'aws'] },
  META: { type: 'stock', market: 'US', name: 'Meta', label: 'META', cap: 1600, aliases: ['meta platforms', 'facebook', 'instagram'] },
  TSLA: { type: 'stock', market: 'US', name: 'Tesla', label: 'TSLA', cap: 1000, aliases: ['tesla'] },
  NFLX: { type: 'stock', market: 'US', name: 'Netflix', label: 'NFLX', cap: 400, aliases: ['netflix'] },
  AMD: { type: 'stock', market: 'US', name: 'AMD', label: 'AMD', cap: 300, aliases: ['amd', 'advanced micro devices'] },

  // ---- Deutsche Aktien (Xetra ca. 9:00–17:30 Uhr)
  'SAP.DE': { type: 'stock', market: 'DE', name: 'SAP', label: 'SAP', cap: 300, aliases: ['sap'] },
  'SIE.DE': { type: 'stock', market: 'DE', name: 'Siemens', label: 'SIE', cap: 180, aliases: ['siemens'] },
  'DTE.DE': { type: 'stock', market: 'DE', name: 'Dt. Telekom', label: 'DTE', cap: 170, aliases: ['deutsche telekom', 't-mobile'] },
  'ALV.DE': { type: 'stock', market: 'DE', name: 'Allianz', label: 'ALV', cap: 150, aliases: ['allianz'] },
  'RHM.DE': { type: 'stock', market: 'DE', name: 'Rheinmetall', label: 'RHM', cap: 80, aliases: ['rheinmetall'] },
  'MBG.DE': { type: 'stock', market: 'DE', name: 'Mercedes-Benz', label: 'MBG', cap: 60, aliases: ['mercedes', 'mercedes-benz', 'daimler'] },
};
const COINS = ASSETS; // Kompatibilität
const CRYPTO = Object.keys(ASSETS).filter((s) => ASSETS[s].type === 'crypto');
const STOCKS = Object.keys(ASSETS).filter((s) => ASSETS[s].type === 'stock');
