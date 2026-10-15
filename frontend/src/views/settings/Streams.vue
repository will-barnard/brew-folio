<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { useRef } from '../../stores/ref';
import { toast } from '../../toast';

const refs = useRef();
const err = ref('');
const s = ref({ name: '', kind: 'schedule_c', color: '#9db4c0' });
const e = ref({ name: '', kind: 'llc' });

async function act(fn, msg) {
  err.value = '';
  try { await fn(); await refs.load(); toast(msg); } catch (x) { err.value = x.message; }
}
const addStream = () => act(async () => { await api.post('/streams', s.value); s.value = { name: '', kind: 'schedule_c', color: '#9db4c0' }; }, 'Stream added');
const patchStream = (st, patch) => act(() => api.patch(`/streams/${st.id}`, patch), 'Saved');
const addEntity = () => act(async () => { await api.post('/entities', e.value); e.value = { name: '', kind: 'llc' }; }, 'Books added');
const KIND = { w2: 'W2 job', schedule_c: 'Self-employed (Schedule C)', other: 'Other' };
const EKIND = { personal: 'Personal', sole_prop: 'Sole proprietor', llc: 'LLC', other: 'Other' };
</script>

<template>
  <div>
    <header class="page-head"><h1>Streams and books</h1></header>
    <p v-if="err" class="error">{{ err }}</p>

    <section class="section">
      <h2>Income streams</h2>
      <p class="small muted">Tag income and business costs with a stream to get a profit-and-loss for each. Untagged spending is household.</p>
      <ul class="ledger">
        <li v-for="st in refs.streams" :key="st.id" class="stream-edit">
          <input type="color" :value="st.color || '#999999'" aria-label="Colour" @change="patchStream(st, { color: $event.target.value })" />
          <span class="grow">{{ st.name }} <span class="small muted">{{ KIND[st.kind] }}</span></span>
          <select class="input narrow" :value="st.entity_id" aria-label="Books" @change="patchStream(st, { entity_id: Number($event.target.value) })">
            <option v-for="en in refs.entities" :key="en.id" :value="en.id">{{ en.name }}</option>
          </select>
          <button class="btn quiet small" @click="patchStream(st, { active: !st.active })">{{ st.active ? 'Retire' : 'Restore' }}</button>
        </li>
      </ul>
      <form class="inline-add" @submit.prevent="addStream">
        <input v-model="s.name" class="input" placeholder="New stream, e.g. Teaching" required />
        <select v-model="s.kind" class="input narrow"><option v-for="(l, k) in KIND" :key="k" :value="k">{{ l }}</option></select>
        <button class="btn">Add</button>
      </form>
    </section>

    <section class="section">
      <h2>Books</h2>
      <p class="small muted">
        Everything lives in Personal for now. When the dev LLC forms, add it here, move its bank account and the Dev stream into it,
        and money between you and the LLC becomes an owner contribution or draw instead of income or spending.
      </p>
      <ul class="ledger">
        <li v-for="en in refs.entities" :key="en.id" class="stream-edit"><span class="grow">{{ en.name }}</span><span class="small muted">{{ EKIND[en.kind] }}</span></li>
      </ul>
      <form class="inline-add" @submit.prevent="addEntity">
        <input v-model="e.name" class="input" placeholder="Dev business LLC" required />
        <select v-model="e.kind" class="input narrow"><option v-for="(l, k) in EKIND" :key="k" :value="k">{{ l }}</option></select>
        <button class="btn">Add</button>
      </form>
    </section>
  </div>
</template>

<style>
.stream-edit { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid var(--rule); flex-wrap: wrap; }
.stream-edit input[type='color'] { width: 28px; height: 28px; border: 0; padding: 0; background: none; }
.grow { flex: 1; min-width: 8em; }
.input.narrow { width: auto; min-width: 9em; flex: 0 1 auto; }
</style>
