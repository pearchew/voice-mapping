import { PROMPTS } from './prompts.js';
import * as db from './db.js';
import * as sync from './sync.js';

const LIMIT = 60;          // seconds
const CUE_AT = 50;         // "start landing your thought"
const RING_C = 2 * Math.PI * 86;

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ───────── Dates ─────────
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
// ?date=YYYY-MM-DD lets you preview another day (handy for testing).
const override = new URLSearchParams(location.search).get('date');
const todayKey = () => (override && /^\d{4}-\d{2}-\d{2}$/.test(override) ? override : keyOf(new Date()));
const fmtMargin = (k) => parseKey(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;

// ───────── Little helpers ─────────
function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.role = 'status'; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

let current = 'today';
function show(name) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.dataset.screen !== name; });
  current = name;
  window.scrollTo(0, 0);
  stopPlayback();
}

// ───────── Prompts ─────────
async function promptPool() {
  const mine = (await db.all('prompts')).filter(p => !p.deleted).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return [...PROMPTS, ...mine.map(p => ({ id: p.id, cat: 'Yours', text: p.text }))];
}
async function promptFor(date) {
  const pool = await promptPool();
  const skips = (await db.get('meta', `skip:${date}`)) || 0;
  return pool[(hash(date) + skips) % pool.length];
}

// ───────── Streak tally ─────────
function tallySVG(n) {
  const groups = [];
  for (let g = 0; g < Math.ceil(n / 5); g++) {
    const k = Math.min(5, n - g * 5);
    let d = '';
    for (let i = 0; i < Math.min(k, 4); i++) d += `M${3 + i * 6} 2 L${2 + i * 6} 20 `;
    if (k === 5) d += 'M-1 15 L24 6';
    groups.push(`<svg viewBox="-2 0 28 22" width="28" height="22" aria-hidden="true"><path d="${d}"/></svg>`);
  }
  return groups;
}
function renderTally(streak) {
  const el = $('tally');
  if (!streak) { el.innerHTML = ''; el.removeAttribute('aria-label'); return; }
  const groups = tallySVG(Math.min(streak, 15));
  el.innerHTML = groups.join('') + (streak > 15 ? `<span class="n">${streak}</span>` : '');
  el.setAttribute('aria-label', `${streak} day streak`);
  el.title = `${streak} day${streak === 1 ? '' : 's'} in a row`;
}
function computeStreak(dates, today) {
  const set = new Set(dates);
  let k = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(k)) { n++; k = addDays(k, -1); }
  return n;
}

// ───────── Today ─────────
let todayPrompt = null;
async function renderToday() {
  const today = todayKey();
  const sessions = (await db.all('sessions')).sort((a, b) => (a.date < b.date ? 1 : -1));
  const done = sessions.find(s => s.date === today);
  todayPrompt = done ? { id: done.promptId, text: done.promptText, cat: '' } : await promptFor(today);

  $('today-date').textContent = fmtMargin(today);
  $('today-cat').textContent = todayPrompt.cat ? `Today's question · ${todayPrompt.cat}` : "Today's question";
  $('today-question').textContent = todayPrompt.text;
  $('skip-btn').hidden = !!done;

  const prev = sessions.find(s => s.date < today && s.note && s.note.trim());
  $('focus-block').hidden = !prev;
  if (prev) $('focus-text').textContent = prev.note;

  $('today-todo').hidden = !!done;
  $('today-done').hidden = !done;
  if (done) {
    $('today-note').textContent = done.note || '';
    $('today-play').onclick = (e) => playSession(done, e.currentTarget);
  }
  renderTally(computeStreak(sessions.map(s => s.date), today));
}

$('skip-btn').onclick = async () => {
  const k = `skip:${todayKey()}`;
  await db.put('meta', ((await db.get('meta', k)) || 0) + 1, k);
  await renderToday();
};

// ───────── Recording ─────────
let stream = null, recorder = null, chunks = [], recStart = 0, raf = 0, recBlob = null, recSeconds = 0, cancelled = false;

function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const t of ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}
function releaseMic() { stream?.getTracks().forEach(t => t.stop()); stream = null; }

async function begin() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser can’t record audio. Try Safari on iPhone or Chrome on a laptop.', 4000);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    toast('Microphone access is needed. Allow it in Settings → Safari → Microphone.', 4500);
    return;
  }
  cancelled = false;
  $('speak-question').textContent = todayPrompt.text;
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
  $('secs').textContent = LIMIT;
  $('ring-ink').style.strokeDashoffset = 0;
  $('finish-btn').disabled = false;
  show('speak');
  tick();
}

function tick() {
  const t = (performance.now() - recStart) / 1000;
  const left = Math.max(0, LIMIT - t);
  $('secs').textContent = Math.ceil(left);
  $('ring-ink').style.strokeDashoffset = (RING_C * Math.min(t, LIMIT)) / LIMIT;
  if (t >= CUE_AT && $('cue').dataset.on !== '1') {
    $('cue').textContent = 'Start landing your thought.';
    $('cue').dataset.on = '1';
    navigator.vibrate?.(40);
  }
  if (t >= LIMIT) return stopRecording();
  raf = requestAnimationFrame(tick);
}

function stopRecording() {
  cancelAnimationFrame(raf);
  $('cue').dataset.on = '';
  $('finish-btn').disabled = true;
  recSeconds = Math.min(LIMIT, (performance.now() - recStart) / 1000);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function onRecorded() {
  releaseMic();
  recBlob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/mp4' });
  document.querySelectorAll('#s-review input').forEach(i => { i.checked = false; });
  loadReview();
  show('review');
}

$('begin-btn').onclick = begin;
$('redo-btn').onclick = begin;
$('retake-btn').onclick = begin;
$('finish-btn').onclick = stopRecording;
$('cancel-ready').onclick = () => { cancelled = true; releaseMic(); show('today'); };

// ───────── Playback ─────────
let playingBtn = null, playUrl = null, knownDuration = 0;
function stopPlayback() {
  audio.pause();
  playingBtn?.classList.remove('playing');
  playingBtn = null;
}
function playBlob(blob, btn, duration = 0) {
  if (playingBtn === btn && !audio.paused) { stopPlayback(); return; }
  stopPlayback();
  if (playUrl) URL.revokeObjectURL(playUrl);
  playUrl = URL.createObjectURL(blob);
  knownDuration = duration;
  audio.src = playUrl;
  audio.play().then(() => { playingBtn = btn; btn.classList.add('playing'); })
    .catch(() => toast('Couldn’t play this recording.'));
}
audio.addEventListener('ended', () => { stopPlayback(); updateScrub(true); });
audio.addEventListener('timeupdate', () => updateScrub());
function updateScrub(end = false) {
  if (current !== 'review') return;
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration;
  const t = end ? 0 : audio.currentTime;
  $('scrub-fill').style.width = dur ? `${Math.min(100, (t / dur) * 100)}%` : '0';
  $('review-time').textContent = fmtTime(end ? dur : t);
}
function loadReview() {
  $('scrub-fill').style.width = '0';
  $('review-time').textContent = fmtTime(recSeconds);
}
$('review-play').onclick = (e) => playBlob(recBlob, e.currentTarget, recSeconds);

async function playSession(s, btn) {
  let blob = await db.get('audio', s.date);
  if (!blob && s.audioPath) {
    btn.disabled = true;
    try { blob = await sync.fetchAudio(s); } catch { /* fallthrough */ }
    btn.disabled = false;
  }
  if (!blob) { toast(s.audioPath ? 'Recording is on another device — sign in and go online to fetch it.' : 'No recording saved for this day.'); return; }
  playBlob(blob, btn);
}

// ───────── Note + save ─────────
$('to-note-btn').onclick = () => {
  const note = $('note-input');
  note.value = '';
  show('note');
  setTimeout(() => note.focus(), 350);
};

$('save-btn').onclick = async () => {
  const note = $('note-input').value.trim();
  if (!note) { $('note-hint').textContent = 'Write one small thing — it becomes tomorrow’s focus.'; $('note-input').focus(); return; }
  const date = todayKey();
  const finished = document.querySelector('input[name="finished"]:checked')?.value ?? null;
  const presence = Number(document.querySelector('input[name="presence"]:checked')?.value) || null;
  const prev = await db.get('sessions', date);
  await db.put('audio', recBlob, date);
  await db.put('sessions', {
    date, promptId: todayPrompt.id, promptText: todayPrompt.text,
    finished, presence, note,
    audioPath: prev?.audioPath ?? null, audioType: recBlob.type,
    updatedAt: new Date().toISOString(),
    synced: false, audioDirty: true,
  });
  $('done-note').textContent = `Tomorrow: ${note}`;
  show('done');
  sync.sync().then(n => n && renderToday());
};
$('done-btn').onclick = async () => { await renderToday(); show('today'); };

// ───────── History ─────────
const MARK = { yes: ['✓', ''], partly: ['½', ''], no: ['✗', 'no'] };
async function renderHistory() {
  const sessions = (await db.all('sessions')).sort((a, b) => (a.date < b.date ? 1 : -1));
  const list = $('entries');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<li class="empty">No pages yet. Your first one starts today.</li>';
    $('trend').innerHTML = '';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'entry';
    const [m, cls] = MARK[s.finished] || ['·', ''];
    li.innerHTML = `
      <p class="margin-note"></p>
      <p class="entry-q"></p>
      <div class="entry-meta">
        <button class="play" aria-label="Play recording"></button>
        <span class="mark ${cls}" title="Finished the thought?"></span>
        <span class="dots" title="Presence"></span>
      </div>
      <p class="hand"></p>`;
    li.querySelector('.margin-note').textContent = fmtMargin(s.date);
    li.querySelector('.entry-q').textContent = s.promptText;
    li.querySelector('.mark').textContent = m;
    li.querySelector('.mark').setAttribute('aria-label', `Finished: ${s.finished || 'not marked'}`);
    li.querySelector('.dots').textContent = s.presence ? `present ${'●'.repeat(s.presence)}${'○'.repeat(5 - s.presence)}` : '';
    li.querySelector('.hand').textContent = s.note || '';
    li.querySelector('.play').onclick = (e) => playSession(s, e.currentTarget);
    list.append(li);
  }
  renderTrend(sessions.slice(0, 30).reverse());
}

function renderTrend(rows) {
  const el = $('trend');
  if (rows.length < 2) { el.innerHTML = '<p class="hint">A trend appears after a couple of pages.</p>'; return; }
  const W = 300, H = 56, n = rows.length;
  const x = (i) => (i / (n - 1)) * W;
  const line = (vals) => vals.map((v, i) => (v == null ? null : `${x(i).toFixed(1)} ${(H - v * H).toFixed(1)}`))
    .reduce((d, p, i, arr) => (p == null ? d : d + (d && arr[i - 1] != null ? ' L' : ' M') + p), '');
  const presence = rows.map(r => (r.presence ? (r.presence - 1) / 4 : null));
  const score = { yes: 1, partly: 0.5, no: 0 };
  const finished = rows.map((_, i) => {
    const win = rows.slice(Math.max(0, i - 4), i + 1).map(r => score[r.finished]).filter(v => v != null);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
  el.innerHTML = `
    <svg viewBox="0 -4 ${W} ${H + 8}" preserveAspectRatio="none" role="img" aria-label="Presence and finished-thought trend over the last ${n} pages">
      <path class="f" d="${line(finished)}" vector-effect="non-scaling-stroke"/>
      <path class="p" d="${line(presence)}" vector-effect="non-scaling-stroke"/>
    </svg>
    <p class="legend"><span><i></i>presence</span><span><i class="f"></i>finished thoughts</span></p>`;
}

$('nav-history').onclick = async () => { await renderHistory(); show('history'); };
$('history-back').onclick = () => show('today');

// ───────── Settings ─────────
function setSyncUI(state, detail) {
  const dot = $('sync-dot');
  dot.className = 'sync-dot' + (state === 'ok' || state === 'idle' || state === 'syncing' ? ' on' : state === 'error' ? ' err' : '');
  const u = sync.currentUser();
  const status = {
    off: 'Sync isn’t set up yet, so pages are stored on this device only.',
    signedout: 'Sign in to keep your phone and laptop in step.',
    idle: `Signed in as ${u?.email ?? ''}.`,
    syncing: 'Syncing…',
    ok: `Synced · signed in as ${u?.email ?? ''}.`,
    error: detail || 'Sync failed — will retry.',
  }[state];
  $('sync-status').textContent = status;
  $('auth-form').hidden = !(sync.configured() && !u);
  $('signed-in').hidden = !u;
}
sync.onStatus(setSyncUI);

async function renderMine() {
  const mine = (await db.all('prompts')).filter(p => !p.deleted);
  const ul = $('my-prompts');
  ul.innerHTML = '';
  for (const p of mine) {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = p.text;
    const b = document.createElement('button'); b.className = 'linkbtn small'; b.textContent = 'Remove';
    b.onclick = async () => { await db.put('prompts', { ...p, deleted: true, synced: false, updatedAt: new Date().toISOString() }); renderMine(); sync.sync(); };
    li.append(span, b); ul.append(li);
  }
}

$('nav-settings').onclick = async () => { await renderMine(); show('settings'); };
$('settings-back').onclick = async () => { await renderToday(); show('today'); };

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
    toast('Signed in. Your pages are syncing.');
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
$('signout-btn').onclick = async () => { await sync.signOut(); setSyncUI('signedout'); toast('Signed out. Pages stay on this device.'); };
$('sync-now').onclick = async () => { const n = await sync.sync(); await renderToday(); toast(n ? `Pulled ${n} page${n === 1 ? '' : 's'}.` : 'Up to date.'); };

// Export: one JSON file with every page and its audio inlined.
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
