# Sanctum

A private, offline-first personal super-app. Everything lives on your device —
no accounts, no servers, no sync.

**Live:** https://rohanhonrao.github.io/BatClaude/

> **Working on this app?** Read [ARCHITECTURE.md](ARCHITECTURE.md) first. It
> documents the design, the data model, and the traps that have already cost
> real debugging time (service-worker cache poisoning, sticky-position breakage,
> phone-width layout testing).

---

## Modules

| Module | What it does |
|---|---|
| **Finance** | A running cash-flow ledger: history, today and projected future in one snapping scroller with a single balance column. Plus expenses, budgets, accounts, net worth, CSV import and a live currency converter. |
| **Passwords** | Encrypted vault (AES-256-GCM), generator with entropy meter, biometric unlock, auto-clearing clipboard. |
| **Documents** | IDs and records, encrypted under their own passcode/biometric vault. |
| **Household** | Shopping lists by store, with priority, due dates, notes and links. Shareable phone-to-phone without a server. |
| **Move HQ** | Moving checklist. |
| **Concerts** | Every gig in LA for the next four weeks, plus artists you follow. |
| Movies / Sports / Stocks | Planned. |

## Install on your phone

1. Open the link in Chrome
2. Tap the **Install Sanctum** card on the hub (or **⋮ → Add to Home screen**)
3. It runs full-screen and works offline

If the install option is missing, a stale copy is usually still registered:
**Settings → Apps → Sanctum → Uninstall**, then reopen the link. Removing the
home-screen icon alone does not uninstall it.

## Updating

The app self-updates. If it looks stale:

- **Settings → Check for updates → Refresh**, or
- fully close and reopen the app twice

The version number is shown at the bottom of the hub.

⚠️ Do **not** use Chrome's "Delete data" for the site — that erases your
finance data and vaults along with the cache.

## Your data

- Stored only in this browser's IndexedDB, on this device.
- Back it up: **Finance → More → Settings & Backup → Export** (JSON or CSV).
  Keep the file somewhere safe; there is no cloud copy.
- The repository is public but contains **only app code** — never your data.

## Concerts listings

Listings are compiled by a GitHub Action into `data/concerts-la.json` and served
from the app's own origin (no API key, works offline). Rebuild on demand from
the repo's **Actions → Refresh concert listings → Run workflow**, or via the
**Rebuild** link in the module.

## Running locally

No build step and no dependencies. ES modules and the service worker need
`http://`, so use the bundled server:

```powershell
powershell -ExecutionPolicy Bypass -File dev-server.ps1
```

Then open <http://localhost:4599/>.

## Layout

```
index.html  sw.js  manifest.webmanifest
css/     styles.css + bundled Tabler icon font
fonts/   Inter + Cinzel (bundled for offline use)
js/      shell.js (entry) + one file per module + shared engines
scripts/ Node scripts run by GitHub Actions only
data/    generated listings served same-origin
```
