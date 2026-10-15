<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { KIND_LABEL, shortDate, parseCents, todayISO, dayLabel } from '../format';
import { toast } from '../toast';
import Money from '../components/Money.vue';

const props = defineProps({ id: { type: String, required: true } });
const refs = useRef();
const a = computed(() => refs.accountById[Number(props.id)]);
const form = ref({});
const recon = ref([]);
const anchor = ref({ amount: '', as_of: todayISO(), owed: true });
const err = ref('');
const busy = ref(false);

watch(a, (v) => { if (v) form.value = { name: v.name, kind: v.kind, institution: v.institution || '', last4: v.last4 || '', entity_id: v.entity_id }; }, { immediate: true });
async function loadRecon() { recon.value = await api.get(`/accounts/${props.id}/reconciliation`).catch(() => []); }
loadRecon();

async function save(patch) {
  busy.value = true; err.value = '';
  try {
    await api.patch(`/accounts/${props.id}`, patch);
    await refs.loadAccounts();
    toast('Saved');
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
async function setBalance() {
  const c = parseCents(anchor.value.amount);
  if (c === null) { err.value = 'Enter the balance'; return; }
  busy.value = true; err.value = '';
  try {
    await api.post(`/accounts/${props.id}/balance`, { amount_cents: c, as_of: anchor.value.as_of, owed: a.value.kind === 'credit' && anchor.value.owed });
    await refs.loadAccounts();
    toast('Balance set');
    anchor.value.amount = '';
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div v-if="a">
    <header class="page-head">
      <h1>{{ a.name }}</h1>
      <RouterLink class="btn" :to="{ name: 'activity', query: { account_id: a.id } }">Transactions</RouterLink>
    </header>

    <div class="worth">
      <div class="muted small">
        Balance<template v-if="a.anchor_on">, from the {{ a.anchor_source === 'manual' ? 'balance you entered' : a.anchor_source }} on {{ shortDate(a.anchor_on) }} plus everything since</template>
      </div>
      <Money :cents="a.balance_cents" hero />
    </div>
    <p v-if="err" class="error">{{ err }}</p>

    <section class="section">
      <h2>Monthly check</h2>
      <p v-if="!recon.length" class="small muted">
        Import this account’s statement PDFs and each month gets checked here: the statement’s rows must add up,
        and nothing else in the ledger may fall inside that month.
      </p>
      <ul class="ledger">
        <li v-for="r in recon" :key="r.batch_id" class="recon">
          <span>{{ shortDate(r.period_start) }} to {{ shortDate(r.period_end) }}</span>
          <span :class="r.ok ? 'in' : 'danger'" class="small">{{ r.ok ? 'Balances' : r.reconciled ? `${r.extras.length} extra` : 'Statement didn’t parse cleanly' }}</span>
          <ul v-if="r.extras.length" class="extras small muted">
            <li v-for="x in r.extras" :key="x.id">{{ dayLabel(x.posted_on) }}: {{ x.description_raw }} (<Money :cents="x.amount_cents" />, {{ x.source }})</li>
          </ul>
        </li>
      </ul>
    </section>

    <section class="section panel">
      <h2>Starting balance</h2>
      <p class="small muted">
        Anchors the running balance. Statements and checking CSVs set this automatically; use this for accounts without them.
      </p>
      <div class="row-fields">
        <label class="field"><span>{{ a.kind === 'credit' ? 'Amount owed' : 'Balance' }}</span><input v-model="anchor.amount" class="input" inputmode="decimal" /></label>
        <label class="field"><span>As of the end of</span><input v-model="anchor.as_of" class="input" type="date" /></label>
      </div>
      <button class="btn" :disabled="busy" @click="setBalance">Set balance</button>
    </section>

    <section class="section">
      <h2>Details</h2>
      <form @submit.prevent="save({ ...form, last4: form.last4 || null, institution: form.institution || null })">
        <label class="field"><span>Name</span><input v-model="form.name" class="input" maxlength="80" /></label>
        <div class="row-fields">
          <label class="field"><span>Type</span>
            <select v-model="form.kind" class="input">
              <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ label }}</option>
            </select>
          </label>
          <label class="field"><span>Last 4 digits</span><input v-model="form.last4" class="input" inputmode="numeric" maxlength="4" /></label>
        </div>
        <div class="row-fields">
          <label class="field"><span>Institution</span><input v-model="form.institution" class="input" /></label>
          <label class="field"><span>Books</span>
            <select v-model="form.entity_id" class="input">
              <option v-for="e in refs.entities" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
        </div>
        <div class="actions-row">
          <button class="btn primary" :disabled="busy">Save</button>
          <button type="button" class="btn quiet" :disabled="busy" @click="save({ is_closed: !a.is_closed })">{{ a.is_closed ? 'Reopen account' : 'Close account' }}</button>
        </div>
      </form>
    </section>
  </div>
  <div v-else class="empty"><strong>Account not found.</strong></div>
</template>

<style>
.recon { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); }
.extras { grid-column: 1 / -1; margin: 0; padding-left: 16px; }
</style>
