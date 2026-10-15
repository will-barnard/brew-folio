<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, qs } from '../api';
import { useRef } from '../stores/ref';
import { dayLabel, monthLabel } from '../format';
import Money from '../components/Money.vue';
import TxRow from '../components/TxRow.vue';
import TxSheet from '../components/TxSheet.vue';

const route = useRoute();
const router = useRouter();
const refs = useRef();

const f = ref({
  q: route.query.q || '',
  account_id: route.query.account_id ? Number(route.query.account_id) : '',
  stream_id: route.query.stream_id ? Number(route.query.stream_id) : '',
  category_id: route.query.category_id ? Number(route.query.category_id) : '',
  month: route.query.month || '',
  uncategorized: route.query.uncategorized === '1',
});
const rows = ref([]);
const next = ref(null);
const loading = ref(false);
const err = ref('');
const openId = ref(null);

function params(extra = {}) {
  const p = { ...f.value, uncategorized: f.value.uncategorized ? '1' : '' };
  if (p.month) {
    const [y, m] = p.month.split('-').map(Number);
    p.from = `${p.month}-01`;
    p.to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  delete p.month;
  return { ...p, ...extra };
}

async function load(more = false) {
  loading.value = true; err.value = '';
  try {
    const r = await api.get(`/transactions${qs(params(more && next.value ? next.value : {}))}`);
    rows.value = more ? [...rows.value, ...r.rows] : r.rows;
    next.value = r.next;
  } catch (e) { err.value = e.message; } finally { loading.value = false; }
}

let timer = null;
watch(f, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const query = Object.fromEntries(Object.entries({ ...f.value, uncategorized: f.value.uncategorized ? '1' : '' }).filter(([, v]) => v !== '' && v !== false));
    router.replace({ query });
    load();
  }, 250);
}, { deep: true });
load();

const days = computed(() => {
  const out = [];
  for (const t of rows.value) {
    let d = out.at(-1);
    if (!d || d.date !== t.posted_on) { d = { date: t.posted_on, rows: [], net: 0 }; out.push(d); }
    d.rows.push(t);
    d.net += t.amount_cents;
  }
  return out;
});
const categoryName = computed(() => (f.value.category_id ? refs.categoryById[f.value.category_id]?.name : null));
</script>

<template>
  <div>
    <header class="page-head"><h1>Activity</h1></header>

    <div class="filters">
      <input v-model="f.q" class="input" type="search" placeholder="Search names, descriptions, notes" aria-label="Search" />
      <div class="filter-row">
        <select v-model="f.account_id" class="input" aria-label="Account">
          <option value="">All accounts</option>
          <option v-for="a in refs.accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
        <select v-model="f.stream_id" class="input" aria-label="Stream">
          <option value="">All streams</option>
          <option v-for="s in refs.streams" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <input v-model="f.month" class="input" type="month" aria-label="Month" />
      </div>
      <div class="chips">
        <button class="chip" :aria-pressed="f.uncategorized" @click="f.uncategorized = !f.uncategorized">Needs a category</button>
        <button v-if="categoryName" class="chip" aria-pressed="true" @click="f.category_id = ''">{{ categoryName }} ✕</button>
        <span v-if="f.month" class="muted small chip-note">{{ monthLabel(f.month) }}</span>
      </div>
    </div>

    <p v-if="err" class="error">{{ err }}</p>
    <div v-if="!loading && !rows.length" class="empty">
      <strong>Nothing here.</strong>
      {{ f.q || f.account_id || f.stream_id || f.category_id || f.month || f.uncategorized ? 'Try loosening the filters.' : 'Import a Chase CSV or add something by hand to get started.' }}
    </div>

    <div v-for="d in days" :key="d.date" class="ledger">
      <div class="ledger-day"><span>{{ dayLabel(d.date) }}</span><Money :cents="d.net" class="faint" /></div>
      <TxRow v-for="t in d.rows" :key="t.id" :t="t" @open="openId = t.id" />
    </div>

    <div v-if="next" class="load-more">
      <button class="btn" :disabled="loading" @click="load(true)">{{ loading ? 'Loading…' : 'Load more' }}</button>
    </div>

    <TxSheet v-if="openId" :id="openId" @close="openId = null" @changed="load()" />
  </div>
</template>

<style>
.filters { display: grid; gap: 10px; margin-bottom: 8px; }
.filter-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
@media (max-width: 520px) { .filter-row { grid-template-columns: 1fr 1fr; } .filter-row input[type='month'] { grid-column: span 2; } }
.chip-note { align-self: center; }
.load-more { padding: 20px 0; text-align: center; }
</style>
