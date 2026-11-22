# Voice Diary

A daily minute of speaking, kept like a diary.

**Open it:** https://pearchew.github.io/voice-mapping/

## How a day goes
1. **Today**: the date, a question, and the note you left yourself yesterday.
2. **Get ready**: a breath and a 3-2-1 countdown.
3. **Speak**: 60 seconds to answer out loud. At 10 seconds left you'll see a cue to start landing your thought. You can finish early.
4. **Listen back**: play it through, or hear just the last ten seconds. A few questions sit beside it to listen for: the start, losing the thread, silences, and the ending.
5. **Reflect**: say whether you finished your last thought, how present you were (1–5), and write one thing for tomorrow under *Dear tomorrow,*.

Past days live under **Entries**, newest first, each with its recording and note.

## Use it on your iPhone
1. Open the link above in **Safari**. It has to be Safari, not the GitHub app or another browser.
2. Tap **Share → Add to Home Screen**.
3. Open it from the new icon and allow the microphone when asked.

Once added, it opens full screen like an app and works offline.

## Use it on your laptop
Open the same link in any modern browser and sign in with the same account (see below) to see the same entries.

## Sync between devices
Entries are saved on the device first, then synced through a private Supabase project when you're signed in.

- **First time:** Settings → *Create an account* with your email and a password, click the confirmation email, then sign in.
- **Each other device:** sign in with the same email and password.
- Recordings sync too. A recording made on another device downloads the first time you play it.
- Only your account can read your entries and recordings (row-level security on the tables and the storage bucket).

## Daily reminder
A Home Screen web app can't send notifications, so use Shortcuts instead: **Automation → Time of Day** (e.g. 8:00) → **Open URL** with the link above, and turn off *Ask Before Running*.

## Backup
Settings → **Export** saves every entry and recording as one JSON file.

---

## For development

### Files
| File | What it does |
|---|---|
| `index.html`, `styles.css` | Screens and the diary styling: warm paper, Fraunces and Literata type, one column on every screen size, light and dark |
| `app.js` | The daily flow, recording, playback, entries and settings |
| `db.js` | Local storage in IndexedDB (works offline) |
| `sync.js`, `config.js` | Supabase sign-in and sync. The publishable key in `config.js` is safe to commit |
| `prompts.js` | 60 built-in questions. Questions you add in Settings join the rotation |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline cache and Home Screen install |
| `supabase/schema.sql` | Tables, row-level security and the private `recordings` bucket |

### Run locally
```bash
python3 -m http.server 8765
```
Run this from this folder, then open http://localhost:8765. Add `?date=2026-12-01` to preview another day, or `?sw` to test the offline cache on localhost.

### Publish a change
Pushing to `main` updates the site through GitHub Pages within a minute or two. Raise `VERSION` in `sw.js` first, so installed copies pick up the change.

### Setting up your own Supabase project
1. Create a project and run `supabase/schema.sql` in its SQL editor.
2. Put the project URL and publishable key in `config.js`.
3. Under Authentication → URL Configuration, set the Site URL to your site's address.
