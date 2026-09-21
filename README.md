# Sanctum

A private, offline-first personal super-app. Everything lives on your device —
no accounts, no servers. The one exception is opt-in: **Hearth** (shared lists and shared money) can
share between two phones in real time, and even then the contents are encrypted
before they leave the device (see [SETUP-SYNC.md](SETUP-SYNC.md)). Treasury,
Keyring and Strongbox never leave the phone.

**Live:** https://rohanhonrao.github.io/BatClaude/

> **Working on this app?** Read [CLAUDE.md](CLAUDE.md) for the working agreement (docs ship with the
> change — the user should never have to ask), then [ARCHITECTURE.md](ARCHITECTURE.md). It
> documents the design, the data model, and the traps that have already cost
> real debugging time (service-worker cache poisoning, sticky-position breakage,
> phone-width layout testing).

---

## Modules

| Module | What it does |
|---|---|
| **Treasury** | A running cash-flow ledger: history, today and projected future in one snapping scroller with a single balance column. Plus expenses, budgets, accounts, net worth, CSV import and a live currency converter. |
| **Keyring** | Encrypted vault (AES-256-GCM), generator with entropy meter, biometric unlock, auto-clearing clipboard. |
| **Strongbox** | IDs and records, encrypted under their own passcode/biometric vault. |
| **Hearth** | Everything two people run together, in one place with two tabs. **Lists** — shopping lists by store, with priority, due dates, notes and links. **Money** — shared expenses split by income ratio (or 50/50 per category, with categories you can add and edit yourself), fixed costs that post themselves, and one number for who owes whom; settle up in a tap. Weekly, monthly and calendar-year summaries break spending down by category with both your shares — tap any category to see every expense in it for that period. Optional **real-time sharing** between two phones, end-to-end encrypted; one pairing covers both tabs — see [SETUP-SYNC.md](SETUP-SYNC.md). |
| **Slate** | Personal tasks with dates you can just type — "pay rent friday", "gym every monday", `!` / `!!` for priority. Grouped by when they're due; repeating tasks roll forward when you tick them. Stays on your phone — not shared. |
| **Alcove** | A perfume collection on two shelves — **Collected** and **Coveted** — shown as bottles, not a list. Add one with just a name, a house and a shelf — bottles in the shared library arrive with their own photo, or you can shoot your own, which always wins over the catalogue shot. (Removing your photo brings the catalogue one back.) Wear, original-or-dupe, notes and where to buy are meant to arrive from research. Records sellers with price and *your* authenticity judgement, and gathers decant sources in one place. Bottles from the houses you collect — Lattafa, Afnan, Rasasi and the rest — already carry a dupe confirmation, a price and a short review summary from the shared library, so they fill themselves in. For anything that isn't there, **Ask about this one** opens a pre-filled request on GitHub: one tap, nothing to copy, and the answer arrives as a library update. Stays on your phone — not shared. |
| **Concerts** | Every gig across New York & New Jersey from today through the end of the third month ahead, plus artists you follow. Refreshed four times a day. |
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
- Back it up: **Treasury → More → Settings & Backup → Export** (JSON or CSV).
  Keep the file somewhere safe; there is no cloud copy.
- The repository is public but contains **only app code** — never your data.

## Concerts listings

Listings are compiled by a GitHub Action into `data/concerts-nynj.json` and
served from the app's own origin (no API key, works offline). It runs **every six hours**,
covering today through the end of the third month ahead across two Songkick
metro areas — New York and Jersey City. Coverage is built up over several runs
rather than all at once, because Songkick blocks the runner after a few pages. You can also
rebuild on demand from **Actions → Refresh concert listings → Run workflow**, or
via the **Rebuild** link in the module.

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
