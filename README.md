# Finanz Trading-Bot

Ein **Papier-Trading-Bot** als Webseite: Er startet mit **50 € virtuellem Guthaben**, analysiert laufend Kryptowährungen und sagt dir, **wann er was kaufen oder verkaufen würde** – auf Wunsch handelt er auch selbst (simuliert) und versucht, das Guthaben hochzutraden.

> ⚠️ Es wird kein echtes Geld bewegt. Die Signale sind automatisch berechnet und **keine Anlageberatung**.

## Funktionen

- **Kaufsignale**: Oben auf der Seite steht, was der Bot jetzt kaufen würde, mit Betrag und Begründung. Dazu gibt es auf Wunsch eine Browser-Benachrichtigung und einen Ton.
- **Auto-Handel (Papier)**: Der Bot führt seine Signale selbst mit den 50 € aus (inkl. 0,1 % Gebühren).
- **News-Analyse**: Aktuelle Krypto-Schlagzeilen werden nach Stimmung bewertet. Warnmeldungen (Hack, Delisting, Betrug …) blockieren Käufe und lösen einen Verkauf aus.
- **Fear & Greed Index**: Wird antizyklisch berücksichtigt.
- **Technische Analyse**: Trend (EMA20/50), MACD, RSI, Bollinger-Bänder, 24h-Momentum.
- **Risikomanagement**: Stop-Loss −6 %, Gewinnmitnahme +15 %, Trailing-Stop, max. 35 % pro Position, max. 3 Positionen, 6 h Abkühlphase.
- **Backtest**: Zeigt, was die Strategie in den letzten ~83 Tagen aus 50 € gemacht hätte, im Vergleich zu „nur BTC halten“.
- Depotverlauf, Trade-Protokoll, Signal-Verlauf, Coin-Charts mit Kauf-/Verkaufsmarkern, Export als JSON.

Alle Daten werden im Browser gespeichert (localStorage). Der Bot rechnet nur, **solange die Seite geöffnet ist**.

## Starten

- **Lokal**: `index.html` im Browser öffnen, fertig. Es braucht keinen Server und keine Installation.
- **Online über GitHub Pages**: Im Repo unter *Settings → Pages → Source* „GitHub Actions“ wählen. Jeder Push auf `main` veröffentlicht die Seite dann automatisch.

## Datenquellen (kostenlos)

| Was | Quelle |
|---|---|
| Kurse (stündlich, EUR) | CryptoCompare, Fallback CoinGecko |
| News | CryptoCompare News |
| Marktstimmung | alternative.me Fear & Greed Index |

Für höhere Abruflimits kann in den Einstellungen ein kostenloser CryptoCompare-API-Key eingetragen werden. Sind die APIs nicht erreichbar, schaltet die Seite in einen Demo-Modus mit simulierten Kursen und handelt dann nicht.

## Dateien

- `index.html` – Oberfläche
- `js/strategy.js` – Strategie, Scoring, Portfolio-Logik, Backtest (Parameter oben in `CONFIG`)
- `js/data.js` – API-Anbindung
- `js/indicators.js` – technische Indikatoren
- `js/app.js` – App-Logik & Darstellung
