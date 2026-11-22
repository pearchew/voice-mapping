// Sync between devices through Supabase. Local IndexedDB stays the source the
// UI reads from; this module pushes unsynced pages up and pulls newer ones down.
// Conflicts resolve last-write-wins on updatedAt.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import * as db from './db.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
let client = null;
let user = null;
let running = null;
const listeners = new Set();

export const configured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);
export const currentUser = () => user;
export function onStatus(fn) { listeners.add(fn); }
function emit(state, detail = '') { listeners.forEach(fn => fn(state, detail)); }

export async function init() {
  if (!configured()) { emit('off'); return null; }
  try {
    const { createClient } = await import(SDK);
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const { data } = await client.auth.getSession();
    user = data.session?.user ?? null;
    client.auth.onAuthStateChange((_e, session) => {
      const was = user?.id;
      user = session?.user ?? null;
      if (user?.id !== was) emit(user ? 'idle' : 'signedout');
    });
    emit(user ? 'idle' : 'signedout');
    return user;
  } catch (e) {
    console.warn('sync init failed', e);
    emit('error', 'Offline — will sync later.');
    return null;
  }
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  user = data.user;
  return user;
}

export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({
    email, password, options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  if (data.session) user = data.user;
  return { needsConfirm: !data.session };
}

export async function signOut() {
  await client.auth.signOut();
  user = null;
  await db.put('meta', null, 'lastPull');
}

const extFor = (type = '') => (type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a');

async function push() {
  const sessions = (await db.all('sessions')).filter(s => !s.synced);
  for (const s of sessions) {
    if (s.audioDirty) {
      const blob = await db.get('audio', s.date);
      if (blob) {
        const path = `${user.id}/${s.date}.${extFor(blob.type)}`;
        const { error } = await client.storage.from('recordings').upload(path, blob, {
          upsert: true, contentType: blob.type || 'audio/mp4',
        });
        if (error) throw error;
        s.audioPath = path;
        s.audioType = blob.type;
      }
    }
    const { error } = await client.from('sessions').upsert({
      user_id: user.id,
      date: s.date,
      prompt_id: s.promptId,
      prompt_text: s.promptText,
      finished: s.finished ?? null,
      presence: s.presence ?? null,
      note: s.note ?? '',
      transcript: s.transcript ?? null,
      analysis: s.analysis ?? null,
      audio_path: s.audioPath ?? null,
      audio_type: s.audioType ?? null,
      updated_at: s.updatedAt,
    }, { onConflict: 'user_id,date' });
    if (error) throw error;
    // Only mark synced if nothing changed locally while we were uploading.
    const latest = await db.get('sessions', s.date);
    if (latest && latest.updatedAt === s.updatedAt) {
      await db.put('sessions', { ...latest, audioPath: s.audioPath, audioType: s.audioType, audioDirty: false, synced: true });
    }
  }

  const prompts = (await db.all('prompts')).filter(p => !p.synced);
  for (const p of prompts) {
    const { error } = await client.from('prompts').upsert({
      id: p.id, user_id: user.id, text: p.text, deleted: !!p.deleted, updated_at: p.updatedAt,
    }, { onConflict: 'id' });
    if (error) throw error;
    await db.put('prompts', { ...p, synced: true });
  }
}

async function pull() {
  const since = (await db.get('meta', 'lastPull')) || '1970-01-01T00:00:00Z';
  const { data, error } = await client.from('sessions').select('*').gt('updated_at', since).order('updated_at');
  if (error) throw error;
  let newest = since;
  let changed = 0;
  for (const r of data) {
    if (r.updated_at > newest) newest = r.updated_at;
    const local = await db.get('sessions', r.date);
    if (local && !local.synced && local.updatedAt >= r.updated_at) continue; // local edit wins
    if (local && local.updatedAt === r.updated_at) continue;
    const audioChanged = !local || local.audioPath !== r.audio_path || (local.updatedAt < r.updated_at && r.audio_path);
    await db.put('sessions', {
      date: r.date, promptId: r.prompt_id, promptText: r.prompt_text,
      finished: r.finished, presence: r.presence, note: r.note,
      transcript: r.transcript, analysis: r.analysis,
      audioPath: r.audio_path, audioType: r.audio_type,
      updatedAt: r.updated_at, synced: true, audioDirty: false,
    });
    if (audioChanged) await db.del('audio', r.date); // fetched again on demand
    changed++;
  }
  await db.put('meta', newest, 'lastPull');

  const pr = await client.from('prompts').select('*');
  if (pr.error) throw pr.error;
  for (const r of pr.data) {
    const local = await db.get('prompts', r.id);
    if (local && !local.synced && local.updatedAt >= r.updated_at) continue;
    await db.put('prompts', { id: r.id, text: r.text, deleted: r.deleted, createdAt: r.created_at, updatedAt: r.updated_at, synced: true });
  }
  return changed;
}

export async function sync() {
  if (!client || !user) return 0;
  if (!navigator.onLine) { emit('error', 'Offline — will sync later.'); return 0; }
  if (running) return running;
  emit('syncing');
  running = (async () => {
    try {
      await push();
      const changed = await pull();
      await db.put('meta', new Date().toISOString(), 'lastSync');
      emit('ok');
      return changed;
    } catch (e) {
      console.warn('sync failed', e);
      emit('error', e.message || 'Sync failed');
      return 0;
    } finally {
      running = null;
    }
  })();
  return running;
}

// Download a recording made on another device and cache it locally.
export async function fetchAudio(session) {
  if (!client || !user || !session.audioPath) return null;
  const { data, error } = await client.storage.from('recordings').download(session.audioPath);
  if (error) throw error;
  await db.put('audio', data, session.date);
  return data;
}
