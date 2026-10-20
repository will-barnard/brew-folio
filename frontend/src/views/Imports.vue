<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { shortDate, ago } from '../format';
import Icon from '../components/Icon.vue';

const router = useRouter();
const batches = ref([]);
const receipts = ref([]);
const err = ref('');
const uploading = ref([]);
const dragging = ref(false);

async function load() {
  [batches.value, receipts.value] = await Promise.all([api.get('/imports'), api.get('/receipts?unattached=1')]);
}
load().catch((e) => { err.value = e.message; });

async function send(files) {
  err.value = '';
  const list = [...files];
  uploading.value = list.map((f) => f.name);
  let last = null;
  const problems = [];
  for (const f of list) {
    try { last = await api.upload('/imports', f); }
    catch (e) { problems.push(`${f.name}: ${e.message}`); }
  }
  uploading.value = [];
  err.value = problems.join('\n');
  // One single-account file → straight to its preview. Several, or a statement
  // covering several accounts → stay on the list.
  if (list.length === 1 && last && !last.siblings?.length) router.push(`/imports/${last.id}`); else await load();
}
function onDrop(e) { dragging.value = false; if (e.dataTransfer?.files?.length) send(e.dataTransfer.files); }

const STATUS = { parsed: 'Ready to import', imported: 'Imported', failed: 'Couldn’t read' };
async function viewReceipt(r) { window.open(await api.blobUrl(`/receipts/${r.id}/file`), '_blank', 'noopener'); }
</script>

<template>
  <div>
    <header class="page-head"><h1>Imports</h1></header>

    <label class="drop" :class="{ on: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
      <Icon name="upload" :size="28" />
      <span><strong>Add Chase CSVs and statements, or Fidelity statements</strong></span>
      <span class="small muted">Drop files here or choose them. Nothing touches your ledger until you confirm each one.</span>
      <input type="file" multiple accept=".csv,.CSV,text/csv,application/pdf" class="sr-only" @change="send($event.target.files)" />
    </label>
    <p v-if="uploading.length" class="muted small">Reading {{ uploading.join(', ') }}…</p>
    <p v-if="err" class="error pre">{{ err }}</p>

    <section v-if="receipts.length" class="section">
      <h2>Receipts from your phone</h2>
      <p class="small muted">Sent by the iOS Shortcut. Open a transaction and attach, or view them here.</p>
      <ul class="ledger">
        <li v-for="r in receipts" :key="r.id" class="cat-line">
          <button class="btn quiet" @click="viewReceipt(r)">{{ r.filename }}</button>
          <span class="small muted">{{ ago(r.created_at) }}</span>
        </li>
      </ul>
    </section>

    <section class="section">
      <h2>History</h2>
      <div v-if="!batches.length" class="empty">
        <strong>No imports yet.</strong>
        In Chase, open an account → Download account activity → CSV. Statements are under Statements &amp; documents.
      </div>
      <ul class="ledger">
        <li v-for="b in batches" :key="b.id">
          <RouterLink :to="`/imports/${b.id}`" class="batch">
            <span class="batch-name">{{ b.filename }}</span>
            <span class="small" :class="b.status === 'parsed' ? 'uncat-text' : b.status === 'failed' ? 'danger' : 'muted'">{{ STATUS[b.status] }}</span>
            <span class="small muted batch-meta">
              {{ b.account_name || 'No account yet' }}<template v-if="b.period_start">, {{ shortDate(b.period_start) }} to {{ shortDate(b.period_end) }}</template>
              <template v-if="b.status === 'imported'">: {{ b.stats.inserted }} new, {{ b.stats.merged }} matched</template>
            </span>
            <span v-if="b.reconciled === false" class="small danger">Doesn’t balance</span>
            <span v-else-if="b.reconciled" class="small in">Balances</span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style>
.drop {
  display: grid; justify-items: center; gap: 6px; text-align: center; padding: 28px 16px; cursor: pointer;
  border: 1.5px dashed var(--rule-strong); border-radius: 14px; color: var(--muted);
}
.drop strong { color: var(--text); }
.drop.on, .drop:hover { border-color: var(--brass); background: var(--brass-soft); }
.pre { white-space: pre-line; }
.batch { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); text-decoration: none; }
.batch-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-meta { grid-column: 1; }
</style>
