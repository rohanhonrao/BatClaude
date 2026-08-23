# Setting up live sharing for Household

Two phones stay in sync in real time. Everything is **encrypted on your phone
before it is uploaded**, so the server only ever stores unreadable blobs — it is
a relay, not a custodian.

You only have to do this **once, on one phone**. The other phone just pastes a
pairing code.

---

## 1. Create a free Firebase project (~5 minutes, no card)

1. Go to <https://console.firebase.google.com> and sign in with a Google account
2. **Add project** → give it any name (e.g. `sanctum-home`) → you can turn
   Google Analytics **off** → **Create project**
3. In the left sidebar: **Build → Realtime Database** → **Create Database**
4. Pick any location, then choose **Start in test mode** → **Enable**
5. Copy the database URL shown at the top. It looks like:
   `https://sanctum-home-default-rtdb.firebaseio.com`

## 2. Lock it down (important — do this before real use)

Test mode leaves the database open to anyone for 30 days. Replace the rules with
the following so only the app's own room paths are usable:

**Realtime Database → Rules**, paste, **Publish**:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": "$room.length >= 20",
        ".write": "$room.length >= 20"
      }
    }
  }
}
```

This means: nobody can list or read the database as a whole, and a room can only
be reached by someone who already knows its 22-character id. Combined with the
encryption, a stranger who somehow guessed a room id would still see only
ciphertext.

## 3. Turn it on in the app

On **your** phone:

1. Open **Household → Share live**
2. Paste the database URL into *Firebase Realtime Database URL*
3. Tap **Create shared list**
4. Tap **Copy pairing code**

On **your wife's** phone:

1. Open **Household → Share live**
2. Paste the code into *Have a pairing code?*
3. Tap **Join**

Both phones now show a **Live** chip. Add or tick an item on one and it appears
on the other within about a second.

---

## What is actually stored

Each item is uploaded as `{ at: <timestamp>, data: { iv, ct } }` under
`/rooms/<random id>/…`. The `data` is AES-256-GCM ciphertext; the key is derived
(PBKDF2, 120k iterations) from the passphrase inside the pairing code, which
never leaves your phones. Google cannot read your list.

Deletes upload a tombstone rather than removing the record, otherwise the other
phone would helpfully re-add whatever you just deleted.

Conflicts resolve per item by last-write-wins on `updatedAt`, so you and your
wife editing different items never clobber each other. Editing the *same* item
at the same instant means the later write wins.

## Turning it off

**Household → Share live → Stop sharing on this phone.** Local data stays; the
phone simply stops syncing. To wipe the shared copy entirely, delete the
`rooms` node in the Firebase console.

## Cost

The free Spark plan allows 1 GB stored and 10 GB/month transferred. A shopping
list is a few kilobytes. This will not approach the free tier.

## Scope

Live sharing covers **Household only** (items and lists). Finance, Passwords and
Documents remain strictly on-device — the sharing model is deliberately not
applied to them, since their threat model is different.
