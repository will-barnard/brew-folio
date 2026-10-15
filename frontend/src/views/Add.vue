<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import { api } from '../api';
import { useRef } from '../stores/ref';
import { parseCents, todayISO, money } from '../format';
import { queue } from '../outbox';
import { toast } from '../toast';
import CategoryPicker from '../components/CategoryPicker.vue';
import StreamChips from '../components/StreamChips.vue';

const refs = useRef();
const LAST = 'folio.lastAccount';
const mode = ref('money');
const amountInput = ref(null);

// ── money ──
function lastAccount() {
  try { return Number(localStorage.getItem(LAST)) || null; } catch { return null; }
}
const blank = () => ({
  direction: 'out', amount: '', description: '', category_id: null, stream_id: null, notes: '',
  posted_on: todayISO(),
  account_id: refs.openAccounts.find((a) => a.id === lastAccount())?.id
    || refs.openAccounts.find((a) => a.kind === 'cash')?.id || refs.openAccounts[0]?.id || null,
});
const m = ref(blank());
const receipt = ref(null);
const err = ref('');
const busy = ref(false);
const cents = computed(() => parseCents(m.value.amount));

watch(() => m.value.account_id, (id) => { try { if (id) localStorage.setItem(LAST, String(id)); } catch { /* ignore */ } });
onMounted(() => amountInput.value?.focus());

async function saveMoney() {
  err.value = '';
  if (!cents.value || cents.value <= 0) { err.value = 'Enter an amount'; return; }
  if (!m.value.description.trim()) { err.value = 'Say what it was'; return; }
  if (!m.value.account_id) { err.value = 'Choose an account'; return; }
  const body = {
    account_id: m.value.account_id,
    amount_cents: m.value.direction === 'out' ? -cents.value : cents.value,
    description: m.value.description.trim(),
    posted_on: m.value.posted_on,
    category_id: m.value.category_id,
    stream_id: m.value.stream_id,
    notes: m.value.notes || null,
  };
  busy.value = true;
  try {
    const row = await api.post('/transactions', body);
    if (receipt.value) await api.upload(`/transactions/${row.id}/receipts`, receipt.value);
    toast(`Added ${money(body.amount_cents)}`);
    m.value = { ...blank(), account_id: m.value.account_id };
    receipt.value = null;
  } catch (e) {
    if (e.status === 0) {
      queue(body);
      toast('Offline — saved to send later');
      m.value = { ...blank(), account_id: m.value.account_id };
    } else { err.value = e.message; }
  } finally { busy.value = false; }
}

// ── miles ──
const trip = ref({ on_date: todayISO(), miles: '', purpose: '', stream_id: null, from_place: '', to_place: '' });
async function saveTrip() {
  err.value = '';
  busy.value = true;
  try {
    await api.post('/mileage', { ...trip.value, miles: Number(trip.value.miles) });
    toast(`Logged ${trip.value.miles} mi`);
    trip.value = { on_date: todayISO(), miles: '', purpose: '', stream_id: trip.value.stream_id, from_place: '', to_place: '' };
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div>
    <header class="page-head">
      <h1>Add</h1>
      <div class="seg" role="group" aria-label="What to add">
        <button :aria-pressed="mode === 'money'" @click="mode = 'money'">Money</button>
        <button :aria-pressed="mode === 'miles'" @click="mode = 'miles'">Miles</button>
      </div>
    </header>

    <div v-if="!refs.openAccounts.length" class="empty">
      <strong>Add an account first.</strong> A “Cash” account is handy for quick entries.
      <div class="actions-row"><RouterLink class="btn primary" to="/accounts">Add accounts</RouterLink></div>
    </div>

    <form v-else-if="mode === 'money'" class="add" @submit.prevent="saveMoney">
      <div class="amount-line">
        <div class="seg" role="group" aria-label="Direction">
          <button type="button" :aria-pressed="m.direction === 'out'" @click="m.direction = 'out'">Spent</button>
          <button type="button" :aria-pressed="m.direction === 'in'" @click="m.direction = 'in'">Received</button>
        </div>
        <label class="amount-field" :class="{ in: m.direction === 'in' }">
          <span class="cur">$</span>
          <input ref="amountInput" v-model="m.amount" inputmode="decimal" placeholder="0.00" aria-label="Amount" autocomplete="off" />
        </label>
      </div>

      <label class="field"><span>What was it</span>
        <input v-model="m.description" class="input" maxlength="200" :placeholder="m.direction === 'in' ? 'Gig at the Hideout' : 'Strings, parking, lunch…'" />
      </label>

      <div class="field"><span>Income stream</span><StreamChips v-model="m.stream_id" /></div>
      <div class="field"><span>Category</span><CategoryPicker v-model="m.category_id" :direction="m.direction" /></div>

      <div class="row-fields">
        <label class="field"><span>Account</span>
          <select v-model="m.account_id" class="input">
            <option v-for="a in refs.openAccounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </label>
        <label class="field"><span>Date</span><input v-model="m.posted_on" class="input" type="date" /></label>
      </div>
      <label class="field"><span>Note</span><input v-model="m.notes" class="input" maxlength="1000" /></label>
      <label class="field"><span>Receipt</span>
        <input class="input" type="file" accept="image/*,application/pdf" @change="receipt = $event.target.files?.[0] || null" />
      </label>

      <p v-if="err" class="error">{{ err }}</p>
      <button class="btn primary big" :disabled="busy">{{ busy ? 'Adding…' : cents ? `Add ${money(m.direction === 'out' ? -cents : cents)}` : 'Add' }}</button>
      <p class="small faint">Bank and card transactions arrive by import — this is for cash, checks, Venmo and anything the bank won’t show.</p>
    </form>

    <form v-else class="add" @submit.prevent="saveTrip">
      <div class="row-fields">
        <label class="field"><span>Miles</span><input v-model="trip.miles" class="input" inputmode="decimal" required /></label>
        <label class="field"><span>Date</span><input v-model="trip.on_date" class="input" type="date" required /></label>
      </div>
      <label class="field"><span>Purpose</span><input v-model="trip.purpose" class="input" placeholder="Gig at the Hideout, client meeting…" required /></label>
      <div class="row-fields">
        <label class="field"><span>From</span><input v-model="trip.from_place" class="input" /></label>
        <label class="field"><span>To</span><input v-model="trip.to_place" class="input" /></label>
      </div>
      <div class="field"><span>Income stream</span><StreamChips v-model="trip.stream_id" /></div>
      <p v-if="err" class="error">{{ err }}</p>
      <button class="btn primary big" :disabled="busy">Log trip</button>
      <p class="small"><RouterLink to="/mileage">This year’s trips</RouterLink></p>
    </form>
  </div>
</template>

<style>
.add { display: grid; gap: 4px; }
.amount-line { display: grid; gap: 14px; margin-bottom: 18px; }
.amount-line .seg { justify-self: start; }
.amount-field { display: flex; align-items: flex-start; border-bottom: 2px solid var(--rule-strong); padding-bottom: 6px; }
.amount-field:focus-within { border-color: var(--brass); }
.amount-field .cur { font-size: var(--step-2); color: var(--muted); margin-top: 6px; margin-right: 4px; }
.amount-field input {
  border: 0; background: none; outline: none; width: 100%;
  font-size: var(--step-4); font-weight: 300; letter-spacing: -0.03em; font-variant-numeric: tabular-nums;
}
.amount-field.in input { color: var(--in); }
</style>
