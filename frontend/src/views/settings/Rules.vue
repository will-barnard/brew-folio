<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { useRef } from '../../stores/ref';
import { parseCents, money } from '../../format';
import { toast } from '../../toast';
import Sheet from '../../components/Sheet.vue';
import CategoryPicker from '../../components/CategoryPicker.vue';
import StreamChips from '../../components/StreamChips.vue';

const refs = useRef();
const rules = ref([]);
const err = ref('');
const editing = ref(null);
const preview = ref(null);

async function load() { rules.value = await api.get('/rules'); }
load().catch((e) => { err.value = e.message; });

function describe(m) {
  const parts = [];
  if (m.merchant) parts.push(`name is “${m.merchant}”`);
  if (m.contains) parts.push(`description contains “${m.contains}”`);
  if (m.regex) parts.push(`description matches /${m.regex}/`);
  if (m.account_id) parts.push(`account is ${refs.accountById[m.account_id]?.name || m.account_id}`);
  if (m.direction) parts.push(m.direction === 'in' ? 'money in' : 'money out');
  if (m.min_cents != null) parts.push(`at least ${money(m.min_cents)}`);
  if (m.max_cents != null) parts.push(`at most ${money(m.max_cents)}`);
  return parts.join(', ');
}

function open(rule = null) {
  const m = rule?.match || {};
  editing.value = {
    id: rule?.id || null, name: rule?.name || '', priority: rule?.priority ?? 100,
    merchant: m.merchant || '', contains: m.contains || '', regex: m.regex || '', account_id: m.account_id || '',
    direction: m.direction || '', min: m.min_cents != null ? (m.min_cents / 100).toFixed(2) : '',
    max: m.max_cents != null ? (m.max_cents / 100).toFixed(2) : '',
    set_category_id: rule?.set_category_id || null, set_stream_id: rule?.set_stream_id || null,
  };
  preview.value = null; err.value = '';
}
function matchOf(e) {
  const m = {};
  if (e.merchant) m.merchant = e.merchant;
  if (e.contains) m.contains = e.contains;
  if (e.regex) m.regex = e.regex;
  if (e.account_id) m.account_id = Number(e.account_id);
  if (e.direction) m.direction = e.direction;
  if (parseCents(e.min) != null) m.min_cents = parseCents(e.min);
  if (parseCents(e.max) != null) m.max_cents = parseCents(e.max);
  return m;
}
async function doPreview() {
  err.value = '';
  try { preview.value = await api.post('/rules/preview', { match: matchOf(editing.value) }); } catch (e) { err.value = e.message; }
}
async function save(applyNow) {
  err.value = '';
  const e = editing.value;
  const body = { name: e.name || null, priority: Number(e.priority) || 100, match: matchOf(e), set_category_id: e.set_category_id, set_stream_id: e.set_stream_id };
  try {
    const r = e.id ? await api.patch(`/rules/${e.id}`, body) : await api.post('/rules', body);
    let msg = 'Rule saved';
    if (applyNow) { const { applied } = await api.post(`/rules/${r.id}/apply`, {}); msg = `Rule saved, sorted ${applied}`; }
    toast(msg); editing.value = null; load();
  } catch (x) { err.value = x.message; }
}
async function toggle(r) { await api.patch(`/rules/${r.id}`, { enabled: !r.enabled }); load(); }
async function remove(r) {
  if (!window.confirm('Delete this rule? Transactions it already sorted keep their category.')) return;
  await api.del(`/rules/${r.id}`); toast('Rule deleted'); load();
}
async function apply(r) { const { applied } = await api.post(`/rules/${r.id}/apply`, {}); toast(`Sorted ${applied}`); load(); }
</script>

<template>
  <div>
    <header class="page-head"><h1>Rules</h1><button class="btn primary" @click="open()">New rule</button></header>
    <p class="small muted">Rules fill in a category when nothing has been chosen. They never overwrite your own picks or touch transfers. Lower priority runs first.</p>
    <p v-if="err && !editing" class="error">{{ err }}</p>
    <div v-if="!rules.length" class="empty"><strong>No rules yet.</strong> Tick “Always do this” while reviewing and they build themselves.</div>
    <ul class="ledger">
      <li v-for="r in rules" :key="r.id" class="rule" :class="{ off: !r.enabled }">
        <div class="rule-main">
          <span>If {{ describe(r.match) }}</span>
          <span class="small muted">Sets {{ r.category_name || 'no category' }}<template v-if="r.stream_name"> and {{ r.stream_name }}</template>. Used {{ r.hits }} times.</span>
        </div>
        <div class="rule-actions">
          <button class="btn quiet small" @click="open(r)">Edit</button>
          <button class="btn quiet small" @click="apply(r)">Run now</button>
          <button class="btn quiet small" @click="toggle(r)">{{ r.enabled ? 'Pause' : 'Resume' }}</button>
          <button class="btn quiet small danger" @click="remove(r)">Delete</button>
        </div>
      </li>
    </ul>

    <Sheet v-if="editing" :title="editing.id ? 'Edit rule' : 'New rule'" @close="editing = null">
      <h3>When a transaction…</h3>
      <div class="row-fields">
        <label class="field"><span>Name is exactly</span><input v-model="editing.merchant" class="input" /></label>
        <label class="field"><span>Description contains</span><input v-model="editing.contains" class="input" placeholder="GOOGLE *CLOUD" /></label>
      </div>
      <div class="row-fields">
        <label class="field"><span>Account</span>
          <select v-model="editing.account_id" class="input"><option value="">Any</option><option v-for="a in refs.accounts" :key="a.id" :value="a.id">{{ a.name }}</option></select>
        </label>
        <label class="field"><span>Direction</span>
          <select v-model="editing.direction" class="input"><option value="">Either</option><option value="out">Money out</option><option value="in">Money in</option></select>
        </label>
      </div>
      <div class="row-fields">
        <label class="field"><span>At least</span><input v-model="editing.min" class="input" inputmode="decimal" /></label>
        <label class="field"><span>At most</span><input v-model="editing.max" class="input" inputmode="decimal" /></label>
      </div>
      <label class="field"><span>Description matches (regular expression, optional)</span><input v-model="editing.regex" class="input" /></label>
      <button class="btn" @click="doPreview">Check what it matches</button>
      <p v-if="preview" class="small muted">
        Matches {{ preview.count }} transaction{{ preview.count === 1 ? '' : 's' }}, {{ preview.uncategorized }} not yet categorized.
        <template v-if="preview.sample.length">For example: {{ preview.sample.slice(0, 3).map((s) => s.merchant || s.description_raw).join('; ') }}.</template>
      </p>
      <h3 class="then">…set</h3>
      <div class="field"><span>Category</span><CategoryPicker v-model="editing.set_category_id" :direction="editing.direction || null" /></div>
      <div class="field"><span>Income stream</span><StreamChips v-model="editing.set_stream_id" /></div>
      <label class="field"><span>Priority</span><input v-model="editing.priority" class="input" inputmode="numeric" /></label>
      <p v-if="err" class="error">{{ err }}</p>
      <div class="actions-row">
        <button class="btn primary" @click="save(true)">Save and run</button>
        <button class="btn" @click="save(false)">Save</button>
      </div>
    </Sheet>
  </div>
</template>

<style>
.rule { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; padding: 10px 2px; border-bottom: 1px solid var(--rule); }
.rule.off { opacity: 0.55; }
.rule-main { display: grid; gap: 2px; min-width: 0; flex: 1 1 18em; }
.rule-actions { display: flex; flex-wrap: wrap; gap: 2px; }
.then { margin-top: 20px; }
</style>
