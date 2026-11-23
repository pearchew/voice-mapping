// Finds the silences inside a recording, on the device, from loudness alone.
// No transcription: it works the same in any language.

export const MIN_PAUSE = 1;   // seconds; the default, changeable in Settings
export const PAUSE_CHOICES = [0.75, 1, 1.5, 2];

// samples: mono Float32Array, rate: samples per second.
// Returns [{ start, end }] in seconds, only for silences between your first and last words.
export function findPauses(samples, rate, minPause = MIN_PAUSE) {
  const frame = Math.round(rate * 0.05); // 50 ms
  const n = Math.floor(samples.length / frame);
  if (n < 10) return [];
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * frame, end = i + frame; i < end; i++) sum += samples[i] * samples[i];
    db[f] = 10 * Math.log10(sum / frame + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const voice = sorted[Math.floor(n * 0.9)];
  if (voice - floor < 10) return []; // too flat to tell speech from silence
  const threshold = floor + (voice - floor) * 0.3;

  // Smooth over a few frames so the gaps between syllables don't count.
  const loud = Array.from(db, (_, f) => {
    for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) if (db[k] > threshold) return true;
    return false;
  });
  const first = loud.indexOf(true), last = loud.lastIndexOf(true);
  if (first < 0) return [];

  const pauses = [];
  const secs = frame / rate;
  let runStart = -1;
  for (let f = first; f <= last; f++) {
    if (!loud[f]) { if (runStart < 0) runStart = f; continue; }
    // The smoothing trims 2 frames off each side of a silence; add them back.
    if (runStart >= 0) {
      const start = (runStart - 2) * secs, end = (f + 2) * secs;
      if (end - start >= minPause) pauses.push({ start, end });
    }
    runStart = -1;
  }
  return pauses;
}

// Decodes a recording and finds its pauses. Resolves to null if the browser can't decode it.
export async function pausesIn(blob, minPause = MIN_PAUSE) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return { pauses: findPauses(buf.getChannelData(0), buf.sampleRate, minPause), duration: buf.duration };
  } catch {
    return null;
  } finally {
    ctx.close?.();
  }
}
