<script setup>
// Holdings for one investment account: valued at live prices, editable by hand.
// Imports (Fidelity statement / Positions CSV) replace the whole list.
import { computed, ref } from 'vue';
import { api } from '../api';
import { money, shortDate, ago } from '../format';
import { toast } from '../toast';
import Money from './Money.vue';
import Sheet from './Sheet.vue';

const props = defineProps({ accountId: { type: Number, required: true }, accountKind: { type: String, required: true } });
const emit = defineEmits(['changed']);

const list = ref(null);
const err = ref('');
const editing = ref(null);
const check = ref(null);
const busy = ref(false);

const TYPES = [
  { v: 'stock', label: 'Stock / ETF' },
  { v: 'mutual_fund', label: 'Mutual fund' },
  { v: 'crypto', label: 'Crypto' },
  { v: 'cash', label: 'Cash' },
  { v: 'other', label: 'Other' },
];
const TYPE_LABEL = { stock: 'Stock', etf: 'ETF', mutual_fund: 'Fund', crypto: 'Crypto', cash: 'Cash', other: 'Other' };

async function load() {
  try { list.value = await api.get(`/accounts/${props.accountId}/positions`); } catch (e) { err.value = e.message; }
}
load();

const dayChange = computed(() => (list.value || []).reduce((s, p) => s + (p.day_change_cents || 0), 0));
const oldestQuote = computed(() => (list.value || []).map((p) => p.quoted_at).filter(Boolean).sort()[0]);
const imported = computed(() => (list.value || []).find((p) => p.source !== 'manual'));

function open(p = null) {
  const crypto = ['exchange', 'wallet'].includes(props.accountKind);
  editing.value = p
    ? { id: p.id, asset_type: p.asset_type === 'etf' ? 'stock' : p.asset_type, symbol: p.symbol, name: p.name || '', quantity: String(Number(p.quantity)),
      cost_basis: p.cost_basis_cents != null ? (p.cost_basis_cents / 100).toFixed(2) : '', manual_price: p.manual_price ?? '' }
    : { id: null, asset_type: crypto ? 'crypto' : 'stock', symbol: '', name: '', quantity: '', cost_basis: '', manual_price: '' };
  check.value = null; err.value = '';
}

async function lookup() {
  const e = editing.value;
  if (!e.symbol || ['cash', 'other'].includes(e.asset_type)) return;
  check.value = { loading: true };
  try {
    const r = await api.get(`/quotes/lookup?symbol=${encodeURIComponent(e.symbol)}&type=${e.asset_type}`);
    check.value = r.price != null ? { price: r.price } : { note: r.note || 'No price available' };
  } catch (x) { check.value = { error: x.message }; }
}

async function save() {
  const e = editing.value;
  busy.value = true; err.value = '';
  const body = {
    asset_type: e.asset_type, symbol: e.asset_type === 'cash' ? (e.symbol || 'USD') : e.symbol,
    name: e.name || null, quantity: e.quantity, cost_basis: e.cost_basis === '' ? null : e.cost_basis,
    manual_price: e.asset_type === 'other' && e.manual_price !== '' ? e.manual_price : null,
  };
  try {
    if (e.id) await api.patch(`/positions/${e.id}`, body); else await api.post(`/accounts/${props.accountId}/positions`, body);
    toast(e.id ? 'Position updated' : 'Position added');
    editing.value = null;
    await load(); emit('changed');
  } catch (x) { err.value = x.message; } finally { busy.value = false; }
}

async function remove() {
  if (!window.confirm(`Remove ${editing.value.symbol}?`)) return;
  await api.del(`/positions/${editing.value.id}`);
  toast('Position removed'); editing.value = null; await load(); emit('changed');
}

const label = (p) => {
  if (p.asset_type === 'cash') return p.symbol === 'USD' ? 'Cash' : `Cash (${p.symbol})`;
  if (p.symbol.startsWith('UNPRICED-')) return p.name || 'Unpriced holding';
  return p.symbol;
};
const qty = (p) => (p.asset_type === 'cash' ? '' : Number(p.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 }));
</script>

<template>
  <section class="section">
    <h2>Holdings <button class="btn quiet small link" @click="open()">Add</button></h2>
    <p v-if="err && !editing" class="error">{{ err }}</p>

    <div v-if="list && !list.length" class="empty">
      <strong>No holdings yet.</strong>
      <template v-if="['exchange', 'wallet'].includes(accountKind)">Add each coin and how much you hold, plus any cash balance.</template>
      <template v-else>Upload a Fidelity statement PDF under Imports, or add positions by hand.</template>
    </div>

    <template v-if="list && list.length">
      <p class="small faint">
        <span v-if="dayChange" :class="dayChange > 0 ? 'in' : 'muted'"><Money :cents="dayChange" sign="always" /> today. </span>
        <template v-if="oldestQuote">Prices as of {{ ago(oldestQuote) }}.</template>
        <template v-if="imported"> Quantities from your {{ imported.source === 'fidelity-csv' ? 'Positions CSV' : 'statement' }} of {{ shortDate(imported.as_of) }}.</template>
      </p>
      <ul class="ledger">
        <li v-for="p in list" :key="p.id">
          <button class="row hold" @click="open(p)">
            <span class="who">{{ label(p) }}</span>
            <Money class="amt" :cents="p.value_cents" />
            <span class="what">
              <span>{{ TYPE_LABEL[p.asset_type] }}</span>
              <span v-if="p.asset_type !== 'cash'">{{ qty(p) }}<template v-if="p.price != null"> × {{ money(Math.round(p.price * 100)) }}</template></span>
              <span v-if="p.gain_cents != null" :class="p.gain_cents >= 0 ? 'in' : 'danger'"><Money :cents="p.gain_cents" sign="always" /></span>
              <span v-if="!p.priced" class="uncat">no price</span>
              <span v-else-if="p.quote_error" class="faint" :title="p.quote_error">price stale</span>
            </span>
          </button>
        </li>
      </ul>
    </template>

    <Sheet v-if="editing" :title="editing.id ? `Edit ${editing.symbol}` : 'Add a holding'" @close="editing = null">
      <form @submit.prevent="save">
        <div class="field"><span>Type</span>
          <div class="chips">
            <button v-for="t in TYPES" :key="t.v" type="button" class="chip" :aria-pressed="editing.asset_type === t.v"
                    @click="editing.asset_type = t.v; check = null">{{ t.label }}</button>
          </div>
        </div>
        <div v-if="editing.asset_type !== 'cash'" class="row-fields">
          <label class="field"><span>{{ editing.asset_type === 'crypto' ? 'Coin (BTC, ETH…)' : 'Ticker' }}</span>
            <input v-model="editing.symbol" class="input" autocapitalize="characters" autocomplete="off" required @blur="lookup" />
          </label>
          <label class="field"><span>Quantity</span><input v-model="editing.quantity" class="input" inputmode="decimal" required /></label>
        </div>
        <label v-else class="field"><span>Amount ($)</span><input v-model="editing.quantity" class="input" inputmode="decimal" required /></label>
        <p v-if="check" class="small" :class="check.error ? 'danger' : 'muted'">
          <template v-if="check.loading">Checking price…</template>
          <template v-else-if="check.price != null">{{ editing.symbol.toUpperCase() }} is {{ money(Math.round(check.price * 100)) }}<template v-if="editing.quantity"> — this holding ≈ {{ money(Math.round(check.price * Number(editing.quantity) * 100)) }}</template></template>
          <template v-else>{{ check.error || check.note }}</template>
        </p>
        <label v-if="editing.asset_type === 'other'" class="field"><span>Price per unit (no market price)</span>
          <input v-model="editing.manual_price" class="input" inputmode="decimal" />
        </label>
        <div class="row-fields">
          <label v-if="editing.asset_type !== 'cash'" class="field"><span>Total cost basis (optional)</span><input v-model="editing.cost_basis" class="input" inputmode="decimal" /></label>
          <label class="field"><span>Name (optional)</span><input v-model="editing.name" class="input" maxlength="120" /></label>
        </div>
        <p v-if="err" class="error">{{ err }}</p>
        <div class="actions-row">
          <button class="btn primary" :disabled="busy">{{ editing.id ? 'Save' : 'Add holding' }}</button>
          <button v-if="editing.id" type="button" class="btn quiet danger" @click="remove">Remove</button>
        </div>
      </form>
    </Sheet>
  </section>
</template>

<style>
.row.hold .what { flex-wrap: wrap; }
.link { min-height: 0; padding: 0; font-size: var(--step--1); }
</style>
