# Sanctum — architecture & working notes

Living reference for the app. **Read this first in any new session.** It records
not just what exists but *why*, and the traps that have already cost real time.

- **Live:** https://rohanhonrao.github.io/BatClaude/
- **Repo:** `rohanhonrao/BatClaude` (public; contains only app code — never user data)
- **Target device:** a Google Pixel. The phone is the real target, not desktop.

---

## 1. What this is

A private, offline-first personal "super-app" — a PWA installed to the home
screen. All user data lives in the browser's IndexedDB on the device. There is
no backend and no account. Sync is opt-in and scoped to Household only
(section 8b). The network calls are:

| Call | Purpose | What it sends |
|---|---|---|
| GitHub Pages | app files | nothing |
| currency-api (jsdelivr) | FX rates for the converter | a currency code |
| `data/concerts-la.json` | concert listings (same-origin) | nothing |
| Firebase RTDB | Household & Joint live sync — **only if opted in** | AES-GCM ciphertext |

### Modules (the hub is the app entry)

| Module | File | State |
|---|---|---|
| Finance | `js/app.js` | done — cash-flow ledger, expenses, budgets, accounts, converter |
| Passwords | `js/passwords.js` | done — encrypted vault, biometric-only unlock |
| Documents | `js/docs.js` | done — encrypted IDs/records, separate passcode vault |
| Household | `js/household.js` | done — lists by store, priority, due dates, notes/links (supersedes Grocery) |
| Joint | `js/joint.js` + `js/split.js` | done — shared costs with a partner, income-ratio split, settle-up |
| Concerts | `js/concerts.js` | done — LA gigs + artist tracking |
| Movies / Sports / Stocks | — | placeholders, `ready:false` in the registry |

Stocks is intended to include a **daily 6am agent** producing buy/sell signals —
not started.

---

## 2. Deploy & update pipeline — read before touching `sw.js`

Push to `main`, GitHub Pages publishes in ~30-90s. Verify with `curl`, never
assume.

### The trap that cost the most time

GitHub Pages serves everything with `Cache-Control: max-age=600`, and
`cache.addAll()` **goes through the browser's HTTP cache**. A new service
worker therefore re-cached *stale bytes* under a new cache name and served them
cache-first indefinitely. Symptom: the user sees **no change at all** across
many version bumps, while local dev (which sends `no-cache`) looks correct.

Fixed in the `sw.js` install handler — keep it this way:

```js
const res = await fetch(new Request(url, { cache: 'reload' }));  // bypass HTTP cache
```

Also: assets are cached **individually**, not via `addAll`. One failed request
used to reject the whole install, leaving the worker inactive and the app pinned
to the previous version forever. And `register()` uses `{ updateViaCache: 'none' }`.

### Every ship must bump BOTH

- `sw.js` — `const CACHE = 'sanctum-vNN'`
- `js/shell.js` — `export const APP_VERSION = 'NN'` (displayed on the hub)

### Getting a stuck device unstuck

1. In-app: **Settings → Check for updates → Refresh** (clears caches, reloads)
2. Or fully close the app and reopen **twice**
3. Never suggest Chrome's "Delete data" — that wipes IndexedDB (their finance
   data and vaults)

---

## 3. File map

```
index.html          shell + global error boundary + stale-cache reset button
sw.js               offline cache (see section 2)
manifest.webmanifest  PWA identity; explicit "id" so Chrome offers reinstall
js/
  shell.js          ENTRY. hub, module registry + mounting, back gesture,
                    install prompt, update banner, settings. Owns APP_VERSION.
  ui.js             toast + bottom sheet + pushNav (history). Single source —
                    modules must NOT reimplement these.
  db.js             IndexedDB wrapper, export/import backup
  util.js           money/date formatting, settings, icon(), seed data
  app.js            FINANCE module (largest file)
  projection.js     cash-flow engine: schedule expansion, ledger, balances
  compute.js        balances/flows with as-of-today cutoffs
  charts.js         dependency-free SVG charts
  csv.js            CSV import/export
  rates.js          FX rates (cached for offline)
  crypto.js         envelope encryption (DEK wrapped by password/recovery/biometric)
  shamir.js         2-of-3 secret sharing for the recovery kit
  vaultlock.js      per-namespace vault used by Documents/Passwords
  applock.js        biometric gate for opening the app
  passwords.js docs.js household.js concerts.js joint.js  modules
  split.js          JOINT maths: ratios, cent-exact shares, balances, weeks
scripts/            Node scripts run by GitHub Actions (never shipped to browser)
data/               generated data served same-origin (concerts, artist cache)
```

---

## 4. Shell / module contract

Every module exports exactly two things:

```js
export function setXHubHandler(fn) { ... }   // shell hands back a "return to hub" fn
export async function mountX() { ... }       // render into #app
```

To register a new module in `js/shell.js`:

1. `import { mountX, setXHubHandler } from './x.js'`
2. add an entry to `MODULES` (`{ id, name, icon, desc, ready }`)
3. add a branch in `openModule()`
4. call `setXHubHandler(goHub)` inside `showHub()`
5. add the file to `sw.js` ASSETS, and bump both versions

Modules render into `#app` and use `ui.js` for sheets/toasts. Their header shows
a hub button via `data-hub`.

### Back gesture

`ui.js#pushNav()` pushes one history entry per navigation step (module open,
route change, sheet open). `shell.js#onPopState` pops exactly one: close sheet,
then the module's own back, then hub, then exit. Finance exposes `financeBack()`
for its sub-routes.

---

## 5. Data layer (`js/db.js`, `DB_VERSION = 6`)

All stores keyed by `id` except `settings` (keyed by `key`).

| Store | Shape |
|---|---|
| `accounts` | id, name, kind (checking/savings/cash), type (legacy), icon, balance (opening), buffer, currency, archived |
| `transactions` | id, type (income/expense/transfer), amount, accountId, toAccountId?, categoryId?, date YYYY-MM-DD, note, createdAt, recurringId?, scheduledFor?, adjustment? |
| `categories` | id, name, type, color, icon, archived |
| `budgets` | id, categoryId, amount (monthly) |
| `recurring` | scheduled items: id, name, type, amount, accountId, toAccountId?, categoryId?, frequency, nextDate, endDate?, paused, day2? |
| `goals`, `holdings` | savings goals; investment holdings |
| `settings` | key/value (currency, name, homeView, cfHorizon, concertArtists, deviceDEK, ...) |
| `vault` | passwords: id, blob {iv,ct}, updatedAt |
| `docs` | documents: id, blob {iv,ct}, updatedAt (separate passcode vault) |
| `grocery` | Household items (name kept for continuity): id, listId, order, name, qty, priority 0/1/2, due, note, url, checked, updatedAt |
| `lists` | Household lists, usually a store: id, name, icon, order |
| `jointPeople` | id, name, incomeGross, incomeNet |
| `jointCategories` | id, name, icon, kind fixed/variable, rule ratio/equal |
| `jointExpenses` | id, date, desc, amount, categoryId, payerId, rule, customPct, recurringId? |
| `jointSettlements` | id, date, fromId, toId, amount, note |
| `jointRecurring` | id, name, amount, categoryId, payerId, frequency, nextDate, paused |
| `jointMeta` | single record `id:'config'`: basis gross/net |

Which person *this phone* is lives in `settings.jointMe` — **device-local and
never synced**, otherwise both phones would think they were the same person.

Adding a **store** requires bumping `DB_VERSION`. Adding **fields** does not —
prefer optional fields with derived defaults (e.g. `kindOf(account)` derives
`kind` from the legacy `type`, so no migration was needed).

---

## 6. Finance — the important logic

### Cash-flow ledger (the "wheel")

One screen, one scroller: past, today, and projection sharing a **single running
balance column**. `projection.ledger()` folds all pre-window history into an
opening figure then walks forward, so each row carries the balance *after* it and
the last past row equals today's balance exactly (no seam).

UI specifics that took several attempts — do not regress these:

- The wheel is a **fixed-height container**, sized in JS to exactly the space
  below the readout, so the *page* never scrolls. One scroller only.
- `scroll-snap-type: y mandatory` + `scroll-snap-stop: always` gives the
  "clickety" feel; each newly focused row fires `navigator.vibrate(6)`.
- Spacers must be `(wheelHeight - rowHeight) / 2`, computed in JS. A hard-coded
  percentage leaves rows off-centre from the detent band.
- The carried-forward marker uses the **Today row's shape** (label left, full
  amount right), not the transaction columns.
- Chart, stats and horizon live in a **Summary sheet**, not on the main view.

### Time rules (easy to get wrong)

- `compute.js` (`accountBalance`, `monthlyFlow`, `spendByCategory`) cuts off at
  **today**. Future-dated transactions must never inflate the current balance,
  current-month spend, or budgets.
- `projection.js` is the **only** place future money counts.
- Future-dated *logged* transactions are real projection events — a bug once made
  such money vanish entirely.
- Double-counting is prevented by stamping `recurringId` + `scheduledFor` on a
  transaction posted from a schedule.

### Adding a transaction

The sheet has a **Done / Upcoming** toggle. Upcoming + "Just once" saves a
future-dated transaction; Upcoming + a repeat saves a `recurring` record instead.

---

## 7. Security model (current state)

**Master-password encryption is deliberately DEFERRED.** The app opens straight
to the hub via `crypto.autoUnlock()`, which uses a device key stored beside the
data. That encrypts at rest but is **not** a security boundary — say so plainly,
never oversell it.

Built and parked, ready to switch on:

- `crypto.js` envelope model: a random DEK encrypts data; the DEK is wrapped
  separately by password (PBKDF2), recovery key (HKDF) and biometric (WebAuthn
  PRF). Changing the password only re-wraps the DEK, never re-encrypts data.
- **Recovery decided: 2-of-3 Shamir shares** (`shamir.js`). Any 2 of 3 recover.
  Zero-knowledge, no backdoor.
- `applock.js` — optional biometric gate to *open* the app (a screen lock).
- Passwords and Documents each have their own `vaultlock.js` namespace with
  biometric-only unlock.

Still open: **multi-device sync** — needs an E2EE backend; the crypto is
deliberately sync-ready (only ciphertext would move).

---

## 8. Concerts pipeline

Browser-side scraping is impossible: verified that Bandsintown and Ticketmaster
both fail CORS from the page while a control request succeeded. So instead:

`.github/workflows/refresh-concerts.yml` (manual `workflow_dispatch`, **no cron**
— the user asked for on-demand) runs `scripts/refresh-concerts.mjs`, which:

- reads the **schema.org JSON-LD** Songkick already publishes (~51 blocks/page)
  rather than scraping markup, so a redesign will not break it
- pages until two consecutive pages add nothing new
- **requires a browser-shaped `Accept` header** — without it Songkick returns
  HTTP 406 partway through the crawl
- retries 406/429/5xx with backoff, paces requests at 2.5s
- **refuses to write when the new crawl has under 60% of the events already on
  disk** — a throttled crawl once silently cut 258 events to 89
- filters comedy; computes the window in **America/Los_Angeles**, not runner UTC

then `scripts/enrich-artists.mjs` adds genre, a Wikipedia link and a short blurb
(MusicBrainz as fallback), cached in `data/artists.json` and rechecked every 45
days. It never invents a bio: if neither source knows an artist the fields are
omitted.

The app reads `data/concerts-<city>.json` same-origin and caches the last fetch
for offline. Cities are already parameterised (`la`, `nyc`, `sf`).

The **Anthropic cloud-agent route was abandoned** — it requires the user to
connect their GitHub account, which only they can authorise. GitHub Actions needs
nothing installed.

---

## 8b. Live sync (`js/sync.js`)

Optional real-time sharing between two phones, shared by Household and Joint.
**Either module can both create and join a connection** — the pairing screens
are equivalent, so neither phone has to detour through the other module.

- **No SDK.** Firebase Realtime Database is driven over plain REST, and its
  `Accept: text/event-stream` endpoint pushes changes, so the app keeps zero
  runtime dependencies and stays offline-capable.
- **End-to-end encrypted.** Every record is AES-256-GCM sealed with a key
  derived (PBKDF2, 120k) from a shared passphrase before upload. The server
  holds `{at, data:{iv,ct}}` and cannot read it. Verified: a pushed payload
  contains no plaintext.
- **Per-record last-write-wins** on `updatedAt`, with **tombstones** for
  deletes — without them the peer re-adds whatever was just deleted.
- A single **pairing code** carries dbUrl + roomId + passphrase, so only one
  person ever touches Firebase. See `SETUP-SYNC.md`.
- Security rests on encryption plus an unguessable 22-char room id; there is no
  user auth. Fine for a shopping list, **deliberately not used for the vaults**.

---

## 8c. Joint — shared finances (`js/joint.js`, `js/split.js`)

Answers "what do we owe each other?", which is a different question from the
personal Finance module. They share no data on purpose.

### The maths (`split.js`, unit-tested — 20/20)

- **Integer cents throughout.** Splitting dollars as floats drifts; over months
  of rent that becomes a real disagreement. Shares are derived so they always
  sum *exactly* to the amount: round all but the last, give the last the
  remainder.
- **People are sorted by id before allocating**, so both phones compute an
  identical split. Without this the rounding remainder could land on different
  people and the two devices would disagree about the balance.
- **Ratio** = each person's income over the total, from either gross or
  take-home (`jointMeta.basis`). No income entered yet falls back to an even
  split rather than dividing by zero.
- **Per-expense rules**: `ratio`, `equal`, `payer` (all theirs), `other` (all
  the partner's), `custom` (payer's %). Blank means "use the category default".
- **Net position** = what you paid − your share, with settlements counting like
  payments. With two people the nets mirror exactly, so the UI shows one number.

### Behaviour worth preserving

- **Settle-up is essential**, not a nicety: without it the balance grows forever
  and stops meaning anything.
- Fixed costs are **scheduled items that post themselves** on their due date
  (`materialiseRecurring`), capped at 24 catch-up periods so a long gap can't
  spin.
- Percentages in the header are derived (round the first, subtract for the
  rest) so they read as 100 — rounding each independently showed "53% / 48%".
- Joint reuses the **same encrypted sync room as Household**; pairing once
  covers both.
- The **first-run setup screen offers "Join with a pairing code"**. Without it the
  second phone would enter both people again and end up with two disconnected
  datasets; the screen says so explicitly.

---

## 9. Design system (`css/styles.css`)

- **Near-monochrome by design.** Platinum/ivory accent `--accent: #E9E4DA` on
  near-black `--bg: #0A0A0B`. Colour is reserved for meaning (green/red money,
  amber warnings). `--gold` remains as an alias to `--accent` so older inline
  styles keep working.
- **Fonts bundled offline** in `/fonts`: Inter for UI and all numbers; **Cinzel**
  for the wordmark and page headers only. Cinzel is a capitals face and reads
  badly in mixed case, so lock/setup prompts stay in Inter.
- Page headers uppercase, tracked `0.11em`; the SANCTUM wordmark `0.2em`.
- Icons: **Tabler webfont**, bundled. `util.icon()` renders `ti-*` names and
  still falls back to legacy emoji stored in older records.
- Numbers use tabular figures everywhere.

---

## 10. Testing — how to actually verify

There is **no Node, npm, or Python on this machine.** Two techniques:

### Pure logic: Windows JScript (`cscript //Nologo //E:JScript`)

Strip `export`, concatenate with a test file, run. ES3 limits apply: no arrow
functions, `let`/`const`, default params, `for...of`, `Map`, `JSON`, or trailing
commas — a small shim plus `perl` to strip trailing commas handles most of it.
This has caught real bugs: month-end rollover, vanishing money, and the
opening-balance invariants.

### UI: the in-app browser

`mcp__Claude_Browser__preview_start {name:"batvault"}` then `javascript_tool`,
`get_page_text`, `read_console_messages`, `computer{action:"screenshot"}`.

Rules learned the hard way:

- **Resize to `mobile` (375x812) before judging layout.** Desktop width hides
  real problems; one layout bug survived three rounds because of this.
- **Take a screenshot — do not measure coordinates.** "Columns aligned" was
  technically true while the row looked cramped and clipped.
- The preview does **not** fire scroll events for programmatic scrolling —
  dispatch `new Event('scroll')` manually.
- Clear the SW and caches and reload **twice** to see fresh code locally.
- Tool names are `mcp__Claude_Browser__*`. `preview_eval` / `preview_screenshot`
  do not exist; a failure there is not an outage.

---

## 11. Gotchas already paid for

| Symptom | Cause |
|---|---|
| Updates never reach the phone | HTTP cache poisoning the SW cache (section 2) |
| `position: sticky` silently broken | an ancestor animating `transform` creates a containing block; entry animations are opacity-only now |
| Rows off-centre in the wheel | percentage spacers instead of `(H - rowH)/2` |
| Balance wrong, or money vanishing | future-dated rows counted (or not) in the wrong engine (section 6) |
| 258 concerts became 89 | throttled crawl plus a guard that only checked "at least 20" |
| Blank screen (early on) | an IndexedDB version upgrade blocked by another open tab |
| Install option missing in Chrome | a stale WebAPK still registered; removing the home-screen icon does not uninstall it |
| A sheet reopened after closing vanishes instantly | `closeSheet()` pops history asynchronously; the pending popstate then closes the *replacement* sheet. `openSheet()` already swaps content in place — never close first |

---

## 12. Decisions log

- **PWA, not native** — no Node/Python locally, zero build step, instant deploy.
- **On-device only** — no accounts, no servers. Backup is JSON/CSV export.
- **USD default**, INR and others selectable; live converter included.
- **Cash flow uses scheduled items only.** No estimates, nothing invented — the
  user explicitly rejected auto-estimating variable spend.
- **Comedy excluded** from Concerts; greater-LA venues included, with their city
  shown so out-of-town dates are obvious.
- **Identity:** BatVault became **Sanctum**; all bat references removed. The logo
  is a minimal pointed arch, a single stroke, defined as `ARCH_D` in `shell.js`
  and mirrored by a PowerShell/System.Drawing script for the PNGs.
- **Activity tab** is now largely redundant beside the ledger. The user is
  deciding what it should become — leave it alone until then.
- **Joint splits everything by income ratio**, including variable costs. The
  user's opening brief said variable would be 50/50, then chose ratio-for-all
  when asked directly; the later answer stands. The rule lives on the
  *category*, so flipping Groceries back to 50/50 is two taps, not a rebuild.
- **Both gross and take-home are stored**, with a switch for which drives the
  split. Take-home is the default because deductions can make gross a poor
  proxy for who can actually afford what.
- **Weekly cadence** for reviewing, but the balance is continuous and settled
  on demand — money that crosses a week boundary is never stranded.
- Joint is **for two people**. `split.js` mostly generalises, but
  `balanceBetween` assumes two; adding a third person means a settlement graph.

---

## 13. House style

See [CLAUDE.md](CLAUDE.md) for the working agreement. In short:

- **Docs ship in the same commit as the code.** The user has asked never to
  have to request this again; treat a change with stale docs as unfinished.
- Verify before claiming. Say plainly when something is unverified.
- Never invent data (concert times, prices, artist bios) — omit the field.
- Bump both versions on every ship and confirm live with `curl`.
- Commit messages explain the *why*, including bugs found while verifying.
