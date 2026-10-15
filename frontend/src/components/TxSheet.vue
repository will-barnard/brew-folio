<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { money, dayLabel, parseCents, shortDate } from '../format';
import { toast } from '../toast';
import Sheet from './Sheet.vue';
import Money from './Money.vue';
import CategoryPicker from './CategoryPicker.vue';
import StreamChips from './StreamChips.vue';

const props = defineProps({ id: { type: Number, required: true } });
const emit = defineEmits(['close', 'changed']);
const refs = useRef();

const t = ref(null);
const err = ref('');
const busy = ref(false);
const form = ref({ category_id: null, stream_id: null, notes: '', merchant: '' });
const splitting = ref(false);
const splits = ref([]);
const candidates = ref(null);
const pickingCat = ref(false);

async function load() {
  err.value = '';
  t.value = await api.get(`/transactions/${props.id}`);
  form.value = { category_id: t.value.category_id, stream_id: t.value.stream_id, notes: t.value.notes || '', merchant: t.value.merchant || '' };
  splits.value = t.value.splits.map((s) => ({ amount: (Math.abs(s.amount_cents) / 100).toFixed(2), category_id: s.category_id, stream_id: s.stream_id }));
  splitting.value = t.value.is_split;
  candidates.value = null;
  pickingCat.value = !t.value.category_id;
}
watch(() => props.id, load, { immediate: true });

const direction = computed(() => (t.value?.amount_cents > 0 ? 'in' : 'out'));
const sign = computed(() => (t.value?.amount_cents < 0 ? -1 : 1));

async function run(fn, done) {
  busy.value = true; err.value = '';
  try { await fn(); if (done) toast(done); emit('changed'); await load(); } catch (e) { err.value = e.message; } finally { busy.value = false; }
}

const save = () => run(() => api.patch(`/transactions/${props.id}`, {
  category_id: form.value.category_id, stream_id: form.value.stream_id,
  notes: form.value.notes || null, merchant: form.value.merchant || null,
}), 'Saved');

// ── splits ──
function startSplit() {
  const half = Math.floor(Math.abs(t.value.amount_cents) / 2);
  splits.value = [
    { amount: (half / 100).toFixed(2), category_id: form.value.category_id, stream_id: null },
    { amount: ((Math.abs(t.value.amount_cents) - half) / 100).toFixed(2), category_id: null, stream_id: null },
  ];
  splitting.value = true;
}
const splitTotal = computed(() => splits.value.reduce((a, s) => a + (parseCents(s.amount) ?? 0), 0));
const splitLeft = computed(() => (t.value ? Math.abs(t.value.amount_cents) - splitTotal.value : 0));
const saveSplits = () => run(() => api.put(`/transactions/${props.id}/splits`, {
  splits: splits.value.map((s) => ({ amount_cents: sign.value * (parseCents(s.amount) ?? 0), category_id: s.category_id, stream_id: s.stream_id })),
}), 'Split saved');
const unsplit = () => run(() => api.put(`/transactions/${props.id}/splits`, { splits: [] }), 'Split removed');

// ── transfers ──
async function findPartners() { candidates.value = await api.get(`/transactions/${props.id}/transfer-candidates`); }
const pair = (pid) => run(() => api.post(`/transactions/${props.id}/transfer`, { partner_id: pid }), 'Marked as a transfer');
const unpair = () => run(() => api.del(`/transactions/${props.id}/transfer`), 'Transfer unlinked');

// ── receipts ──
async function attach(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await run(() => api.upload(`/transactions/${props.id}/receipts`, file), 'Receipt attached');
}
async function viewReceipt(r) {
  try { window.open(await api.blobUrl(`/receipts/${r.id}/file`), '_blank', 'noopener'); } catch (e) { err.value = e.message; }
}

async function remove() {
  if (!window.confirm('Delete this entry?')) return;
  busy.value = true;
  try { await api.del(`/transactions/${props.id}`); toast('Deleted'); emit('changed'); emit('close'); }
  catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <Sheet :title="t ? (t.merchant || 'Transaction') : 'Transaction'" @close="emit('close')">
    <div v-if="!t" class="muted">Loading…</div>
    <div v-else class="tx">
      <div class="tx-top">
        <Money :cents="t.amount_cents" hero color-in />
        <div class="muted small">{{ dayLabel(t.posted_on) }} in {{ t.account_name }}</div>
        <div class="faint small raw">{{ t.description_raw }}</div>
      </div>

      <p v-if="err" class="error">{{ err }}</p>

      <div v-if="t.transfer_group_id" class="note">
        Transfer with {{ t.transfer_partner ? `${t.transfer_partner.account_name}, ${shortDate(t.transfer_partner.posted_on)}` : 'an account not imported yet' }}.
        Transfers don’t count as income or spending.
        <div><button class="btn quiet small" :disabled="busy" @click="unpair">Not a transfer</button></div>
      </div>

      <template v-if="!splitting">
        <div class="field"><span>Category</span>
          <div v-if="!pickingCat" class="chips">
            <span class="chip" aria-pressed="true">{{ refs.categoryPath(form.category_id) }}</span>
            <button type="button" class="btn quiet" @click="pickingCat = true">Change</button>
          </div>
          <CategoryPicker v-else v-model="form.category_id" :direction="direction" />
        </div>
        <div class="field"><span>Income stream</span><StreamChips v-model="form.stream_id" /></div>
      </template>

      <div v-else class="panel split">
        <h3>Split {{ money(Math.abs(t.amount_cents)) }}</h3>
        <div v-for="(s, i) in splits" :key="i" class="split-part">
          <div class="row-fields">
            <label class="field"><span>Amount</span><input v-model="s.amount" class="input" inputmode="decimal" /></label>
            <label class="field"><span>Category</span>
              <select v-model="s.category_id" class="input">
                <option :value="null">Choose…</option>
                <optgroup v-for="g in refs.categoryTree" :key="g.id" :label="g.name">
                  <option v-for="c in g.children" :key="c.id" :value="c.id">{{ c.name }}</option>
                </optgroup>
              </select>
            </label>
          </div>
          <StreamChips v-model="s.stream_id" />
          <button v-if="splits.length > 2" class="btn quiet small" @click="splits.splice(i, 1)">Remove part</button>
        </div>
        <p class="small" :class="splitLeft === 0 ? 'muted' : 'danger'">
          {{ splitLeft === 0 ? 'Parts add up.' : `${money(Math.abs(splitLeft))} ${splitLeft > 0 ? 'left to assign' : 'over'}` }}
        </p>
        <div class="actions-row">
          <button class="btn" @click="splits.push({ amount: (Math.max(splitLeft, 0) / 100).toFixed(2), category_id: null, stream_id: null })">Add part</button>
          <button class="btn primary" :disabled="busy || splitLeft !== 0" @click="saveSplits">Save split</button>
          <button v-if="t.is_split" class="btn quiet" :disabled="busy" @click="unsplit">Remove split</button>
          <button v-else class="btn quiet" @click="splitting = false">Cancel</button>
        </div>
      </div>

      <label class="field"><span>Name</span><input v-model="form.merchant" class="input" maxlength="80" /></label>
      <label class="field"><span>Note</span><textarea v-model="form.notes" class="input" maxlength="1000" /></label>

      <div class="actions-row">
        <button v-if="!splitting" class="btn primary" :disabled="busy" @click="save">Save</button>
        <button v-if="!splitting" class="btn" @click="startSplit">Split</button>
        <button v-if="!t.transfer_group_id" class="btn" @click="findPartners">Mark as transfer</button>
        <label class="btn">Attach receipt<input type="file" accept="image/*,application/pdf" class="sr-only" @change="attach" /></label>
      </div>

      <div v-if="candidates" class="section">
        <h2>Pair with</h2>
        <p v-if="!candidates.length" class="muted small">No equal and opposite amount on another account within 10 days. Import the other account first.</p>
        <button v-for="c in candidates" :key="c.id" class="row" @click="pair(c.id)">
          <span class="who">{{ c.account_name }}: {{ c.merchant || c.description_raw }}</span>
          <Money class="amt" :cents="c.amount_cents" />
          <span class="what">{{ dayLabel(c.posted_on) }}</span>
        </button>
      </div>

      <div v-if="t.receipts.length" class="section">
        <h2>Receipts</h2>
        <button v-for="r in t.receipts" :key="r.id" class="btn quiet" @click="viewReceipt(r)">{{ r.filename || 'Receipt' }}</button>
      </div>

      <div class="section small muted">
        <p v-if="t.evidence.length">
          Also on {{ t.evidence.map((e) => `${e.source === 'chase-pdf' ? 'the statement' : e.source} (${shortDate(e.posted_on)})`).join(', ') }}.
        </p>
        <p>From {{ t.source === 'manual' ? 'manual entry' : t.source }}<span v-if="t.categorized_by">, categorized by {{ t.categorized_by }}</span>.</p>
        <button v-if="t.source === 'manual'" class="btn quiet danger" :disabled="busy" @click="remove">Delete entry</button>
      </div>
    </div>
  </Sheet>
</template>

<style>
.tx-top { display: grid; gap: 6px; margin-bottom: 18px; }
.tx-top .raw { word-break: break-word; }
.actions-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.split { display: grid; gap: 12px; margin-bottom: 16px; }
.split-part { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--rule); }
</style>
