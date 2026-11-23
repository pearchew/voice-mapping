import { PROMPTS } from './prompts.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { pausesIn, MIN_PAUSE, PAUSE_CHOICES } from './pauses.js';

const LIMIT = 60;          // seconds
const CUE_AT = 50;         // "start landing your thought"
const RING_C = 2 * Math.PI * 86;

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ───────── Dates ─────────
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
// ?date=YYYY-MM-DD previews another day (handy for testing).
const override = new URLSearchParams(location.search).get('date');
const todayKey = () => (override && /^\d{4}-\d{2}-\d{2}$/.test(override) ? override : keyOf(new Date()));
const fmtLong = (k) => parseKey(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (k) => parseKey(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;

// ───────── Helpers ─────────
function toast(msg, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast'; t.role = 'status'; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const allSessions = async () => (await db.all('sessions')).sort((a, b) => (a.date < b.date ? 1 : -1));

let current = 'today';
const NAV_FOR = { today: 'today', ready: 'today', speak: 'today', review: 'today', done: 'today', history: 'history', settings: 'settings' };
function show(name) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.dataset.screen !== name; });
  document.querySelectorAll('.nav-item').forEach(b => {
    if (b.dataset.nav === NAV_FOR[name]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('focus-mode', ['ready', 'speak', 'done'].includes(name));
  current = name;
  window.scrollTo(0, 0);
  stopPlayback();
}

// ───────── Languages ─────────
const LANGS = {
  en: { label: 'English', tag: 'en' },
  yue: { label: '廣東話', tag: 'zh-HK' },
  cmn: { label: '普通话', tag: 'zh-CN' },
};
const BUILTIN = new Map(PROMPTS.map(p => [p.id, p.lang || 'en']));
// Your own questions carry no language, so guess it from the text.
function guessLang(text = '') {
  if (!/[㐀-鿿]/.test(text)) return 'en';
  return /[嘅咩唔佢喺冇啲嚟咗吓噉嗰]/.test(text) ? 'yue' : 'cmn';
}
const langFor = (id, text) => BUILTIN.get(id) || guessLang(text);
function setText(el, text, lang) {
  el.textContent = text;
  el.lang = LANGS[lang]?.tag || 'en';
}
async function getLangs() {
  const l = await db.get('meta', 'langs');
  return Array.isArray(l) && l.length ? l : ['en'];
}

// ───────── Prompts ─────────
async function promptPool() {
  const mine = (await db.all('prompts')).filter(p => !p.deleted).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return [
    ...PROMPTS.map(p => ({ ...p, lang: p.lang || 'en' })),
    ...mine.map(p => ({ id: p.id, cat: 'Yours', text: p.text, lang: guessLang(p.text) })),
  ];
}
// The day's language: the one you picked for that day, else an even rotation of the languages you chose.
async function langForDay(date, langs) {
  const picked = await db.get('meta', `lang:${date}`);
  return langs.includes(picked) ? picked : langs[hash(`${date}·lang`) % langs.length];
}
async function promptFor(date) {
  const lang = await langForDay(date, await getLangs());
  const all = await promptPool();
  const pool = all.filter(p => p.lang === lang);
  const list = pool.length ? pool : all;
  const skips = (await db.get('meta', `skip:${date}`)) || 0;
  return list[(hash(date) + skips) % list.length];
}

// ───────── Today ─────────
let todayPrompt = null;
async function renderToday() {
  const today = todayKey();
  const sessions = await allSessions();
  const done = sessions.find(s => s.date === today);
  todayPrompt = done
    ? { id: done.promptId, text: done.promptText, lang: langFor(done.promptId, done.promptText) }
    : await promptFor(today);

  $('today-date').textContent = fmtLong(today);
  $('today-cat').textContent = "Today's question";
  setText($('today-question'), todayPrompt.text, todayPrompt.lang);

  // Only offer a language switch when you've chosen more than one.
  const langs = await getLangs();
  $('lang-switch').hidden = !!done || langs.length < 2;
  const group = $('lang-group');
  group.innerHTML = '';
  for (const l of langs) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="today-lang"><span></span>`;
    const input = label.querySelector('input');
    input.value = l;
    input.checked = l === todayPrompt.lang;
    setText(label.querySelector('span'), LANGS[l].label, l);
    input.onchange = async () => { await db.put('meta', l, `lang:${today}`); renderToday(); };
    group.append(label);
  }

  const prev = sessions.find(s => s.date < today && s.note && s.note.trim());
  $('focus-block').hidden = !prev;
  if (prev) setText($('focus-text'), prev.note, guessLang(prev.note));

  $('today-todo').hidden = !!done;
  $('today-done').hidden = !done;
  if (done) {
    $('today-note').textContent = done.note ? `Tomorrow: ${done.note}` : '';
    $('today-play').onclick = (e) => playSession(done, e.currentTarget);
    $('edit-today-btn').onclick = () => editEntry(done, 'today');
  }
}

$('skip-btn').onclick = async () => {
  const k = `skip:${todayKey()}`;
  await db.put('meta', ((await db.get('meta', k)) || 0) + 1, k);
  await renderToday();
};

// ───────── Recording ─────────
let stream = null, recorder = null, chunks = [], recStart = 0, raf = 0, cancelled = false;
let rev = null; // what the review screen is showing: { date, prompt, blob, seconds, session?, back? }

function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const t of ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}
function releaseMic() { stream?.getTracks().forEach(t => t.stop()); stream = null; }

async function begin() {
  unlockAudio();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser can’t record audio. Try Safari on iPhone or Chrome on a laptop.', 4000);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('Microphone access is needed. On iPhone: Settings → Safari → Microphone.', 4500);
    return;
  }
  cancelled = false;
  setText($('speak-question'), todayPrompt.text, todayPrompt.lang);
  show('ready');
  for (let n = 3; n > 0; n--) {
    $('count').textContent = n;
    await new Promise(r => setTimeout(r, 1000));
    if (cancelled) return;
  }
  startRecording();
}

function startRecording() {
  chunks = [];
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = onRecorded;
  recorder.start(1000);
  recStart = performance.now();
  $('cue').innerHTML = '&nbsp;';
  $('cue').dataset.on = '';
  $('secs').textContent = LIMIT;
  $('ring-ink').style.strokeDashoffset = 0;
  $('finish-btn').disabled = false;
  show('speak');
  tick();
}

function tick() {
  const t = (performance.now() - recStart) / 1000;
  $('secs').textContent = Math.ceil(Math.max(0, LIMIT - t));
  $('ring-ink').style.strokeDashoffset = (RING_C * Math.min(t, LIMIT)) / LIMIT;
  if (t >= CUE_AT && $('cue').dataset.on !== '1') {
    $('cue').textContent = 'Start landing your thought.';
    $('cue').dataset.on = '1';
    navigator.vibrate?.(40);
  }
  if (t >= LIMIT) return stopRecording();
  raf = requestAnimationFrame(tick);
}

let recSeconds = 0;
function stopRecording() {
  cancelAnimationFrame(raf);
  $('finish-btn').disabled = true;
  recSeconds = Math.min(LIMIT, (performance.now() - recStart) / 1000);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onRecorded() {
  releaseMic();
  const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/mp4' });
  rev = { date: todayKey(), prompt: todayPrompt, blob, seconds: recSeconds, session: null };
  fillReview(null);
  await renderReview();
  show('review');
}

// Reopen a saved entry on the review screen, so its checks and note can be changed.
async function editEntry(s, back) {
  rev = {
    date: s.date,
    prompt: { id: s.promptId, text: s.promptText, lang: langFor(s.promptId, s.promptText) },
    blob: (await db.get('audio', s.date)) || null,
    seconds: 0, session: s, back,
  };
  fillReview(s);
  await renderReview();
  show('review');
}
function fillReview(s) {
  document.querySelectorAll('[data-screen="review"] input[type="radio"]').forEach(i => {
    i.checked = !!s && String(s[i.name] ?? '') === i.value;
  });
  $('note-input').value = s?.note ?? '';
  $('note-hint').textContent = 'Just one thing.';
}

$('begin-btn').onclick = begin;
$('redo-btn').onclick = begin;
$('retake-btn').onclick = begin;
$('finish-btn').onclick = stopRecording;
$('cancel-ready').onclick = () => { cancelled = true; releaseMic(); show('today'); };

// ───────── Playback (one shared <audio>) ─────────
let loadedBlob = null, playUrl = null, activeBtn = null, onProgress = null, knownDur = 0, progRaf = 0, unlocked = false;

// iOS only lets an <audio> element play from code after it has been started by a tap once.
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  audio.muted = true;
  audio.play().catch(() => {}).finally(() => { audio.pause(); audio.muted = false; });
}

async function loadBlob(blob, dur = 0) {
  if (loadedBlob === blob) return;
  if (playUrl) URL.revokeObjectURL(playUrl);
  playUrl = URL.createObjectURL(blob);
  loadedBlob = blob;
  knownDur = dur;
  audio.src = playUrl;
  audio.load();
  await new Promise(r => { if (audio.readyState >= 1) return r(); audio.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 800); });
  // Chrome's recorder writes WebM without a duration; nudge it so seeking works.
  if (!Number.isFinite(audio.duration)) {
    await new Promise(r => {
      const f = () => { if (Number.isFinite(audio.duration)) { audio.removeEventListener('durationchange', f); r(); } };
      audio.addEventListener('durationchange', f);
      audio.currentTime = 1e101;
      setTimeout(r, 1000);
    });
    audio.currentTime = 0;
  }
}
const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDur);

function stopPlayback() {
  audio.pause();
  cancelAnimationFrame(progRaf);
  activeBtn?.classList.remove('playing');
  activeBtn = null;
}
function progressLoop() {
  onProgress?.(audio.currentTime, duration());
  if (!audio.paused) progRaf = requestAnimationFrame(progressLoop);
}
async function play(blob, btn, { from = null, dur = 0, progress = null } = {}) {
  unlockAudio();
  if (activeBtn === btn && !audio.paused && from == null) { stopPlayback(); return; }
  stopPlayback();
  await loadBlob(blob, dur);
  onProgress = progress;
  if (from != null) audio.currentTime = Math.max(0, from);
  else if (audio.ended || audio.currentTime >= duration() - 0.05) audio.currentTime = 0;
  try {
    await audio.play();
    activeBtn = btn; btn.classList.add('playing');
    progressLoop();
  } catch { toast('Couldn’t play this recording.'); }
}
audio.addEventListener('ended', () => { onProgress?.(duration(), duration()); stopPlayback(); });

async function blobFor(s, btn) {
  let blob = await db.get('audio', s.date);
  if (!blob && s.audioPath) {
    if (btn) btn.disabled = true;
    try { blob = await sync.fetchAudio(s); } catch { /* handled below */ }
    if (btn) btn.disabled = false;
  }
  if (!blob) toast(s.audioPath ? 'This recording is on another device. Go online and sign in to fetch it.' : 'No recording saved for this day.');
  return blob;
}
async function playSession(s, btn, opts = {}) {
  const blob = await blobFor(s, btn);
  if (blob) play(blob, btn, opts);
}

// ───────── Review ─────────
async function renderReview() {
  const editing = !!rev.session;
  $('review-kicker').textContent = editing ? `Editing ${fmtLong(rev.date)}` : 'Listening back to';
  setText($('review-question'), rev.prompt.text, rev.prompt.lang);
  $('review-time').textContent = fmtTime(rev.seconds);
  setScrub(0);
  $('save-btn').textContent = editing ? 'Save changes' : 'Keep this entry';
  $('retake-btn').hidden = editing;
  $('cancel-edit').hidden = !editing;
  showPauses();
  const prev = (await allSessions()).find(s => s.date < rev.date && s.note && s.note.trim());
  $('review-focus').hidden = !prev;
  if (prev) setText($('review-focus-text'), prev.note, guessLang(prev.note));
}
function setScrub(frac) {
  $('scrub-fill').style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
  $('review-scrub').setAttribute('aria-valuenow', Math.round(frac * 100));
}
const reviewProgress = (t, d) => { setScrub(d ? t / d : 0); $('review-time').textContent = fmtTime(t || 0); };
// Pause markers: silences of 1.5 s or more between your first and last words, found on the device.
async function showPauses() {
  const marks = $('pause-marks'), line = $('pause-line');
  marks.innerHTML = '';
  line.hidden = true;
  const r = rev;
  if (!r.blob) return;
  const min = await getPauseMin();
  const found = await pausesIn(r.blob, min);
  if (rev !== r || !found) return; // moved on, or this browser can't decode it
  const { pauses, duration: total } = found;
  line.hidden = false;
  line.innerHTML = '';
  if (!pauses.length) { line.textContent = `No pauses of ${min} s or more.`; return; }
  line.append(`${pauses.length} pause${pauses.length === 1 ? '' : 's'} of ${min} s or more: `);
  pauses.forEach((p, i) => {
    const m = document.createElement('span');
    m.className = 'pause-mark';
    m.style.left = `${(p.start / total) * 100}%`;
    m.style.width = `${((p.end - p.start) / total) * 100}%`;
    marks.append(m);
    const b = document.createElement('button');
    b.className = 'link pause-jump';
    b.textContent = `${fmtTime(p.start)} (${(p.end - p.start).toFixed(1)} s)`;
    b.setAttribute('aria-label', `Play from just before the pause at ${fmtTime(p.start)}`);
    b.onclick = () => playTake(Math.max(0, p.start - 1));
    if (i) line.append(' · ');
    line.append(b);
  });
}

async function playTake(from = null) {
  const btn = $('review-play');
  if (!rev.blob && rev.session) {
    rev.blob = await blobFor(rev.session, btn);
    if (rev.blob) showPauses();
  }
  if (!rev.blob) return;
  play(rev.blob, btn, { dur: rev.seconds, from, progress: reviewProgress });
}
$('review-play').onclick = () => playTake();
$('ending-btn').onclick = () => playTake(Math.max(0, (duration() || rev.seconds) - 10));
$('review-scrub').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  playTake(frac * (duration() || rev.seconds));
});
$('review-scrub').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  playTake(Math.max(0, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
});

async function leaveEdit() {
  const back = rev.back || 'history';
  if (back === 'history') await renderHistory(); else await renderToday();
  show(back);
}
$('cancel-edit').onclick = leaveEdit;

$('save-btn').onclick = async () => {
  const note = $('note-input').value.trim();
  if (!note) { $('note-hint').textContent = 'Write one small thing. You’ll see it tomorrow.'; $('note-input').focus(); return; }
  const finished = document.querySelector('input[name="finished"]:checked')?.value ?? null;
  const presence = Number(document.querySelector('input[name="presence"]:checked')?.value) || null;
  const { date } = rev;
  const prev = await db.get('sessions', date);
  const now = new Date().toISOString();

  if (rev.session) {
    // Editing keeps the recording as it is; only the checks and the note change.
    await db.put('sessions', { ...(prev || rev.session), finished, presence, note, updatedAt: now, synced: false });
    toast('Entry updated.');
    await leaveEdit();
    sync.sync();
    return;
  }

  await db.put('audio', rev.blob, date);
  await db.put('sessions', {
    date, promptId: rev.prompt.id, promptText: rev.prompt.text,
    finished, presence, note,
    audioPath: prev?.audioPath ?? null, audioType: rev.blob.type,
    updatedAt: now,
    synced: false, audioDirty: true,
  });
  $('done-note').textContent = `Tomorrow: ${note}`;
  show('done');
  sync.sync().then(n => n && renderToday());
};
$('done-btn').onclick = async () => { await renderToday(); show('today'); };

// ───────── History ─────────
const FINISHED_LABEL = { yes: 'finished the thought', partly: 'partly finished', no: 'didn’t finish' };
async function renderHistory() {
  const sessions = await allSessions();
  $('history-count').textContent = sessions.length ? `${sessions.length} entr${sessions.length === 1 ? 'y' : 'ies'} so far` : '';
  const list = $('entries');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<li class="empty-state">No entries yet. The first one starts today.</li>';
    return;
  }
  for (const s of sessions) list.append(entryCard(s));
}

function entryCard(s) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.innerHTML = `
    <div class="entry-top">
      <button class="play" aria-label="Play recording"></button>
      <div class="entry-main">
        <p class="entry-date"></p>
        <p class="entry-q"></p>
      </div>
    </div>
    <div class="entry-tags"></div>
    <p class="entry-note"></p>
    <button class="link entry-edit">Edit</button>`;
  li.querySelector('.entry-date').textContent = fmtShort(s.date);
  setText(li.querySelector('.entry-q'), s.promptText, langFor(s.promptId, s.promptText));
  const tags = li.querySelector('.entry-tags');
  const tag = (text) => { const t = document.createElement('span'); t.className = 'tag'; t.textContent = text; tags.append(t); };
  if (s.finished) tag(FINISHED_LABEL[s.finished]);
  if (s.presence) tag(`presence ${s.presence} of 5`);
  if (!tags.children.length) tags.remove();
  const note = li.querySelector('.entry-note');
  if (s.note) note.textContent = `Tomorrow: ${s.note}`; else note.remove();
  const btn = li.querySelector('.play');
  btn.onclick = () => playSession(s, btn);
  const edit = li.querySelector('.entry-edit');
  edit.setAttribute('aria-label', `Edit the entry for ${fmtLong(s.date)}`);
  edit.onclick = () => editEntry(s, 'history');
  return li;
}

// ───────── Settings ─────────
function setSyncUI(state, detail) {
  const dot = $('sync-dot');
  dot.className = 'sync-dot' + (['ok', 'idle', 'syncing'].includes(state) ? ' on' : state === 'error' ? ' err' : '');
  const u = sync.currentUser();
  const status = {
    off: 'Sync isn’t set up, so days are stored on this device only.',
    signedout: 'Sign in to keep your phone and laptop in step.',
    idle: `Signed in as ${u?.email ?? ''}.`,
    syncing: 'Syncing…',
    ok: `Synced. Signed in as ${u?.email ?? ''}.`,
    error: detail || 'Sync failed. It will retry.',
  }[state];
  $('sync-status').textContent = status;
  $('sync-short').textContent = { off: 'On this device', signedout: 'Not signed in', idle: 'Synced', syncing: 'Syncing…', ok: 'Synced', error: 'Sync paused' }[state];
  $('auth-form').hidden = !(sync.configured() && !u);
  $('signed-in').hidden = !u;
}
sync.onStatus(setSyncUI);

async function getPauseMin() {
  const v = await db.get('meta', 'pauseMin');
  return PAUSE_CHOICES.includes(v) ? v : MIN_PAUSE;
}
async function renderPauseChoice() {
  const min = await getPauseMin();
  document.querySelectorAll('input[name="pause-min"]').forEach(i => { i.checked = Number(i.value) === min; });
}
document.querySelectorAll('input[name="pause-min"]').forEach(i => {
  i.onchange = async () => { await db.put('meta', Number(i.value), 'pauseMin'); toast(`Pauses of ${i.value} s or more will be marked.`); };
});

async function renderLangs() {
  const langs = await getLangs();
  document.querySelectorAll('#lang-choices input').forEach(i => { i.checked = langs.includes(i.value); });
}
document.querySelectorAll('#lang-choices input').forEach(i => {
  i.onchange = async () => {
    const chosen = [...document.querySelectorAll('#lang-choices input:checked')].map(x => x.value);
    if (!chosen.length) { i.checked = true; toast('Keep at least one language.'); return; }
    await db.put('meta', chosen, 'langs');
    toast('Language choice saved.');
  };
});

async function renderMine() {
  const mine = (await db.all('prompts')).filter(p => !p.deleted);
  const ul = $('my-prompts');
  ul.innerHTML = '';
  for (const p of mine) {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = p.text;
    const b = document.createElement('button'); b.className = 'link'; b.textContent = 'remove';
    b.onclick = async () => { await db.put('prompts', { ...p, deleted: true, synced: false, updatedAt: new Date().toISOString() }); renderMine(); sync.sync(); };
    li.append(span, b); ul.append(li);
  }
}

document.querySelectorAll('.nav-item').forEach(b => {
  b.onclick = async () => {
    if (current === 'speak' || current === 'ready') return; // don't abandon a take
    const to = b.dataset.nav;
    if (to === 'today') await renderToday();
    if (to === 'history') await renderHistory();
    if (to === 'settings') { await renderMine(); await renderLangs(); await renderPauseChoice(); }
    show(to);
  };
});

$('prompt-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('prompt-input').value.trim();
  if (!text) return;
  const now = new Date().toISOString();
  await db.put('prompts', { id: uid(), text, createdAt: now, updatedAt: now, deleted: false, synced: false });
  $('prompt-input').value = '';
  renderMine();
  toast('Added to the question rotation.');
  sync.sync();
};

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await sync.signIn($('auth-email').value.trim(), $('auth-pass').value);
    $('auth-pass').value = '';
    setSyncUI('idle');
    await sync.sync();
    await renderToday();
    toast('Signed in. Your days are syncing.');
  } catch (err) { toast(err.message || 'Couldn’t sign in.'); }
};
$('signup-btn').onclick = async () => {
  const email = $('auth-email').value.trim(), pass = $('auth-pass').value;
  if (!email || pass.length < 8) { toast('Enter an email and a password of at least 8 characters.'); return; }
  try {
    const { needsConfirm } = await sync.signUp(email, pass);
    if (needsConfirm) toast('Check your email to confirm, then sign in here.', 5000);
    else { await sync.sync(); toast('Account created. Syncing.'); }
  } catch (err) { toast(err.message || 'Couldn’t create the account.'); }
};
$('signout-btn').onclick = async () => { await sync.signOut(); setSyncUI('signedout'); toast('Signed out. Your days stay on this device.'); };
$('sync-now').onclick = async () => { const n = await sync.sync(); await renderToday(); toast(n ? `Pulled ${n} day${n === 1 ? '' : 's'}.` : 'Up to date.'); };

const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
$('export-btn').onclick = async () => {
  const sessions = await db.all('sessions');
  const out = [];
  for (const s of sessions) {
    const blob = await db.get('audio', s.date);
    out.push({ ...s, audio: blob ? await blobToB64(blob) : null });
  }
  const prompts = await db.all('prompts');
  const file = new File([JSON.stringify({ exportedAt: new Date().toISOString(), sessions: out, prompts }, null, 1)],
    `voice-mapping-${todayKey()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Voice Mapping backup' }); return; } catch { /* cancelled */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ───────── Boot ─────────
async function refreshFromSync() {
  const n = await sync.sync();
  if (n && current === 'today') renderToday();
  if (n && current === 'history') renderHistory();
}

(async function boot() {
  navigator.storage?.persist?.();
  await renderToday();
  show('today');
  setSyncUI(sync.configured() ? 'signedout' : 'off');
  if (await sync.init()) refreshFromSync();
  window.addEventListener('online', refreshFromSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (current === 'today') renderToday(); // the date may have rolled over
    refreshFromSync();
  });
  // Offline cache. Skipped on localhost during development unless ?sw is set.
  const isDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if ('serviceWorker' in navigator && (!isDev || new URLSearchParams(location.search).has('sw'))) {
    navigator.serviceWorker.register('sw.js');
  }
})();
