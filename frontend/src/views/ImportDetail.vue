<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { dayLabel, shortDate, money } from '../format';
import { toast } from '../toast';
import Money from '../components/Money.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();
const refs = useRef();
const b = ref(null);
const accountId = ref(null);
const err = ref('');
const needsForce = ref(false);
const busy = ref(false);

async function load() {
  b.value = await api.get(`/imports/${props.id}`);
  accountId.value = b.value.account_id
    || refs.openAccounts.find((a) => a.last4 && a.last4 === b.value.detected_last4)?.id || null;
}
// Re-load when hopping between sibling imports (same component, new id).
watch(() => props.id, () => { err.value = ''; load().catch((e) => { err.value = e.message; }); }, { immediate: true });

const compatible = computed(() => {
  if (!b.value?.detected_kind) return refs.openAccounts;
  const invest = ['brokerage', 'retirement'];
  const ok = { credit: ['credit'], loan: ['loan'], brokerage: invest, retirement: invest }[b.value.detected_kind] || ['checking', 'savings'];
  return refs.openAccounts.filter((a) => ok.includes(a.kind));
});

async function commit(force = false) {
  busy.value = true; err.value = ''; needsForce.value = false;
  try {
    const { stats } = await api.post(`/imports/${props.id}/commit`, { account_id: accountId.value, force });
    toast(`Imported ${stats.inserted} new, matched ${stats.merged}`);
    await refs.loadAccounts();
    await load();
  } catch (e) {
    err.value = e.message;
    needsForce.value = Boolean(e.body?.needsForce);
  } finally { busy.value = false; }
}

async function undo() {
  const msg = b.value.status === 'imported' && isPositions.value
    ? 'Undo this import and put back the holdings this account had before it?'
    : b.value.status === 'imported'
    ? 'Remove this import and every transaction it added? Rows another file also confirmed are kept.'
    : 'Discard this upload?';
  if (!window.confirm(msg)) return;
  busy.value = true;
  try {
    const r = await api.del(`/imports/${props.id}`);
    toast(b.value.status !== 'imported' ? 'Discarded'
      : isPositions.value ? 'Import undone — previous holdings restored'
        : `Removed ${r.removed}, kept ${r.promoted} confirmed elsewhere`);
    await refs.loadAccounts();
    router.replace('/imports');
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}

async function viewFile() {
  try { window.open(await api.blobUrl(`/imports/${props.id}/file`), '_blank', 'noopener'); } catch (e) { err.value = e.message; }
}
const KIND = { checking: 'checking', savings: 'savings', credit: 'credit card', loan: 'loan', brokerage: 'brokerage account', retirement: 'retirement account' };
const isPositions = computed(() => Boolean(b.value?.positions_preview) || b.value?.stats?.positions !== undefined);
const inst = computed(() => b.value?.institution || (/fidelity/.test(b.value?.parser || '') ? 'Fidelity' : 'Chase'));

// First import of an account: create it from what the statement says, in one tap.
async function createAccount() {
  busy.value = true; err.value = '';
  try {
    const label = b.value.account_label
      || `${inst.value} ${KIND[b.value.detected_kind] || 'account'}`.replace(/\b\w/g, (c) => c.toUpperCase());
    const a = await api.post('/accounts', {
      name: label, kind: b.value.detected_kind, institution: inst.value, last4: b.value.detected_last4 || null,
    });
    await refs.loadAccounts();
    accountId.value = a.id;
    toast(`Added ${a.name}`);
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div v-if="b">
    <header class="page-head">
      <h1 class="ellipsis">{{ b.filename }}</h1>
      <button class="btn quiet" @click="viewFile">Open file</button>
    </header>

    <p v-if="b.siblings?.length" class="note small">
      This statement also covers
      <template v-for="(x, i) in b.siblings" :key="x.id">{{ i ? ', ' : ' ' }}<RouterLink :to="`/imports/${x.id}`">{{ KIND[x.detected_kind] || 'an account' }} ending {{ x.detected_last4 }}</RouterLink></template>.
      Each account imports separately.
    </p>
    <p v-if="b.status === 'failed'" class="note bad">{{ b.error }}</p>

    <dl v-else class="kv">
      <dt>Looks like</dt><dd>{{ inst }} {{ KIND[b.detected_kind] || 'account' }}<template v-if="b.detected_last4"> ending {{ b.detected_last4 }}</template></dd>
      <template v-if="isPositions">
        <dt>Holdings</dt><dd>{{ b.row_count || b.stats.positions }} as of {{ shortDate(b.period_end) }}, worth <Money :cents="b.parsed_sum_cents" /> on that date</dd>
      </template>
      <template v-else>
        <dt>Covers</dt><dd>{{ shortDate(b.period_start) }} to {{ shortDate(b.period_end) }}, {{ b.row_count || b.stats.parsed }} transaction{{ (b.row_count || b.stats.parsed) === 1 ? '' : 's' }}</dd>
      </template>
      <template v-if="b.opening_cents === null && b.balances?.length">
        <dt>Balance</dt><dd><Money :cents="b.balances[0].balance_cents" /> on {{ shortDate(b.balances[0].as_of) }}</dd>
      </template>
      <template v-if="b.opening_cents !== null && !isPositions">
        <dt>Balance</dt><dd><Money :cents="b.opening_cents" /> to <Money :cents="b.closing_cents" /></dd>
      </template>
      <dt>Check</dt>
      <dd>
        <span v-if="b.reconciled === true && isPositions" class="in">Holdings add up to the statement’s total.</span>
        <span v-else-if="b.reconciled === true" class="in">Every row accounted for — the rows add up to the change in balance.</span>
        <span v-else-if="b.reconciled === false" class="danger">Rows don’t add up to the statement. Don’t import until this is looked at.</span>
        <span v-else-if="isPositions" class="muted">A Positions CSV has no total to check against.</span>
        <span v-else class="muted">This file has no balances to check against. Import the matching statement PDF to verify the month.</span>
      </dd>
    </dl>

    <div v-for="w in b.warnings" :key="w" class="note small">{{ w }}</div>

    <section v-if="b.status === 'parsed'" class="section panel">
      <label class="field"><span>Import into</span>
        <select v-model="accountId" class="input">
          <option :value="null" disabled>Choose an account</option>
          <option v-for="a in compatible" :key="a.id" :value="a.id">{{ a.name }}{{ a.last4 ? ` (${a.last4})` : '' }}</option>
        </select>
      </label>
      <p v-if="!compatible.find((a) => a.last4 === b.detected_last4) && b.detected_kind" class="small">
        <button class="btn" :disabled="busy" @click="createAccount">
          Create “{{ b.account_label || `${inst} ${KIND[b.detected_kind]}` }}”{{ b.detected_last4 ? ` ending ${b.detected_last4}` : '' }}
        </button>
      </p>
      <p v-if="err" class="error">{{ err }}</p>
      <div class="actions-row">
        <button class="btn primary" :disabled="busy || !accountId" @click="commit(false)">Import</button>
        <button v-if="needsForce" class="btn" :disabled="busy" @click="commit(true)">Import anyway</button>
        <button class="btn quiet" :disabled="busy" @click="undo">Discard</button>
      </div>
      <p v-if="isPositions" class="small faint">Importing replaces this account’s holdings with the ones in this file. Undo puts the previous holdings back.</p>
      <p v-else class="small faint">Duplicates of rows you already have — from this file or another source — are matched, not added twice.</p>
    </section>

    <section v-if="b.status === 'imported'" class="section">
      <dl class="kv">
        <dt>Account</dt><dd><RouterLink :to="`/accounts/${b.account_id}`">{{ b.account_name }}</RouterLink></dd>
        <dt>Result</dt>
        <dd v-if="isPositions">{{ b.stats.positions }} holdings as of {{ shortDate(b.stats.as_of) }}, now valued at current prices</dd>
        <dd v-else>
          {{ b.stats.inserted }} new, {{ b.stats.merged }} matched existing,
          {{ b.stats.duplicates }} already imported, {{ b.stats.transfers }} transfers, {{ b.stats.ruled }} sorted by rules
          <template v-if="b.stats.locked">, {{ b.stats.locked }} skipped (locked period)</template>
        </dd>
      </dl>
      <div class="actions-row">
        <RouterLink v-if="isPositions" class="btn" :to="`/accounts/${b.account_id}`">See holdings</RouterLink>
        <RouterLink v-else class="btn" :to="{ name: 'activity', query: { account_id: b.account_id } }">See transactions</RouterLink>
        <button class="btn quiet danger" :disabled="busy" @click="undo">Undo import</button>
      </div>
      <p v-if="err" class="error">{{ err }}</p>
    </section>

    <section v-if="b.positions_preview?.length" class="section">
      <h2>Holdings in this file</h2>
      <div class="scroll-x">
        <table class="table">
          <thead><tr><th>Symbol</th><th class="name-col">Name</th><th class="num">Quantity</th><th class="num">Value</th></tr></thead>
          <tbody>
            <tr v-for="p in b.positions_preview" :key="p.symbol">
              <td class="nowrap">{{ p.asset_type === 'cash' ? `Cash (${p.symbol})` : p.symbol.startsWith('UNPRICED-') ? '—' : p.symbol }}</td>
              <td class="name-col">{{ p.name }}</td>
              <td class="num">{{ p.asset_type === 'cash' ? '' : Number(p.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 }) }}</td>
              <td class="num nowrap"><span class="amt">{{ p.last_price == null && p.asset_type !== 'cash' ? 'no price' : money(p.value_cents) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="b.preview?.length" class="section">
      <h2>First {{ b.preview.length }} rows</h2>
      <div class="scroll-x">
        <table class="table">
          <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            <tr v-for="r in b.preview" :key="r.external_id">
              <td class="nowrap">{{ dayLabel(r.posted_on) }}</td>
              <td>{{ r.description_raw }}</td>
              <td class="num nowrap"><span class="amt" :class="{ in: r.amount_cents > 0 }">{{ money(r.amount_cents) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
  <p v-else-if="err" class="error">{{ err }}</p>
</template>

<style>
@media (max-width: 520px) { .name-col { display: none; } }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
