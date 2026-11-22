import { PROMPTS } from './prompts.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { createTranscriber, supported as speechSupported } from './speech.js';
import { analyseAudio, analyseTranscript, renderTranscript, ENDING_COPY } from './analysis.js';

const LIMIT = 60;          // seconds
const CUE_AT = 50;         // "start landing your thought"
const ENDING_SECS = 10;
const RING_C = 2 * Math.PI * 86;
const SVGNS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ───────── Dates ─────────
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
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
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
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

// ───────── Today ─────────
function computeStreak(dates, today) {
  const set = new Set(dates);
  let k = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(k)) { n++; k = addDays(k, -1); }
  return n;
}

let todayPrompt = null;
async function renderToday() {
  const today = todayKey();
  const sessions = await allSessions();
  const done = sessions.find(s => s.date === today);
  todayPrompt = done ? { id: done.promptId, text: done.promptText, cat: '' } : await promptFor(today);

  $('today-date').textContent = fmtLong(today);
  $('today-cat').textContent = todayPrompt.cat ? `Today's question · ${todayPrompt.cat}` : "Today's question";
  $('today-question').textContent = todayPrompt.text;

  const prev = sessions.find(s => s.date < today && s.note && s.note.trim());
  $('focus-block').hidden = !prev;
  if (prev) $('focus-text').textContent = prev.note;

  $('today-todo').hidden = !!done;
  $('today-done').hidden = !done;
  if (done) {
    $('today-note').textContent = done.note ? `Tomorrow: ${done.note}` : '';
    $('today-play').onclick = (e) => playSession(done, e.currentTarget);
  }

  // Streak + last 7 days
  const dates = sessions.map(s => s.date);
  const streak = computeStreak(dates, today);
  const chip = $('streak-chip');
  chip.hidden = !streak;
  chip.textContent = `${streak} day${streak === 1 ? '' : 's'} in a row`;
  const set = new Set(dates);
  const week = $('week');
  week.innerHTML = '';
  for (let i = 6; i >= 0; i--) {
    const k = addDays(today, -i);
    const li = document.createElement('li');
    li.className = (set.has(k) ? 'on ' : '') + (i === 0 ? 'today' : '');
    li.innerHTML = '<i></i>';
    li.append(parseKey(k).toLocaleDateString(undefined, { weekday: 'narrow' }));
    li.title = `${fmtShort(k)}: ${set.has(k) ? 'practised' : 'missed'}`;
    week.append(li);
  }

  const recent = sessions.filter(s => s.date > addDays(today, -14));
  const withEnd = recent.filter(s => s.analysis?.ending && s.analysis.ending !== 'silent');
  const landed = withEnd.filter(s => s.analysis.ending === 'landed').length;
  const pres = recent.filter(s => s.presence);
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  $('stats').innerHTML =
    stat('Streak', streak) +
    stat('Endings landed', withEnd.length ? `${Math.round((landed / withEnd.length) * 100)}%` : '–') +
    stat('Presence', pres.length ? (pres.reduce((a, s) => a + s.presence, 0) / pres.length).toFixed(1) : '–');
}

$('skip-btn').onclick = async () => {
  const k = `skip:${todayKey()}`;
  await db.put('meta', ((await db.get('meta', k)) || 0) + 1, k);
  await renderToday();
};

// ───────── Recording ─────────
let stream = null, recorder = null, chunks = [], recStart = 0, raf = 0, cancelled = false, transcriber = null;
let take = null; // { blob, seconds, analysis, transcript, tAnalysis }

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
  transcriber = speechSupported ? createTranscriber() : null;
  transcriber?.start();
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
  $('finish-btn').textContent = 'Preparing…';
  const [speech, analysis] = await Promise.all([
    transcriber ? transcriber.stop() : Promise.resolve({ segments: [], failed: 'unsupported' }),
    analyseAudio(blob, LIMIT).catch(e => { console.warn('analysis failed', e); return null; }),
  ]);
  $('finish-btn').textContent = 'Finish';
  const seconds = analysis?.duration || recSeconds;
  const tA = analyseTranscript(speech.segments, seconds);
  take = { blob, seconds, analysis, transcript: tA?.text || '', tAnalysis: tA, speechFailed: speech.failed };
  document.querySelectorAll('#s-review input, [data-screen="review"] input').forEach(i => { i.checked = false; });
  $('note-input').value = '';
  $('note-hint').textContent = 'Keep it to one thing you can actually try.';
  renderReview();
  show('review');
}

$('begin-btn').onclick = begin;
$('redo-btn').onclick = begin;
$('retake-btn').onclick = begin;
$('finish-btn').onclick = stopRecording;
$('cancel-ready').onclick = () => { cancelled = true; releaseMic(); show('today'); };

// ───────── Waveform ─────────
function drawWave(svg, analysis, { endZone = false } = {}) {
  svg.innerHTML = '';
  const W = 1000, H = 100;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const peaks = analysis?.peaks || [];
  const dur = analysis?.duration || 1;
  if (!peaks.length) return { setProgress() {} };
  for (const p of analysis.pauses || []) {
    const r = svgEl('rect', { class: 'pause', x: (p.start / dur) * W, y: 0, width: Math.max(4, ((p.end - p.start) / dur) * W), height: H, rx: 6 });
    const t = svgEl('title'); t.textContent = `Pause ${(p.end - p.start).toFixed(1)}s at ${fmtTime(p.start)}`; r.append(t);
    svg.append(r);
  }
  if (endZone && analysis.speechEnd) {
    const s = Math.max(0, analysis.speechEnd - ENDING_SECS);
    svg.append(svgEl('rect', { class: 'endzone', x: (s / dur) * W, y: 1, width: ((analysis.speechEnd - s) / dur) * W, height: H - 2, rx: 6, 'vector-effect': 'non-scaling-stroke' }));
  }
  const n = peaks.length, slot = W / n, bw = slot * 0.62;
  const bars = peaks.map((p, i) => {
    const h = Math.max(3, p * (H - 8));
    const r = svgEl('rect', { class: 'bar', x: i * slot + (slot - bw) / 2, y: (H - h) / 2, width: bw, height: h, rx: 1.5 });
    svg.append(r);
    return r;
  });
  return { setProgress(frac) { bars.forEach((b, i) => b.classList.toggle('played', (i + 0.5) / n <= frac)); } };
}

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
  if (blob) play(blob, btn, { dur: s.analysis?.duration, ...opts });
}

// ───────── Review ─────────
let reviewWave = null;
function renderEnding(el, analysis) {
  el.innerHTML = '';
  if (!analysis) { el.textContent = 'Couldn’t analyse this recording.'; return; }
  const c = ENDING_COPY[analysis.ending];
  const b = document.createElement('span'); b.className = `badge ${analysis.ending}`; b.textContent = c.label;
  const d = document.createElement('span'); d.textContent = c.detail;
  el.append(b, d);
}
function pauseLine(analysis) {
  if (!analysis?.pauses) return '';
  const n = analysis.pauses.length;
  if (!n) return 'No long pauses. Shaded areas on the waveform will show pauses over 1.2 seconds.';
  const longest = Math.max(...analysis.pauses.map(p => p.end - p.start));
  return `${n} pause${n === 1 ? '' : 's'} over 1.2 seconds (longest ${longest.toFixed(1)}s), shaded on the waveform. The dashed box marks your last ${ENDING_SECS} seconds.`;
}
function renderTStats(el, tA) {
  el.innerHTML = '';
  if (!tA) return;
  const add = (k, v, title) => { const d = document.createElement('div'); d.title = title; d.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`; el.append(d); };
  add('Words', tA.words, 'Words recognised');
  if (tA.wpm) add('Pace', `${tA.wpm} wpm`, 'Words per minute. About 130–160 is a relaxed speaking pace.');
  add('Fillers', tA.fillerTotal, Object.entries(tA.fillers).map(([k, v]) => `${k} ×${v}`).join(', ') || 'None found');
}
function transcriptInto(el, text, tA, failed) {
  el.classList.toggle('empty', !text);
  if (text) { renderTranscript(el, text, tA?.lastSentence); return; }
  el.textContent = failed === 'unsupported'
    ? 'This browser doesn’t offer speech-to-text. Safari on iPhone and Chrome on a laptop do.'
    : failed ? 'Speech-to-text was blocked. Allow Speech Recognition for Safari (Settings → Privacy → Speech Recognition).'
      : 'No words were picked up this time.';
}

function renderReview() {
  $('review-question').textContent = todayPrompt.text;
  const a = take.analysis;
  reviewWave = drawWave($('review-wave'), a, { endZone: true });
  $('review-time').textContent = fmtTime(take.seconds);
  renderEnding($('ending'), a);
  $('pause-line').textContent = pauseLine(a);
  $('ending-btn').disabled = !a?.speechEnd;
  renderTStats($('tstats'), take.tAnalysis);
  transcriptInto($('transcript'), take.transcript, take.tAnalysis, take.speechFailed);
  $('t-legend').hidden = !take.transcript;
}
const reviewProgress = (t, d) => {
  reviewWave?.setProgress(d ? t / d : 0);
  $('review-time').textContent = fmtTime(t || 0);
};
$('review-play').onclick = (e) => play(take.blob, e.currentTarget, { dur: take.seconds, progress: reviewProgress });
$('ending-btn').onclick = () => {
  const a = take.analysis;
  play(take.blob, $('review-play'), { dur: take.seconds, from: Math.max(0, a.speechEnd - ENDING_SECS), progress: reviewProgress });
};
$('review-wave').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  play(take.blob, $('review-play'), { dur: take.seconds, from: frac * (take.analysis?.duration || take.seconds), progress: reviewProgress });
});

$('save-btn').onclick = async () => {
  const note = $('note-input').value.trim();
  if (!note) { $('note-hint').textContent = 'Write one small thing. It becomes tomorrow’s focus.'; $('note-input').focus(); return; }
  const date = todayKey();
  const finished = document.querySelector('input[name="finished"]:checked')?.value ?? null;
  const presence = Number(document.querySelector('input[name="presence"]:checked')?.value) || null;
  const prev = await db.get('sessions', date);
  const a = take.analysis, t = take.tAnalysis;
  await db.put('audio', take.blob, date);
  await db.put('sessions', {
    date, promptId: todayPrompt.id, promptText: todayPrompt.text,
    finished, presence, note,
    transcript: take.transcript || '',
    analysis: a || t ? {
      ...(a || {}),
      ...(t ? { words: t.words, wpm: t.wpm, fillers: t.fillers, fillerTotal: t.fillerTotal, lastSentence: t.lastSentence } : {}),
    } : null,
    audioPath: prev?.audioPath ?? null, audioType: take.blob.type,
    updatedAt: new Date().toISOString(),
    synced: false, audioDirty: true,
  });
  $('done-note').textContent = `Tomorrow: ${note}`;
  show('done');
  sync.sync().then(n => n && renderToday());
};
$('done-btn').onclick = async () => { await renderToday(); show('today'); };

// ───────── History ─────────
const FINISHED_LABEL = { yes: 'Finished ✓', partly: 'Partly finished', no: 'Didn’t finish' };
async function renderHistory() {
  const sessions = await allSessions();
  $('history-count').textContent = sessions.length ? `${sessions.length} day${sessions.length === 1 ? '' : 's'} of practice` : '';
  const list = $('entries');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<li class="card empty-state">No days yet. Your first one starts today.</li>';
    $('trend').innerHTML = '';
    return;
  }
  for (const s of sessions) list.append(entryCard(s));
  renderTrends(sessions.slice(0, 30).reverse());
}

function entryCard(s) {
  const li = document.createElement('li');
  li.className = 'card entry';
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
    <details><summary>Waveform and transcript</summary>
      <svg class="wave" preserveAspectRatio="none" role="img" aria-label="Waveform"></svg>
      <p class="transcript"></p>
    </details>`;
  li.querySelector('.entry-date').textContent = fmtShort(s.date);
  li.querySelector('.entry-q').textContent = s.promptText;
  const tags = li.querySelector('.entry-tags');
  const tag = (text, cls = '') => { const t = document.createElement('span'); t.className = `tag ${cls}`; t.textContent = text; tags.append(t); };
  const a = s.analysis;
  if (a?.ending) { const b = document.createElement('span'); b.className = `badge ${a.ending}`; b.textContent = ENDING_COPY[a.ending].label; tags.append(b); }
  if (s.finished) tag(FINISHED_LABEL[s.finished]);
  if (s.presence) tag(`Presence ${s.presence}/5`);
  if (a?.wpm) tag(`${a.wpm} wpm`);
  if (a?.fillerTotal != null) tag(`${a.fillerTotal} filler${a.fillerTotal === 1 ? '' : 's'}`);
  const note = li.querySelector('.entry-note');
  if (s.note) note.textContent = `Tomorrow: ${s.note}`; else note.remove();

  const details = li.querySelector('details');
  if (!a?.peaks && !s.transcript) details.remove();
  let wave = null;
  details?.addEventListener('toggle', () => {
    if (!details.open || wave) return;
    wave = drawWave(details.querySelector('.wave'), a);
    if (!a?.peaks) details.querySelector('.wave').remove();
    transcriptInto(details.querySelector('.transcript'), s.transcript, a, null);
  });
  const btn = li.querySelector('.play');
  const progress = (t, d) => wave?.setProgress(d ? t / d : 0);
  btn.onclick = () => playSession(s, btn, { progress });
  details?.querySelector('.wave')?.addEventListener('click', async (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    playSession(s, btn, { from: frac * (a?.duration || 60), progress });
  });
  return li;
}

// Two small single-series charts (different scales → never one dual-axis chart).
function renderTrends(rows) {
  const el = $('trend');
  el.innerHTML = '';
  if (rows.length < 2) { el.innerHTML = '<p class="hint">Trends appear after a couple of days.</p>'; return; }
  const score = { yes: 1, partly: 0.5, no: 0 };
  const presence = rows.map(r => ({ date: r.date, v: r.presence ?? null }));
  const finished = rows.map((_, i) => {
    const win = rows.slice(Math.max(0, i - 4), i + 1).map(r => score[r.finished]).filter(v => v != null);
    return { date: rows[i].date, v: win.length ? Math.round((win.reduce((a, b) => a + b, 0) / win.length) * 100) : null };
  });
  el.append(
    chartCard('Presence', 'Your 1–5 rating each day', presence, { min: 1, max: 5, ticks: [1, 3, 5], color: 'var(--chart-a)', fmt: v => `${v}/5` }),
    chartCard('Finished thoughts', 'Rolling 5-day share of answers you finished', finished, { min: 0, max: 100, ticks: [0, 50, 100], color: 'var(--chart-b)', fmt: v => `${v}%`, tick: v => `${v}%` }),
  );
}

function chartCard(title, sub, pts, { min, max, ticks, color, fmt, tick = String }) {
  const card = document.createElement('article');
  card.className = 'card chart-card';
  card.innerHTML = `<h3></h3><p class="sub"></p><div class="chart"></div>`;
  card.querySelector('h3').textContent = title;
  card.querySelector('.sub').textContent = sub;
  const W = 320, H = 120, L = 30, R = 8, T = 8, B = 8;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title} over the last ${pts.length} days` });
  const x = i => L + (i / (pts.length - 1)) * (W - L - R);
  const y = v => T + (1 - (v - min) / (max - min)) * (H - T - B);
  for (const t of ticks) {
    svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
    const lab = svgEl('text', { class: 'axis', x: L - 8, y: y(t) + 4, 'text-anchor': 'end' }); lab.textContent = tick(t); svg.append(lab);
  }
  let d = '';
  pts.forEach((p, i) => { if (p.v == null) return; d += `${d && pts[i - 1]?.v != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)} `; });
  svg.append(svgEl('path', { class: 'line', d, stroke: color }));
  pts.forEach((p, i) => { if (p.v != null && (pts.length <= 14 || i === pts.length - 1)) svg.append(svgEl('circle', { class: 'dot', cx: x(i), cy: y(p.v), r: 4, fill: color })); });
  const cross = svgEl('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' });
  const hot = svgEl('circle', { class: 'dot', r: 5, fill: color, visibility: 'hidden' });
  const hit = svgEl('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' });
  svg.append(cross, hot, hit);
  const tip = $('tooltip');
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((sx - L) / (W - L - R)) * (pts.length - 1));
    const p = pts[Math.max(0, Math.min(pts.length - 1, i))];
    const idx = pts.indexOf(p);
    cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx)); cross.setAttribute('visibility', 'visible');
    if (p.v != null) { hot.setAttribute('cx', x(idx)); hot.setAttribute('cy', y(p.v)); hot.setAttribute('visibility', 'visible'); } else hot.setAttribute('visibility', 'hidden');
    tip.hidden = false;
    tip.textContent = `${fmtShort(p.date)} · ${p.v == null ? 'not rated' : fmt(p.v)}`;
    tip.style.left = `${r.left + (x(idx) / W) * r.width}px`;
    tip.style.top = `${r.top + ((p.v == null ? T : y(p.v)) / H) * r.height}px`;
  };
  const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
  card.querySelector('.chart').append(svg);
  return card;
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

async function renderMine() {
  const mine = (await db.all('prompts')).filter(p => !p.deleted);
  const ul = $('my-prompts');
  ul.innerHTML = '';
  for (const p of mine) {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = p.text;
    const b = document.createElement('button'); b.className = 'btn ghost small'; b.textContent = 'Remove';
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
    if (to === 'settings') await renderMine();
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
