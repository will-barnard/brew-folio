<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { useRef } from '../../stores/ref';
import { toast } from '../../toast';

const refs = useRef();
const err = ref('');
const newChild = ref({});
const newGroup = ref({ name: '', kind: 'expense' });
const editing = ref(null);

async function act(fn, msg) {
  err.value = '';
  try { await fn(); await refs.load(); if (msg) toast(msg); } catch (e) { err.value = e.message; }
}
const addChild = (g) => act(async () => {
  const name = (newChild.value[g.id] || '').trim();
  if (!name) return;
  await api.post('/categories', { name, parent_id: g.id, is_business: g.name === 'Business' });
  newChild.value[g.id] = '';
}, 'Category added');
const addGroup = () => act(async () => {
  await api.post('/categories', { name: newGroup.value.name, kind: newGroup.value.kind });
  newGroup.value.name = '';
}, 'Group added');
const saveEdit = () => act(async () => {
  const c = editing.value;
  await api.patch(`/categories/${c.id}`, { name: c.name, tax_line: c.tax_line || null, is_business: c.is_business });
  editing.value = null;
}, 'Saved');
const archive = (c) => act(() => api.patch(`/categories/${c.id}`, { archived: true }), `${c.name} archived`);
const KIND = { income: 'Income', expense: 'Spending', transfer: 'Transfers — not counted as income or spending' };
</script>

<template>
  <div>
    <header class="page-head"><h1>Categories</h1></header>
    <p class="small muted">Tax lines are Schedule C hints for whoever does your taxes, not advice. Archived categories stay on old transactions.</p>
    <p v-if="err" class="error">{{ err }}</p>

    <section v-for="g in refs.categoryTree" :key="g.id" class="section">
      <h2>{{ g.name }} <span class="small muted">{{ KIND[g.kind] }}</span></h2>
      <ul class="ledger">
        <li v-for="c in g.children" :key="c.id" class="cat-edit">
          <template v-if="editing?.id === c.id">
            <input v-model="editing.name" class="input" aria-label="Name" />
            <input v-model="editing.tax_line" class="input tax" placeholder="Tax line" aria-label="Tax line" />
            <label class="small"><input v-model="editing.is_business" type="checkbox" /> Business</label>
            <button class="btn primary" @click="saveEdit">Save</button>
            <button class="btn quiet" @click="editing = null">Cancel</button>
          </template>
          <template v-else>
            <span>{{ c.name }}</span>
            <span class="small faint">{{ c.tax_line || '' }}</span>
            <button class="btn quiet small" @click="editing = { ...c }">Edit</button>
            <button v-if="!c.system_key" class="btn quiet small" @click="archive(c)">Archive</button>
          </template>
        </li>
      </ul>
      <form class="inline-add" @submit.prevent="addChild(g)">
        <input v-model="newChild[g.id]" class="input" :placeholder="`New ${g.name.toLowerCase()} category`" />
        <button class="btn">Add</button>
      </form>
    </section>

    <section class="section panel">
      <h2>New group</h2>
      <form class="inline-add" @submit.prevent="addGroup">
        <input v-model="newGroup.name" class="input" placeholder="Group name" required />
        <select v-model="newGroup.kind" class="input"><option value="expense">Spending</option><option value="income">Income</option></select>
        <button class="btn">Add group</button>
      </form>
    </section>
  </div>
</template>

<style>
.cat-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 2px; border-bottom: 1px solid var(--rule); }
.cat-edit > span:first-child { flex: 1; min-width: 8em; }
.cat-edit .input { width: auto; flex: 1; min-width: 8em; }
.cat-edit .input.tax { flex: 0 0 7em; }
.inline-add { display: flex; gap: 8px; margin-top: 10px; }
.inline-add .input { flex: 1; }
</style>
