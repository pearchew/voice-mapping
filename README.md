# Voice Diary

A daily 60-second speaking practice. Each day you get one question, a breath and a 3-2-1 countdown, and 60 seconds to answer out loud. Then you listen back with a short list of things to listen for, mark whether you finished your last thought and how present you felt, and write one thing to improve tomorrow. That note becomes the next day's highlighted focus.

## Files
| File | What it does |
|---|---|
| `index.html`, `styles.css` | Screens and the diary theme: warm paper, Fraunces and Literata type, one calm column on every screen size, light and dark |
| `app.js` | Flow, recording, playback, history, settings |
| `db.js` | IndexedDB storage (local-first, works offline) |
| `sync.js`, `config.js` | Supabase sync between phone and laptop |
| `prompts.js` | 60 built-in questions (you can add your own in Settings) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline cache and Home Screen install |
| `supabase/schema.sql` | Tables, row-level security and the private `recordings` bucket |

## Run locally
```bash
python3 -m http.server 8765 -d voice-mapping
```
Then open http://localhost:8765. Add `?date=2026-12-01` to preview another day, or `?sw` to test the offline cache on localhost.

## Turn on sync
1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
2. Put the project URL and publishable key in `config.js`.
3. In Supabase → Authentication → URL Configuration, add your site URL (for example the GitHub Pages URL).
4. In the app, go to Settings → Create account, confirm the email, then sign in on each device.

## Install on iPhone
Open the hosted URL in Safari, tap Share → **Add to Home Screen**, then open it from the icon and allow the microphone.

## Daily reminder
In the Shortcuts app, go to Automation → **Time of Day** (e.g. 8:00) → **Open URL** with your app's URL, and turn off "Ask Before Running".

## Updating
After changing any app file, bump `VERSION` in `sw.js` so installed copies pick up the change.
