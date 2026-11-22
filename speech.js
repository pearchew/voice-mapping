// Live speech-to-text while recording, using the browser's built-in recogniser
// (Safari on iPhone, Chrome/Edge on laptops). Nothing is shown while you speak;
// the transcript appears on the review screen.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const supported = Boolean(SR);

export function createTranscriber() {
  let rec = null, active = false, failed = null;
  const segments = [];
  let interim = '';
  let endResolve = null;

  function boot() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-GB';
    rec.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) segments.push(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) { failed = e.error; active = false; }
    };
    rec.onend = () => {
      if (active) { try { rec.start(); return; } catch { /* fall through */ } }
      endResolve?.();
    };
    try { rec.start(); } catch (e) { failed = e.message; }
  }

  return {
    start() { if (!SR) return; active = true; boot(); },
    async stop() {
      if (!rec) return { segments: [], failed: failed || 'unsupported' };
      active = false;
      await new Promise((resolve) => {
        endResolve = resolve;
        try { rec.stop(); } catch { resolve(); }
        setTimeout(resolve, 1800); // don't wait forever for the final result
      });
      const all = segments.slice();
      if (interim.trim()) all.push(interim.trim());
      return { segments: all, failed };
    },
    abort() { active = false; try { rec?.abort(); } catch { /* ignore */ } },
  };
}
