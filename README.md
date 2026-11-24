# Finanz Trading-Bot

**🌐 [Webseite öffnen](https://raw.githack.com/lmsantana614-stack/Finanz/main/index.html)** · **📊 [Status](STATUS.md)** · **🔔 [Meldungen](../../issues/1)**

Ein **Papier-Trading-Bot**, der mit **50 € virtuellem Guthaben** Kryptowährungen und Aktien handelt, long und short mit Hebel. Er läuft alle 30 Minuten bei GitHub und meldet sich per Push-Nachricht, wenn er etwas kauft oder kaufen würde.

## Funktionen

- **Webseite (Dashboard):** https://raw.githack.com/lmsantana614-stack/Finanz/main/index.html zeigt Depot, Signale, eine Heatmap (Treemap) aller Anlagen, Positionen mit Stop und Liquidationspreis, Trades, News und den Backtest. Sie liest die Daten, die der Bot schreibt, und lädt sie alle 5 Minuten neu.
- **Bot (GitHub Actions, alle 30 Minuten):** `bot/run.js` bewertet 8 Kryptowährungen und 15 Aktien (USA und Deutschland), handelt Long und Short mit 1–5x Hebel und virtuellen 50 €. Jeder Trade und jedes neue Signal kommt als Kommentar in Issue #1, mit Erwähnung, also als Push-Nachricht in der GitHub-App.
- **Strategie (`js/strategy.js`):** Score aus Trend, MACD, RSI, Bollinger, Tagesbewegung, News-Stimmung und Angst/Gier (Krypto: Fear & Greed, Aktien: VIX). Hebel steigt mit der Signalstärke und sinkt bei hoher Schwankung. Stop-Loss, Gewinnmitnahme und Trailing-Stop werden mit dem Hebel enger. Liquidation, Handels- und Haltegebühren sind eingerechnet. Aktien werden nur zu Börsenzeiten gehandelt.
- **Backtest:** täglich über die letzten 30 Tage mit denselben Regeln (ohne News).

> ⚠️ Papier-Trading mit virtuellem Geld. Hebel vervielfacht Gewinne und Verluste. Keine Anlageberatung.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `css/style.css`, `js/app.js` | Webseite |
| `js/assets.js` | Liste der beobachteten Anlagen |
| `js/strategy.js` | Score, Hebel, Depot-Logik, Backtest (Parameter in `CONFIG`) |
| `js/indicators.js` | technische Indikatoren |
| `js/data.js` | Krypto-Datenquellen (CryptoCompare, Kraken, CoinGecko, Fear & Greed) |
| `bot/run.js` | Bot inkl. Yahoo Finance (Aktien, VIX, EUR/USD, News) |
| `bot/state.json`, `bot/market.json`, `bot/backtest.json`, `STATUS.md` | vom Bot geschrieben |

Manuell starten: *Actions → Trading-Bot → Run workflow*. Neustart mit 50 €: `bot/state.json` löschen.
