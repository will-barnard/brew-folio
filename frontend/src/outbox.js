// Offline quick-add: entries made without a connection wait here and are
// sent when the app is back online. localStorage is fine for a handful of
// small entries; every access is guarded because private browsing can throw.
import { ref } from 'vue';
import { api } from './api';

const KEY = 'folio.outbox';
export const pending = ref(read());

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function write(items) {
  pending.value = items;
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage unavailable — kept in memory */ }
}

export function queue(entry) {
  write([...pending.value, { ...entry, queued_at: new Date().toISOString(), client_id: crypto.randomUUID() }]);
}

let flushing = false;
export async function flush() {
  if (flushing || !pending.value.length || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of [...pending.value]) {
      const { queued_at: _q, client_id, ...body } = item;
      try {
        await api.post('/transactions', body);
      } catch (err) {
        if (err.status === 0) break; // still offline
        // A validation error won't fix itself — drop it but keep a trace in the console.
        console.warn('[outbox] dropped entry', item, err.message);
      }
      write(pending.value.filter((p) => p.client_id !== client_id));
      sent++;
    }
  } finally {
    flushing = false;
  }
  return sent;
}

window.addEventListener('online', () => { flush(); });
