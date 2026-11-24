# Finanz Trading-Bot

**➡️ [Aktueller Stand des Bots: STATUS.md](STATUS.md)**

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

- **Sofort**: `tradingbot.html` herunterladen und doppelklicken. Das ist eine einzelne Datei mit allem drin, sie braucht keinen Server und keine Installation (nur Internet für die Kurse).
- **Lokal aus dem Repo**: `index.html` im Browser öffnen. Nach Änderungen an den Quelldateien mit `python3 build.py` die Einzeldatei neu bauen.
- **Online über GitHub Pages**: Im Repo unter *Settings → Pages* bei *Source* „Deploy from a branch“, Branch `main` und Ordner `/ (root)` wählen. Die Seite liegt dann unter `https://lmsantana614-stack.github.io/Finanz/` und aktualisiert sich bei jedem Push auf `main`.

## Automatischer Bot bei GitHub (läuft rund um die Uhr)

Der Workflow `.github/workflows/trading-bot.yml` startet `bot/run.js` jede Stunde, mit derselben Strategie wie die Webseite. Er

- handelt mit eigenen virtuellen 50 € (Stand in `bot/state.json`),
- schreibt den aktuellen Stand nach [`STATUS.md`](STATUS.md),
- meldet jeden Kauf, Verkauf und jedes neue Kaufsignal als Kommentar im Issue „🔔 Trading-Bot: Signale & Trades“. Weil du dort erwähnt wirst, bekommst du eine Push-Benachrichtigung in der GitHub-App.

Manuell starten: *Actions → Trading-Bot → Run workflow*. Zurücksetzen auf 50 €: `bot/state.json` löschen.
Auf einem privaten Repo verbraucht der Bot ca. 750 der 2.000 kostenlosen Actions-Minuten pro Monat.

## Datenquellen (kostenlos)

| Was | Quelle |
|---|---|
| Kurse (stündlich, EUR) | CryptoCompare, Fallback Kraken und CoinGecko |
| News | CryptoCompare News, beim Bot zusätzlich RSS von CoinDesk, Cointelegraph, Decrypt |
| Marktstimmung | alternative.me Fear & Greed Index |

Für höhere Abruflimits kann in den Einstellungen ein kostenloser CryptoCompare-API-Key eingetragen werden. Sind die APIs nicht erreichbar, schaltet die Seite in einen Demo-Modus mit simulierten Kursen und handelt dann nicht.

## Dateien

- `index.html` – Oberfläche
- `js/strategy.js` – Strategie, Scoring, Portfolio-Logik, Backtest (Parameter oben in `CONFIG`)
- `js/data.js` – API-Anbindung
- `js/indicators.js` – technische Indikatoren
- `js/app.js` – App-Logik & Darstellung
