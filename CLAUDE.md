# Working agreement for this repo

Read [ARCHITECTURE.md](ARCHITECTURE.md) before touching anything. It is the
authoritative reference and it is kept current on purpose.

---

## Rule 1 — Documentation ships with the change, not afterwards

**The user has asked never to have to request this again.** A change is not
finished until the docs match it. Update docs *in the same commit* as the code.

Before every commit, ask which of these the change touched, and update it:

| If you changed… | Update |
|---|---|
| A module's behaviour or a new module | `ARCHITECTURE.md` §3 file map + the module's section |
| Data shape, a store, `DB_VERSION` | `ARCHITECTURE.md` §5 |
| Cash-flow / projection / ledger logic | `ARCHITECTURE.md` §6 |
| Security, vaults, sync, what leaves the device | `ARCHITECTURE.md` §7, §8b, **and the network-calls table in §1** |
| Anything a user sees or must set up | `README.md` (and `SETUP-SYNC.md` if it's sync) |
| A bug that cost real time to find | `ARCHITECTURE.md` §11 gotchas table — one row, symptom → cause |
| A choice the user made between options | `ARCHITECTURE.md` §12 decisions log |
| Something a future session must not forget | the project memory file |

Two failure modes seen in practice, both worth guarding against:

- **Removing a feature and leaving it documented.** Move HQ lingered in the
  docs after deletion. Grep for the name after removing anything.
- **A claim silently going stale.** README said "no servers, no sync" long
  after opt-in sync existed. When behaviour changes, re-read the *sweeping
  statements*, not just the section you edited.

Sanity check before committing:

```bash
# every js file should be referenced in ARCHITECTURE.md
for f in js/*.js; do grep -q "$(basename $f)" ARCHITECTURE.md || echo "UNDOCUMENTED: $f"; done
# and nothing removed should linger
grep -ril "<name of thing you just deleted>" *.md
```

## Rule 2 — Ship correctly

- Bump **both** `CACHE` in `sw.js` and `APP_VERSION` in `js/shell.js`.
- Confirm live with `curl` after pushing; Pages takes ~1 minute.
- The service worker installs assets with `cache: 'reload'`. Do not remove it —
  GitHub Pages sends `max-age=600` and without it updates never reach the phone.

## Rule 3 — Verify, don't assert

- No Node/npm/Python here. Test pure logic with `cscript //Nologo //E:JScript`
  (ES3 limits — see §10). Test UI in the in-app browser.
- **Resize to mobile (375x812) and take a screenshot before judging layout.**
  Measuring coordinates hid a layout bug for three rounds; the user is on a
  Pixel, not a desktop.
- Say plainly when something is unverified. Never invent data (times, prices,
  bios) — omit the field instead.

## Rule 4 — Respect the premise

Everything is on-device by default. The only exception is opt-in **Hearth**
sync (shared lists and shared money), and even that encrypts before upload. Do
not extend sharing to Treasury, Keyring or Strongbox without the user
explicitly asking.
