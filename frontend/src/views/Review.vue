<script setup>
// One transaction at a time. Suggestions are big buttons; "always" turns the
// pick into a rule and clears every other match from the queue at once.
import { computed, ref } from 'vue';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { dayLabel } from '../format';
import { toast } from '../toast';
import Money from '../components/Money.vue';
import CategoryPicker from '../components/CategoryPicker.vue';
import StreamChips from '../components/StreamChips.vue';
import TxSheet from '../components/TxSheet.vue';

const refs = useRef();
const items = ref([]);
const total = ref(0);
const idx = ref(0);
const loading = ref(true);
const busy = ref(false);
const err = ref('');
const pick = ref({ category_id: null, stream_id: null });
const always = ref(false);
const browsing = ref(false);
const detailId = ref(null);

const SOURCE = { history: 'You picked this', ai: 'Suggested', bank: 'Chase calls it' };

async function load() {
  loading.value = true; err.value = '';
  try {
    const r = await api.get('/review?limit=30');
    items.value = r.items; total.value = r.total; refs.reviewCount = r.total; idx.value = 0;
    reset();
  } catch (e) { err.value = e.message; } finally { loading.value = false; }
}
load();

const t = computed(() => items.value[idx.value] || null);
function reset() {
  const s = t.value?.suggestions?.[0];
  pick.value = { category_id: null, stream_id: s?.stream_id ?? null };
  always.value = false;
  browsing.value = !t.value?.suggestions?.length;
}

async function resolve(categoryId, streamId = pick.value.stream_id) {
  if (!t.value || !categoryId) return;
  busy.value = true; err.value = '';
  try {
    const r = await api.post(`/review/${t.value.id}`, {
      category_id: categoryId, stream_id: streamId, rule: always.value ? { scope: 'merchant' } : undefined,
    });
    total.value -= 1 + (r.applied || 0);
    refs.reviewCount = Math.max(total.value, 0);
    if (r.applied) toast(`Rule saved — sorted ${r.applied} more like it`);
    if (r.applied) { await load(); return; }
    next();
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
function next() {
  idx.value += 1;
  if (idx.value >= items.value.length) load(); else reset();
}
</script>

<template>
  <div>
    <header class="page-head">
      <h1>Review</h1>
      <span v-if="total" class="muted small">{{ total }} left</span>
    </header>
    <p v-if="err" class="error">{{ err }}</p>

    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="!t" class="empty">
      <strong>All sorted.</strong> New imports land here when nothing recognises them.
    </div>

    <article v-else class="review">
      <div class="review-head">
        <div class="review-who">{{ t.merchant || t.description_raw }}</div>
        <Money :cents="t.amount_cents" hero color-in />
        <div class="muted small">{{ dayLabel(t.posted_on) }} in {{ t.account_name }}</div>
        <div class="faint small raw">{{ t.description_raw }}</div>
      </div>

      <div class="field"><span>Income stream</span><StreamChips v-model="pick.stream_id" /></div>

      <div v-if="t.suggestions.length" class="suggest">
        <button v-for="s in t.suggestions" :key="`${s.category_id}-${s.stream_id}`" class="btn big sugg" :disabled="busy"
                @click="resolve(s.category_id, pick.stream_id ?? s.stream_id)">
          <span>{{ refs.categoryPath(s.category_id) }}</span>
          <span class="small muted">{{ SOURCE[s.source] }}<template v-if="s.note">: {{ s.note }}</template></span>
        </button>
      </div>

      <label v-if="t.merchant" class="always">
        <input v-model="always" type="checkbox" /> Always do this for {{ t.merchant }}
      </label>

      <div v-if="browsing" class="field">
        <span>{{ t.suggestions.length ? 'Something else' : 'Category' }}</span>
        <CategoryPicker v-model="pick.category_id" :direction="t.amount_cents > 0 ? 'in' : 'out'" />
      </div>

      <div class="actions-row">
        <button v-if="browsing" class="btn primary" :disabled="busy || !pick.category_id" @click="resolve(pick.category_id)">Save</button>
        <button v-else class="btn" @click="browsing = true">Something else</button>
        <button class="btn quiet" @click="detailId = t.id">Split or transfer</button>
        <button class="btn quiet" @click="next">Skip</button>
      </div>
    </article>

    <TxSheet v-if="detailId" :id="detailId" @close="detailId = null; load()" />
  </div>
</template>

<style>
.review { display: grid; gap: 16px; }
.review-head { display: grid; gap: 6px; padding-bottom: 16px; border-bottom: 1px solid var(--rule); }
.review-who { font-size: var(--step-1); font-weight: 600; }
.review .raw { word-break: break-word; }
.suggest { display: grid; gap: 8px; }
.sugg { flex-direction: column; align-items: flex-start; gap: 0; padding: 10px 16px; height: auto; min-height: 60px; }
.always { display: flex; gap: 10px; align-items: center; }
.always input { width: 20px; height: 20px; accent-color: var(--brass); }
</style>
