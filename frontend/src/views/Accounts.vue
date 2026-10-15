<script setup>
import { computed, ref } from 'vue';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { KIND_LABEL } from '../format';
import { toast } from '../toast';
import Money from '../components/Money.vue';
import Sheet from '../components/Sheet.vue';

const refs = useRef();
refs.loadAccounts();
const adding = ref(false);
const form = ref({ name: '', kind: 'checking', institution: 'Chase', last4: '', entity_id: null });
const err = ref('');
const busy = ref(false);

const groups = computed(() => {
  const by = new Map();
  for (const a of refs.accounts) {
    const key = a.is_closed ? 'Closed' : a.entity_name;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(a);
  }
  return [...by.entries()];
});
const total = computed(() => refs.accounts.filter((a) => !a.is_closed).reduce((s, a) => s + a.balance_cents, 0));

function startAdd(preset = {}) {
  form.value = { name: '', kind: 'checking', institution: 'Chase', last4: '', entity_id: refs.entities[0]?.id ?? null, ...preset };
  err.value = '';
  adding.value = true;
}
async function save() {
  busy.value = true; err.value = '';
  try {
    await api.post('/accounts', { ...form.value, last4: form.value.last4 || null, institution: form.value.institution || null });
    await refs.loadAccounts();
    toast(`Added ${form.value.name}`);
    adding.value = false;
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div>
    <header class="page-head">
      <h1>Accounts</h1>
      <button class="btn primary" @click="startAdd()">Add account</button>
    </header>

    <div v-if="!refs.accounts.length" class="empty">
      <strong>No accounts yet.</strong>
      Add Chase checking and each card. The last four digits let imports find the right account on their own.
      <div class="actions-row">
        <button class="btn" @click="startAdd({ name: 'Chase Checking', kind: 'checking' })">Chase checking</button>
        <button class="btn" @click="startAdd({ name: 'Chase card', kind: 'credit' })">A Chase card</button>
        <button class="btn" @click="startAdd({ name: 'Cash', kind: 'cash', institution: '' })">Cash</button>
      </div>
    </div>

    <section v-for="[name, list] in groups" :key="name" class="section">
      <h2>{{ name }}</h2>
      <ul class="ledger">
        <li v-for="a in list" :key="a.id">
          <RouterLink :to="`/accounts/${a.id}`" class="acct-row">
            <span class="acct-name">{{ a.name }}</span>
            <Money class="acct-bal" :cents="a.balance_cents" />
            <span class="small muted">
              {{ KIND_LABEL[a.kind] }}<template v-if="a.last4"> ending {{ a.last4 }}</template>
              <template v-if="a.balance_basis === 'sum' && a.kind !== 'cash'">, no starting balance yet</template>
            </span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <p v-if="refs.accounts.length" class="small muted total">Net across open accounts <Money :cents="total" /></p>

    <Sheet v-if="adding" title="Add account" @close="adding = false">
      <form @submit.prevent="save">
        <label class="field"><span>Name</span><input v-model="form.name" class="input" required maxlength="80" placeholder="Chase Sapphire" /></label>
        <div class="row-fields">
          <label class="field"><span>Type</span>
            <select v-model="form.kind" class="input">
              <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ label }}</option>
            </select>
          </label>
          <label class="field"><span>Last 4 digits</span><input v-model="form.last4" class="input" inputmode="numeric" maxlength="4" pattern="\d{4}" /></label>
        </div>
        <div class="row-fields">
          <label class="field"><span>Institution</span><input v-model="form.institution" class="input" maxlength="80" /></label>
          <label class="field"><span>Books</span>
            <select v-model="form.entity_id" class="input">
              <option v-for="e in refs.entities" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
        </div>
        <p v-if="err" class="error">{{ err }}</p>
        <button class="btn primary big" :disabled="busy">Add account</button>
      </form>
    </Sheet>
  </div>
</template>

<style>
.acct-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); text-decoration: none; }
.acct-name { font-weight: 500; }
.acct-bal { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-size: var(--step-1); }
.total { margin-top: 16px; display: flex; gap: 8px; align-items: baseline; }
</style>
