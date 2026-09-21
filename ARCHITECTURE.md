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
no backend and no account. Sync is opt-in and scoped to **Hearth** — shared
lists and shared money (sections 8b, 8d). Treasury, Keyring and Strongbox never
leave the device. The network calls are:

| Call | Purpose | What it sends |
|---|---|---|
| GitHub Pages | app files | nothing |
| currency-api (jsdelivr) | FX rates for the converter | a currency code |
| `data/concerts-nynj.json` | concert listings (same-origin) | nothing |
| Firebase RTDB | Hearth live sync — **only if opted in** | AES-GCM ciphertext |

### Modules (the hub is the app entry)

| Module (display name) | id | File | State |
|---|---|---|---|
| Treasury | `finance` | `js/app.js` | done — cash-flow ledger, expenses, budgets, accounts, converter |
| Keyring | `passwords` | `js/passwords.js` | done — encrypted vault, biometric-only unlock |
| Strongbox | `docs` | `js/docs.js` | done — encrypted IDs/records, separate passcode vault |
| Hearth | `hearth` | `js/hearth.js` | done — the shared sub-app: one header, two tabs, one sync connection |
| ├ Lists | — | `js/household.js` | done — lists by store, priority, due dates, notes/links (supersedes Grocery) |
| └ Money | — | `js/joint.js` + `js/split.js` | done — shared costs, income-ratio split, settle-up, editable categories, week / month / calendar-year summaries with per-category drill-down |
| Slate | `todos` | `js/todos.js` + `js/when.js` | done — personal tasks, natural-language dates, repeats. **Not shared** |
| Alcove | `alcove` | `js/alcove.js` | done — perfume collection, sellers with user-recorded authenticity. **Not shared** |
| Concerts | `concerts` | `js/concerts.js` | done — NY & NJ gigs, 4-month window, artist tracking |
| Movies / Sports / Stocks | — | — | placeholders, `ready:false` in the registry |

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
  app.js            TREASURY module (largest file)
  projection.js     cash-flow engine: schedule expansion, ledger, balances
  compute.js        balances/flows with as-of-today cutoffs
  charts.js         dependency-free SVG charts
  csv.js            CSV import/export
  rates.js          FX rates (cached for offline)
  crypto.js         envelope encryption (DEK wrapped by password/recovery/biometric)
  shamir.js         2-of-3 secret sharing for the recovery kit
  vaultlock.js      per-namespace vault used by Strongbox/Keyring
  applock.js        biometric gate for opening the app
  hearth.js         HEARTH shell: shared header, Lists/Money tabs, the single
                    "Share live" sheet, sync started once for every store
  household.js      Hearth's Lists tab
  joint.js          Hearth's Money tab
  todos.js          SLATE module (personal, never synced)
  when.js           SLATE parsing: natural-language dates, repeats, buckets
  alcove.js        ALCOVE module: perfume collection (personal, never synced)
  passwords.js docs.js concerts.js  modules
  split.js          JOINT maths: ratios, cent-exact shares, balances,
                    weeks, monthly + calendar-year summaries
                    (fixed/variable, per-category, share vs paid)
scripts/            Node scripts run by GitHub Actions (never shipped to browser)
data/               generated data served same-origin (concerts, artist cache,
                    perfume reference)
img/perfumes/       one catalogue JPEG per reference bottle, same-origin so the
                    shelf keeps its pictures offline (§8f)
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
then the module's own back, then hub, then exit. Treasury exposes `financeBack()`
for its sub-routes.

---

## 5. Data layer (`js/db.js`, `DB_VERSION = 8`)

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
| `todos` | id, title, notes, due (ISO or null), priority 0/1/2, done, doneAt, repeat `{unit,interval}`, createdAt, updatedAt — **never synced** |
| `perfumes` | id, name, house, concentration, kind original/dupe, dupeOf (believed), dupeConfirmed, gender, status collected/coveted, notes, sellers[] {name, kind bottle/decant, price, size, url, authenticity, note}, createdAt, updatedAt — **never synced** |

Which person *this phone* is lives in `settings.jointMe` — **device-local and
never synced**, otherwise both phones would think they were the same person.

Adding a **store** requires bumping `DB_VERSION`. Adding **fields** does not —
prefer optional fields with derived defaults (e.g. `kindOf(account)` derives
`kind` from the legacy `type`, so no migration was needed).

---

## 6. Treasury — the important logic

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
- Keyring and Strongbox each have their own `vaultlock.js` namespace with
  biometric-only unlock.

Still open: **multi-device sync** — needs an E2EE backend; the crypto is
deliberately sync-ready (only ciphertext would move).

---

## 8. Concerts pipeline

Browser-side scraping is impossible: verified that Bandsintown and Ticketmaster
both fail CORS from the page while a control request succeeded. So instead:

`.github/workflows/refresh-concerts.yml` runs **every six hours** plus
`workflow_dispatch` on demand. Four runs a day, because each run can only fetch
a slice before the source blocks the runner — see below. It was dispatch-only
for a while, which meant it never refreshed unless someone pressed the button;
the file sat five weeks stale. Do not remove the schedule.

It runs `scripts/refresh-concerts.mjs`, which:

- reads the **schema.org JSON-LD** Songkick already publishes (~51 blocks/page)
  rather than scraping markup, so a redesign will not break it
- **requires a browser-shaped `Accept` header** — without it Songkick returns
  HTTP 406 partway through the crawl
- retries 406/429/5xx with backoff, paces requests at 2.5s
- **refuses to write when the new crawl has under 60% of the events already on
  disk** — a throttled crawl once silently cut 258 events to 89
- filters comedy
- writes the payload **compact, not pretty-printed**: indentation was about a
  third of the bytes, and the phone downloads this file

### Regions and the window

A **region can span several Songkick metro areas**, because New Jersey is not one
metro. The New York metro (`7644-us-new-york`) covers NYC plus the Jersey Shore;
North Jersey — Jersey City, Hoboken, East Rutherford/MetLife, Holmdel/PNC — sits
under `4690-us-jersey-city`. Both were fetched and their `addressLocality` values
read to confirm this. Songkick also lists `34687-us-new-jersey`, which returns
**zero events** — do not use it.

Metros are crawled in turn into one shared map, so a show listed under both
appears once.

### The source blocks the runner, so coverage is built across runs

**Songkick 406s the GitHub Actions datacentre IP partway through a crawl**, and
does not release it for at least several minutes: retries at 21s/47s/90s/151s
all failed, and the block carried straight into the second metro. The identical
pages fetched from a home connection return 200 all the way to page 15, so this
is IP reputation — **not** depth, pacing, or cookies. Do not try to fix it with
more backoff; that was tried and measured.

How far a run gets **varies with whichever IP the runner draws**: observed runs
stopped at page 5 and at page 7, while another sailed through all twelve pages
it was allowed. So the design must not assume a fixed budget — it just takes
what it can get and records where it stopped.

New York needs ~28 pages to reach four months out. Jersey City is only ~2 pages
in total. So a single run cannot do it, and instead:

- each run takes a **slice** and **merges** into the file on disk
- it always refetches **page 1** for freshness, then resumes from `cursors[metro]`
- on a block, the cursor records that page so the next run resumes there
- when a metro runs out of listings (two consecutive pages with **zero** events
  listed at all — not zero *new*), the cursor resets to 1
- the file is therefore **never replaced**, only merged; events drop out only by
  ageing past the window

Four runs a day builds full coverage in about two days, then keeps it fresh.

Two traps this creates, both already handled:

- **`cursors` must be inside the change signature.** Otherwise a run that found
  no new events exits before writing, the cursor never advances, and coverage
  sticks at page 5 for ever.
- **The "refuse to shrink" guard compares against the previous *in-window*
  count**, since merging means the total can only fall as dates age out.

The window runs from today to the **end of the third month ahead** (in September
you get September through December), computed in the region's own timezone —
`America/New_York` for `nynj` — not the runner's UTC clock, or a late run drops
tonight's shows as "yesterday".

### Artist enrichment

`scripts/enrich-artists.mjs` adds genre, a Wikipedia link and a short blurb
(MusicBrainz as fallback), cached in `data/artists.json` and rechecked every 45
days. It never invents a bio: if neither source knows an artist the fields are
omitted.

Two things that were wrong for a long time and matter at this scale:

- **`data/artists.json` must be committed by the workflow.** It only did
  `git add data/concerts-*.json`, so the cache was built on the runner and
  thrown away — every run re-looked-up every artist, and the 45-day recheck
  never once applied.
- **Lookups are capped per run** (`maxLookups`, default 350). Each costs over a
  second because MusicBrainz asks for ≤1 req/sec, so a cold cache over a
  four-month two-metro window would be an hours-long nightly job. Un-enriched
  events still ship, just without a blurb, and the backlog drains over a few
  days. Never-seen artists are looked up before stale refreshes.

### The app renders the list in pages

Four months of NY/NJ is **over a thousand events**, against ~240 for four weeks
of LA. Rendering them all produced an 85,000px page, and since `render()`
rebuilds `innerHTML` wholesale, every keystroke in the search box cost 40-135ms
and clearing it cost ~600ms — on a desktop, so considerably worse on the Pixel.

So `concerts.js` renders `PAGE_SIZE` (200) at a time, grows on a "Show more"
button and on an IntersectionObserver sentinel, and **debounces the search input
by 180ms**. `limit` resets to one page whenever the query, the view or the
region changes. Measured after: keystrokes and clearing both drop to ~0ms and
the page is 16,678px.

If the event count grows much further, the next step is windowing the rows
rather than raising `PAGE_SIZE` — each grow re-renders everything below it.

The app reads `data/concerts-<region>.json` same-origin and caches the last fetch
for offline. `nynj` is the only region the daily workflow feeds; `la` and `sf`
remain in the picker, marked as having no scheduled refresh. A one-time
`concertRegionMoved` migration moves an existing install off a saved `la`/`nyc`
choice, since a stored value would otherwise beat the new default.

The **Anthropic cloud-agent route was abandoned** — it requires the user to
connect their GitHub account, which only they can authorise. GitHub Actions needs
nothing installed.

---

## 8b. Live sync (`js/sync.js`)

Optional real-time sharing between two phones, used by **Hearth** (both tabs).
`hearth.js` owns the only "Share live" sheet and calls `Sync.start` **once for
every Hearth store**, so pairing covers lists and money together. Neither tab
starts sync itself; each just registers `onHearthRefresh` to say how to redraw.

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
- `validateDbUrl()` is the only accepted way to check a pasted URL. It exists
  because the obvious check (`/firebase/`) matches the console URL — see the
  gotchas table. Two host shapes are valid: `<instance>.firebaseio.com`
  (us-central1) and `<instance>.<region>.firebasedatabase.app` (everywhere else).
- Security rests on encryption plus an unguessable 22-char room id; there is no
  user auth. Fine for a shopping list, **deliberately not used for the vaults**.

---

## 8c. Joint — Hearth's Money tab (`js/joint.js`, `js/split.js`)

Answers "what do we owe each other?", which is a different question from the
personal Treasury module. They share no data on purpose.

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

- `effectiveRule(expense, categories)` resolves which rule applies: the
  expense's own override, else the **category's** default, else income ratio.
  Every share computation must go through it — see the gotchas table.
- `monthlySummary({people, expenses, categories, basis, month})` returns the
  month's `total`, `byKind` (fixed/variable), per-person `share` **and** `paid`,
  and a per-category breakdown carrying each person's share. Share and paid are
  deliberately both reported: share is what you owe, paid is what left your
  account, and the gap is what settling up moves.
- `monthKey` / `inMonth` / `shiftMonth` / `monthsWithActivity` handle the month
  cycle. `shiftMonth` does the arithmetic on the key rather than via `Date`, so
  it can't be moved by a timezone.

### Behaviour worth preserving

- **Settle-up is essential**, not a nicety: without it the balance grows forever
  and stops meaning anything.
- Fixed costs are **scheduled items that post themselves** on their due date
  (`materialiseRecurring`), capped at 24 catch-up periods so a long gap can't
  spin.
- **Categories are fully user-editable** — add, rename, re-icon, switch
  fixed/variable, change the default split rule, delete. `categoryEditor()` with
  no argument creates one. Deletion is guarded three ways: refused if any
  expense **or** any scheduled item still points at the category (either would
  leave a dangling `categoryId`), and refused for the last remaining category
  because `expenseSheet` falls back to `cats[0]`. Names must be unique,
  case-insensitively. Icons come from `CAT_ICONS`, all of which must exist in
  the bundled Tabler font — a name that isn't there renders as a blank square.
- **Add expense sits at the top**, under the balance and beside Settle up (alone
  when square). It used to follow the expense list, so in Month or Year it was
  below the entire summary *and* every expense — the most frequent action was
  the hardest to reach. The header is not sticky, so a header button would have
  scrolled away just the same.
- **Tapping a category in any summary — Week, Month or Year — opens every
  expense in that category for that period** (`categorySheet`), with the
  category's total and each person's share and paid. Week gained the same
  total / people / category breakdown as month and year so it has something to
  tap; it is Monday–Sunday, matching the weekly cycle.
- **`period()` is the one definition of "what is in view".** The expense list,
  the summary and the drill-down all filter through it, and the drill-down keys
  categories with the same `categoryId || '_none'` rule `periodSummary` groups
  by. So a category's drill-down can never list a different set of expenses
  than the one its total was built from — including an expense whose category
  was deleted, which lands under "Uncategorised" in both places.
- Editing an expense from inside a drill-down returns **to that list**, not all
  the way out: `expenseSheet(existing, onDone)` re-opens via `onDone` in place
  rather than calling `closeSheet()` first, which would hit the popstate race in
  the gotchas table.
- **Month and year summaries share one code path.** `periodSummary()` takes a
  `match` predicate; `monthlySummary()` and `yearSummary()` are both thin
  wrappers, so the two views can never disagree about what a category cost or
  who carried it. `yearSummary` additionally returns all **twelve** months —
  including empty ones, so the shape of the year reads correctly — and the Year
  tab renders those as a strip you can tap to open a month.
- The year is **January to December**, with no fiscal-year offset. The user was
  explicit about this.
- Both views report **share and paid separately** per person. They are different
  numbers and the gap between them is what settling up moves; it is *not* the
  running balance, which spans every period.
- Percentages in the header are derived (round the first, subtract for the
  rest) so they read as 100 — rounding each independently showed "53% / 48%".
- Joint reuses the **same encrypted sync room as Household**; pairing once
  covers both.
- The **first-run setup screen offers "Join with a pairing code"**. Without it the
  second phone would enter both people again and end up with two disconnected
  datasets; the screen says so explicitly.

---

## 8d. Hearth — the shared sub-app (`js/hearth.js`)

Household and Joint were separate modules, but from the user's side they are one
thing: the stuff two people run together. They already shared a single encrypted
sync room, so keeping them apart meant two pairing screens for one connection and
two places to look. Hearth merges them behind one header with two tabs.

- **Hearth owns** the header, the Lists/Money tab switch, the hub button, the
  single `shareSheet()`, and sync. `household.js` and `joint.js` keep their own
  logic and render their own bodies.
- Each tab calls `hearthHeader(active, actions)` for its header and
  `bindHearthHeader(root)` to wire it. `actions` is that tab's own header button
  (manage lists / settings); the sharing button is common and doubles as the
  live indicator (`.header-btn.live`).
- **Sync starts once, for `ALL_STORES`**, in `mountHearth()`. A tab registers
  `onHearthRefresh(fn)` so a push from the other phone redraws whichever tab is
  open, without either tab knowing about the other.
- The active tab is remembered in `settings.hearthTab` (device-local).
- `hearth.js` imports `household.js`/`joint.js` and they import back — a
  deliberate ES-module cycle. It is safe **only** because nothing is used at
  module top level; if you ever hoist a `hearthHeader(...)` call or read
  `ALL_STORES` at load time, it will throw on a TDZ error.

---

## 8e. Slate — personal tasks (`js/todos.js`, `js/when.js`)

Personal tasks. **Deliberately not shared** — no sync, no pairing, nothing
leaves the device. Hearth is where shared things live; keeping the two apart is
the whole point of having both.

The bet is that a to-do app lives or dies on capture speed, so the surface is
one text box that understands dates and priority, and everything else is
optional editing afterwards.

### Parsing (`when.js`, pure and unit-tested — 14/14)

`parseWhen(text, todayISO)` returns `{title, due, repeat, priority}`. Rules are
ordered longest-first so "next friday" beats "friday" and "every other week"
beats "every week". Repeats are checked before one-off dates, because
"every friday" is a repeat and not a date.

**The rule that matters: a phrase is only consumed if it is unambiguous.**
Silently eating part of someone's title is worse than making them set a date by
hand. A bare weekday is the one genuinely ambiguous token, so it is only taken
when introduced by on/by/due or when it ends the line, and never when glued to
more characters. That is what keeps `read Friday Night Lights` and
`monday.com subscription` intact — both were broken before the guard.

Priority comes from `!` / `!!` anywhere in the line.

The quick-add box shows a **live preview** of the parse before committing, so
the behaviour is never a surprise after the fact.

### Behaviour worth preserving

- **Ticking a repeating task rolls it forward, it does not complete it.**
  `nextDue()` advances from the due date so a weekly task keeps its weekday,
  but skips past today in a loop — a task ignored for a month comes back
  tomorrow rather than firing a month of missed occurrences.
- Tasks are grouped by **when they are due** (overdue / today / tomorrow / this
  week / later / no date), not by folder. The useful question is "what needs
  doing now", not "where did I file this".
- `addMonthsISO` clamps to the end of a shorter month, so a monthly task set on
  the 31st does not skip February.
- All date maths is on `YYYY-MM-DD` strings via local-midnight `Date`s, so a
  timezone can never shift a due date.

---

## 8f. Alcove — the perfume collection (`js/alcove.js`)

What you own, what you are after, and where a bottle can actually be bought.
Personal, so **not synced** — like Slate.

Store `perfumes`; `sellers[]` is nested rather than its own store because nothing
queries a seller independently of its bottle.

### Two shelves, not a list

**Collected** and **Coveted** are the only two views — there is deliberately no
combined "All". Each is one uninterrupted grid, **three bottles across**,
because a collection should look like a collection; a row of text does not.

House headings were tried and removed: on a small collection they split the
shelf into a stack of one- and two-bottle fragments. `load()` still sorts by
house then name, so bottles from the same maison sit together without labels
doing it.

Each tile's picture falls back in order of what is actually trustworthy:

1. **a photo the user added** — theirs, stored on the device, works offline. It
   wins outright: a picture of *your* bottle beats a catalogue shot of the model;
2. **an `imageUrl` from the reference file** — see below; it removes itself on
   error rather than leaving a broken frame;
3. **a generated monogram** — initials over a gradient hashed from the name, so
   it is stable per bottle. No network, never fails, and looks deliberate rather
   than like a missing asset.

### Catalogue images live in the repo (`img/perfumes/`)

Rung 2 shipped empty — the chain was written before there was anything to put in
it, so every un-photographed bottle fell through to a monogram and the feature
looked broken (see §11). The images are now **vendored**, one JPEG per bottle at
`img/perfumes/<reference id>.jpg`, and `imageUrl` is a same-origin relative path.

Vendored rather than hotlinked, for three reasons: it survives the source going
away or blocking hotlinks; the service worker runtime-caches it like any other
same-origin GET, so the shelf keeps its pictures **offline**, which is the whole
premise of the app; and it costs ~700KB for the current library. They are
deliberately *not* in `sw.js` ASSETS — precaching every bottle would make install
heavier for images the user may never scroll to.

How they were sourced, because guessing here produces the wrong bottle and that
is worse than no bottle (CLAUDE.md rule 3). Fragrantica's **brand index pages**
map a perfume name to a numeric id, and the image CDN is
`fimgs.net/mdimg/perfume/375x500.<id>.jpg`. Reading the id off the brand page is
a lookup; probing ids is not — a random 78544 turned out to be *9pm pour Femme*,
not the Khamrah it was guessed for. Every URL was then checked for a 200 and a
real JPEG, and a sample opened and looked at. Do the same for any addition.

Photos are **downscaled before storage** (longest edge 640px, JPEG). A phone
photo is several megabytes and IndexedDB holds the whole collection; fifty
full-size shots would be a quarter of a gigabyte.

### Capture is name, house, shelf — nothing else

Adding a bottle asks only for the name, the house, and which shelf. Wear,
original-vs-dupe, notes and where to buy are meant to arrive from research, not
from typing. `applyResearch()` fills those fields from the reference entry and
records which ones it set in `fromResearch`, so a later refresh can update them
while anything the user edited by hand is left alone.

### Two things this module refuses to assert

Both follow from CLAUDE.md rule 3, and both concern claims that cost real money
if wrong:

- **A dupe claim stays "believed".** The user supplies what they heard a bottle
  is a dupe of; there is no dupe database to check it against, so it renders in
  italics as *believed dupe of X* and only becomes a plain statement once
  `dupeConfirmed` is set with a source. Nothing sets that field yet — see below.
- **Authenticity is never decided by the app.** `authenticity` records the
  judgement the *user* made about a seller (a batch code, a receipt, an
  authorised-retailer listing). Unchecked stays Unchecked.

### Best price

`bestPrice()` is computed only from prices the user entered. It **excludes
suspect sellers entirely** and prefers verified ones — a cheaper price from a
seller you distrust is not a better price, and offering it as "best" would be
actively misleading.

### Decant sources

Derived by gathering every seller marked `kind: 'decant'` across the collection,
verified first. There is deliberately **no built-in list of decant shops**: the
app cannot tell an honest decanter from a dishonest one, and a list that looked
authoritative would be worse than none.

### The reference layer (`data/perfumes.json`)

Confirming a dupe, finding prices and judging a seller all need a data source the
app cannot reach from the browser (CORS, §8). The answer is the Concerts pattern:
a file in the repo, served same-origin, compiled **outside** the app.

`data/perfumes.json` holds, per bottle: `dupeOf {name, confidence, sources[]}`,
a 2-4 sentence `review` summary with `reviewSources[]`, `priceUSD {low, high,
checkedAt}`, and `retailers[] {name, url, authorised}`.

The app reads it on mount, caches it in `settings.alcoveReference` for offline,
and matches by normalised name (plus house when both have one). It is rendered
as a **separate card** and never merged into the user's own fields — the whole
point is that you can tell what you recorded from what research found. A dupe
claim there stays attributed until the user taps **Accept, with source**, which
writes `dupeConfirmed` *including the source URL*.

`authorised` is only ever true when the brand's own site lists that retailer;
otherwise null. Prices carry `checkedAt` and are marked as possibly out of date
past 45 days, because a stale price that looks current is worse than no price.

### Seeded by house, then filled on request

The library ships populated. `data/perfumes.json` carries the houses the user
actually collects — Lattafa, Afnan, Rasasi and the rest of §8f's list — so a
bottle added from one of them lights up with a dupe, a price and a review
summary the moment it is saved, with no request at all. **Covering the houses
beats chasing individual bottles**: research that is already there costs the
user nothing, and the file is small enough that breadth is cheap.

A daily cloud routine was designed and rejected: the user adds bottles
occasionally, so a schedule would spend most runs researching nothing. (It also
could not be created — the API returns `Connect your GitHub account before
saving a routine that uses a GitHub repository`, which only the user can
authorise.)

For the leftovers, **Ask about this one** opens a pre-filled GitHub issue
(`/issues/new?title=&body=&labels=alcove` — these params *are* documented, which
is why this link can genuinely carry the request). One tap to submit, nothing to
copy. A session with repo access answers it by committing `data/perfumes.json`,
and every device picks the answer up on next open.

The body is the module's rules verbatim (never invent a field; attribute every
dupe claim with a source and a confidence; never guess `authorised`; summarise
reviews rather than copying them) plus the JSON shape. Past ~6000 URL characters
GitHub silently drops the body, so `requestResearch()` falls back to a short body
pointing at `researchPrompt()` in the source — the responder has the repo anyway.

Copy-to-clipboard survives behind **No GitHub, or offline?** as the fallback. It
was the default until the user reported that copying on the phone, pasting into
the Claude app and being rejected "is not working" — a flow that depends on the
user retyping the machine's job is the wrong default.

### Matching is tolerant, but never ambiguous

`matchReference()` compares a **key**: lowercased, punctuation collapsed, filler
words dropped (`edp`, `eau de parfum`, `and`, `the`, a leading repeat of the
house), then spaces removed. So `Khamrah EDP`, `khamrah` under house
`Lattafa Perfumes`, and `Lattafa Khamrah` all reach `Khamrah`, and
`Badee Al Oud Honor & Glory` reaches `Bade'e Al Oud Honor and Glory`.

Two rules keep tolerance from becoming invention:

- **Gendered words are never filler.** `him`, `her`, `homme`, `femme`, `pour`
  stay in the key, because *Hawas for Him* and *Hawas for Her* are different
  bottles and collapsing them would print one's review under the other's name.
- **A prefix match must be unique.** Exact keys are tried first; only if none
  matches does it allow one key to be a prefix of the other, and only when
  exactly one candidate qualifies. `Khamrah` must not resolve to
  `Khamrah Dukhan` merely because it appears first in the file. Ambiguity
  returns nothing — a monogram and an offer to research, which is the honest
  outcome.

### Research is applied on mount, not only on save

`backfill()` runs after the reference file loads and fills blank fields on
bottles the library has since learned about. Without it, `applyResearch()` only
ever fired when a bottle was saved or an import landed, so a bottle added before
its entry existed stayed blank permanently while the library grew underneath it.
It is safe to re-run: `applyResearch()` writes only into empty fields or ones it
set itself (tracked in `fromResearch`), so hand-edits survive, and only records
that actually changed are written back.

### Two reference layers

`settings.alcoveReference` is the fetched repo file. `settings.alcoveReferenceLocal`
holds pasted imports. They must stay separate: `loadReference()` overwrites the
fetched copy on every mount, so a pasted entry sharing that slot would vanish
silently.

Between them, `referenceFor()` prefers the **fresher `checkedAt`**; local wins a
tie and wins outright when the repo has no entry. Local-always-wins was the
original rule and it aged badly — see the gotcha in §11.

This means the whole feature works with **no authorisation at all** — paste the
JSON and it lands. Filing an issue only upgrades it so a session commits
directly and every device picks the data up.

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
| Blank screen, or every `db` call hangs forever | an IndexedDB version upgrade blocked by **another open tab** still holding the old version. Bit again when `DB_VERSION` went 6 → 7 for `todos`: the module mounted but never rendered, with no console error. Close every other tab on the origin before testing a version bump |
| Install option missing in Chrome | a stale WebAPK still registered; removing the home-screen icon does not uninstall it |
| Concert listings never update | the workflow was `workflow_dispatch` only, with no cron, so it only ran when someone pressed the button. Five weeks stale before anyone noticed |
| Crawl dies at page ~5 with HTTP 406, backoff doesn't help | Songkick blocks the Actions datacentre IP, not the depth or the pace. Verified: same pages return 200 from a home connection to page 15. Coverage is built across runs via `cursors`, not by waiting longer |
| A script writes to `data/` and throws ENOENT | git does not track empty directories. Deleting the last committed file in `data/` meant a fresh checkout had no such directory. Both scripts `mkdir` it before writing |
| Coverage stuck at the same page every run | `cursors` was left out of the change signature, so a run that found no new events exited before writing and never advanced |
| Artist enrichment slow and endlessly re-fetching | the workflow committed only `data/concerts-*.json`, so `data/artists.json` was written on the runner and discarded. Every run re-looked-up every artist; the 45-day recheck never applied |
| A new setting's default appears to be ignored | a value already saved in `settings` wins over the code default. Changing a default needs a one-time migration flag (see `concertRegionMoved`), not just a new fallback |
| A category set to 50/50 still split by income | choosing "Category default" stores `rule: ''` on the expense. `''` is not `undefined`, so `shareOf`'s default parameter never fired and it fell through to income ratio. The expense form's live preview resolved the category rule, so it previewed 50/50 and settled by income. Always resolve through `Split.effectiveRule` |
| Sharing set up but nothing ever syncs | the Firebase **console** URL was pasted instead of the database URL. The old guard only tested for the string "firebase", which `console.firebase.google.com` contains, so a dead connection was created silently. `Sync.validateDbUrl` now requires a `firebaseio.com` / `firebasedatabase.app` host and no path |
| Home-screen logo cropped | the maskable icon was drawn to the web spec's safe circle (radius 0.4·S). Android's adaptive icon only guarantees the centre 72 of 108dp — radius ≈0.33·S. The arch's corners sat at 0.36·S, inside the spec but inside the crop band too. Fit the mark's **diagonal** within 0.30·S |
| A sheet reopened after closing vanishes instantly | `closeSheet()` pops history asynchronously; the pending popstate then closes the *replacement* sheet. `openSheet()` already swaps content in place — never close first |
| Alcove bottles *still* show monograms after the library was populated | `referenceFor()` required an **exact** normalised name, so ordinary spellings missed: `Khamrah EDP`, `Hawas For Him`, `Badee Al Oud Honor & Glory`, or a house typed `Lattafa Perfumes`. Every miss is silent — the monogram is the same thing you see when there is genuinely no data — so a collection can look entirely unresearched while the library holds every bottle in it. Matching is now key-based and tolerant (§8f), and the Research button carries a dot while any bottle lacks reference, so the miss is at least visible |
| Every Alcove bottle shows a monogram; no photos anywhere | the fallback chain in `shotHTML()` had three rungs and the middle one was never populated — nothing in `data/perfumes.json` carried an `imageUrl`, so every bottle without a user photo landed on the monogram. Nothing errors, nothing 404s, and the monogram looks intentional, so it reads as a design choice rather than a missing feature. **A fallback chain is only as good as its middle rung: after adding one, assert something actually reaches it.** The `researchPrompt` had the same hole earlier — it never asked for `imageUrl` while `shotHTML` looked for one |
| Alcove shows stale, thinner research for a bottle the repo library covers well | `referenceFor()` preferred `alcoveReferenceLocal` unconditionally, so a one-off pasted entry shadowed a better one that later landed in `data/perfumes.json` — for good. Nothing errors; the card just quietly stays worse. It now compares `checkedAt` and takes the fresher, local winning ties. Caught only by looking at the rendered card against the file on disk |

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
- **"Take-home" means net pay *plus* pre-tax retirement contributions**, by the
  user's choice (Aug 2026). Pure net pay would make whoever saves more into
  retirement look poorer and hand them a smaller share of the rent, which they
  judged unfair. The field therefore will not match the net line on a payslip —
  the person editor says so, so nobody "corrects" it later.
- **Weekly cadence** for reviewing, but the balance is continuous and settled
  on demand — money that crosses a week boundary is never stranded.
- **Module names are rooms and objects in a house, not job descriptions**
  (Aug 2026). Hearth set the pattern and the user liked it; "Finance",
  "Passwords", "Documents" and "To-do" were job descriptions and felt generic
  beside it. Now **Treasury, Keyring, Strongbox, Slate, Hearth**, under
  **Sanctum** — a sanctum being a private inner room, which the arch mark and
  Cinzel already implied. Concerts kept its name because it is specific rather
  than generic. If the placeholders are ever built, the same register suggests
  Marquee / Terrace / Exchange.
  **The names are display strings only.** Module ids (`finance`, `passwords`,
  `docs`, `todos`), store names and function names are unchanged, so renaming
  cost no migration. Do not "tidy" the ids to match the names — that *would*
  be a migration, and `settings` keys like `jointMe` reference nothing else.
- **Concerts follows the user, not the repo's history.** They moved from LA to
  New Jersey (Sept 2026), so `nynj` — New York metro plus Jersey City metro — is
  the region the daily job feeds, and the stale `data/concerts-la.json` was
  deleted rather than left to rot. South Jersey (Camden, Atlantic City) sits
  under Songkick's *Philadelphia* metro and is **not** covered; adding it would
  pull in a lot of Pennsylvania, so it was left out pending a decision.
- **Concert coverage is four calendar months** — today through the end of the
  third month ahead — per the user's "September and the next 3 months".
- Joint is **for two people**. `split.js` mostly generalises, but
  `balanceBetween` assumes two; adding a third person means a settlement graph.
- **Household and Joint merged into Hearth**, one sub-app with Lists and Money
  tabs. They were always the same thing to the user — what the two of them run
  together — and they already shared one sync room, so two pairing screens for
  one connection was a bug waiting to happen. Named by Claude at the user's
  invitation; easy to rename (the string lives in `hearthHeader` and the
  `MODULES` entry).
- **Icon geometry targets Android, not the spec.** See the gotchas table: the
  maskable mark is sized to the adaptive icon's real safe zone, which is tighter
  than what the maskable spec promises.
- **Alcove's research library is seeded by house, and requested by issue**
  (Sep 2026). The user rejected the copy-prompt-paste-into-the-phone flow
  outright. Two changes followed. First, stop researching bottle by bottle:
  `data/perfumes.json` now covers the houses they collect, so most additions
  need no request at all — the work happens once, in the repo, for everyone.
  Second, when something *is* missing, the request is a pre-filled GitHub issue,
  not a clipboard. Tap, submit, done; the answer returns as a library update.
  Copy-paste is kept as the offline fallback, not the default. The principle:
  **if a step exists only because the machine could not carry the data across,
  it is the machine's bug, not the user's job.**

---

## 13. House style

See [CLAUDE.md](CLAUDE.md) for the working agreement. In short:

- **Docs ship in the same commit as the code.** The user has asked never to
  have to request this again; treat a change with stale docs as unfinished.
- Verify before claiming. Say plainly when something is unverified.
- Never invent data (concert times, prices, artist bios) — omit the field.
- Bump both versions on every ship and confirm live with `curl`.
- Commit messages explain the *why*, including bugs found while verifying.
