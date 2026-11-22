// Review aids: waveform + ending check from the audio, and transcript stats.

const FRAME = 0.05;          // seconds per analysis frame
const MIN_PAUSE = 1.2;       // seconds of quiet that counts as a pause
const END_WINDOW = 2;        // seconds before speech ends used for the trailing-off check
export const BARS = 140;

const quantile = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0; };

export async function analyseAudio(blob, limit = 60) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close?.();
  }
  const data = buf.getChannelData(0);
  const rate = buf.sampleRate;
  const duration = buf.duration;
  const step = Math.max(1, Math.round(FRAME * rate));
  const rms = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0; const end = Math.min(data.length, i + step);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    rms.push(Math.sqrt(sum / (end - i)));
  }

  // Voice activity: above a threshold set between the noise floor and the loud parts.
  const floor = quantile(rms, 0.1);
  const loud = quantile(rms, 0.95);
  const thr = Math.max(floor * 2.5, floor + (loud - floor) * 0.12, 0.004);
  const raw = rms.map(v => v > thr);
  // Hangover: bridge tiny gaps between syllables (< 250 ms).
  const voiced = raw.slice();
  const bridge = Math.round(0.25 / FRAME);
  for (let i = 0, gap = 0; i < raw.length; i++) {
    if (raw[i]) { if (gap && gap <= bridge) for (let k = i - gap; k < i; k++) voiced[k] = true; gap = 0; } else gap++;
  }

  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  const peaks = toBars(rms, BARS, loud || 1);
  if (first < 0) return { duration, peaks, pauses: [], speechStart: 0, speechEnd: 0, ending: 'silent' };

  const pauses = [];
  for (let i = first, run = 0; i <= last + 1; i++) {
    if (i <= last && !voiced[i]) run++;
    else {
      if (run * FRAME >= MIN_PAUSE) pauses.push({ start: +((i - run) * FRAME).toFixed(2), end: +(i * FRAME).toFixed(2) });
      run = 0;
    }
  }

  const speechStart = first * FRAME;
  const speechEnd = Math.min(duration, (last + 1) * FRAME);
  // Compare the loud points (syllable peaks) of the final stretch with your
  // typical speaking level. Peaks ignore the natural gaps between words.
  const body = quantile(rms.slice(first, last + 1).filter((_, i) => voiced[first + i]), 0.8);
  const tailFrames = rms.slice(Math.max(first, last - Math.round(END_WINDOW / FRAME)), last + 1);
  const tailLevel = quantile(tailFrames, 0.8);
  const ratio = body ? tailLevel / body : 1;

  let ending = 'landed';
  if (duration >= limit - 1 && duration - speechEnd < 0.6) ending = 'cutoff';
  else if (ratio < 0.55) ending = 'trailed';

  return { duration: +duration.toFixed(2), peaks, pauses, speechStart: +speechStart.toFixed(2), speechEnd: +speechEnd.toFixed(2), ending, endRatio: +ratio.toFixed(2) };
}

function toBars(rms, n, max) {
  const out = [];
  const per = rms.length / n;
  for (let b = 0; b < n; b++) {
    const s = Math.floor(b * per), e = Math.max(s + 1, Math.floor((b + 1) * per));
    let m = 0; for (let i = s; i < e && i < rms.length; i++) m = Math.max(m, rms[i]);
    out.push(+Math.min(1, m / max).toFixed(3));
  }
  return out;
}

export const ENDING_COPY = {
  landed: { label: 'Landed', detail: 'Your voice held steady through the last sentence.' },
  trailed: { label: 'Trailed off', detail: 'Your volume dropped in the last few seconds. Try finishing at full voice.' },
  cutoff: { label: 'Cut off', detail: 'You were still talking when time ran out. Start landing at the 10-second cue.' },
  silent: { label: 'No speech found', detail: 'The recording was mostly quiet.' },
};

// ───────── Transcript ─────────
export const FILLER_RE = /\b(u+m+|u+h+|e+r+m+|e+r+|a+h+|h+m+|like|you know|sort of|kind of|basically|actually|literally|i mean)\b/gi;

export function analyseTranscript(segments, seconds) {
  const text = segments.map(s => s.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const words = text.split(/\s+/).filter(w => /\w/.test(w)).length;
  const fillers = {};
  for (const m of text.matchAll(FILLER_RE)) { const k = m[0].toLowerCase(); fillers[k] = (fillers[k] || 0) + 1; }
  const fillerTotal = Object.values(fillers).reduce((a, b) => a + b, 0);

  // Final thought: last punctuated sentence, else the last recognised phrase.
  let lastSentence = null;
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];
  if (sentences.length > 1) lastSentence = sentences[sentences.length - 1];
  else if (segments.length > 1) lastSentence = segments[segments.length - 1].trim();
  else if (words > 12) lastSentence = text.split(/\s+/).slice(-12).join(' ');

  return { words, wpm: seconds > 5 ? Math.round(words / (seconds / 60)) : null, fillers, fillerTotal, lastSentence, text };
}

// Build transcript DOM with fillers marked and the final thought highlighted.
export function renderTranscript(el, text, lastSentence) {
  el.textContent = '';
  if (!text) return;
  let head = text, tail = '';
  if (lastSentence) {
    const at = text.lastIndexOf(lastSentence);
    if (at >= 0) { head = text.slice(0, at); tail = text.slice(at); }
  }
  const addWithFillers = (parent, str) => {
    let i = 0;
    for (const m of str.matchAll(FILLER_RE)) {
      parent.append(str.slice(i, m.index));
      const f = document.createElement('span'); f.className = 'filler'; f.textContent = m[0]; f.title = 'Filler';
      parent.append(f);
      i = m.index + m[0].length;
    }
    parent.append(str.slice(i));
  };
  addWithFillers(el, head);
  if (tail) {
    const mk = document.createElement('mark'); mk.className = 'last'; mk.title = 'Your final thought';
    addWithFillers(mk, tail);
    el.append(mk);
  }
}
