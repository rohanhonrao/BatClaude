# 🦇 BatVault

A **private, offline, state-of-the-art personal finance tracker** that runs as an installable app on your phone. Built as a local-first Progressive Web App (PWA): every number lives in your phone's own storage (IndexedDB) — **no accounts, no servers, no data ever leaves your device.**

## Features

- **Net worth** — liquid balances (across accounts) + investments, with a 6-month trend chart
- **Transactions** — income, expense, and transfers; categories, notes, fast entry via the ➕ button
- **Budgets** — monthly per-category limits with progress bars and overspend alerts
- **Recurring & bills** — subscriptions/bills with due-date tracking; post them as transactions in one tap
- **Investments** — track holdings (stocks, funds, gold, crypto…) that feed into net worth
- **Goals** — savings targets with progress
- **CSV import** — pull in bank-statement exports; auto-detects Date / Description / Amount (or Debit/Credit) columns and DD/MM/YYYY dates
- **Live currency converter** — convert between currencies using live mid-market rates, cached on-device so it still works offline
- **Backup & restore** — one-tap JSON export (store it in Google Drive) and CSV export; full restore
- **Multi-currency** — defaults to **$ USD**; INR and others selectable in Settings
- **Offline-first** — the app works with no connection once installed; the only network call is the converter fetching public exchange rates (it sends currency codes only — never your data)

Everything is dependency-free vanilla JS + one CSS file. No build step, no npm, nothing to rot.

---

## Deploy it to your phone (GitHub Pages)

The app is already in a GitHub repo. To publish it:

1. Push these files to the `main` branch (see below if not pushed yet).
2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, pick `main` / `/ (root)`, **Save**.
3. Wait ~1 minute. Your app goes live at:
   **`https://rohanhonrao.github.io/BatClaude/`**

### Install on your Pixel

1. Open that URL in **Chrome** on your Pixel.
2. Complete the one-time welcome screen (name + currency).
3. Tap the **⋮** menu → **"Add to Home screen"** (or "Install app").
4. Launch it from your home screen — it opens full-screen like a native app and works offline.

> Because data is stored **on-device**, it is *not* synced between phones. Use **Settings → Export backup** regularly and save the file to Google Drive so you never lose it. Restore on any device via **Settings → Restore**.

---

## Run it locally (optional, for testing)

ES modules and the service worker require `http://`, not `file://`. A tiny zero-dependency PowerShell server is included:

```powershell
powershell -ExecutionPolicy Bypass -File dev-server.ps1
```

Then open <http://localhost:4599/>.

---

## Later: ship it as a real Android APK (optional)

The same code can be wrapped into an installable Play Store app with **Bubblewrap** (Trusted Web Activity) — no rewrite. Ask when you want to go there.

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest (installability)
sw.js                   service worker (offline cache)
css/styles.css          all styling
js/
  app.js                UI, router, views, editors
  db.js                 IndexedDB layer + backup/restore
  compute.js            balances, net worth, budgets, trends
  util.js               formatting, dates, currency, settings, seed data
  charts.js             dependency-free SVG charts
  csv.js                CSV parse + import/export
  rates.js              live exchange rates (cached) for the converter
icons/                  app icons
dev-server.ps1          optional local test server
```
