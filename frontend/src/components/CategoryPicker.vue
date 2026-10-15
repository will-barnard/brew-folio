<script setup>
// Category chooser built for a phone: groups first, one group open at a time,
// search across everything. Groups are ordered by the direction of the money.
import { computed, ref, watch } from 'vue';
import { useRef } from '../stores/ref';

const props = defineProps({
  modelValue: { type: Number, default: null },
  direction: { type: String, default: null }, // 'in' | 'out'
});
const emit = defineEmits(['update:modelValue']);
const refs = useRef();
const q = ref('');
const openGroup = ref(null);

// Open the group holding the current pick.
watch(() => props.modelValue, (id) => {
  const c = refs.categoryById[id];
  if (c?.parent_id) openGroup.value = c.parent_id;
}, { immediate: true });

const ordered = computed(() => {
  const order = props.direction === 'in' ? ['income', 'transfer', 'expense'] : ['expense', 'transfer', 'income'];
  return [...refs.categoryTree].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
});
const matches = computed(() => {
  const term = q.value.trim().toLowerCase();
  if (!term) return null;
  return ordered.value.flatMap((g) => g.children
    .filter((c) => c.name.toLowerCase().includes(term) || g.name.toLowerCase().includes(term))
    .map((c) => ({ ...c, group: g.name })));
});
const current = computed(() => ordered.value.find((g) => g.id === openGroup.value));
const pick = (id) => emit('update:modelValue', props.modelValue === id ? null : id);
</script>

<template>
  <div class="catpick">
    <input v-model="q" class="input" type="search" placeholder="Find a category" aria-label="Find a category" />

    <div v-if="matches" class="chips">
      <button v-for="c in matches" :key="c.id" type="button" class="chip" :aria-pressed="modelValue === c.id" @click="pick(c.id)">
        {{ c.name }} <span class="faint">{{ c.group }}</span>
      </button>
      <p v-if="!matches.length" class="muted small">No category matches “{{ q }}”. Add one under More, Categories.</p>
    </div>

    <template v-else>
      <div class="chips groups" role="group" aria-label="Category group">
        <button v-for="g in ordered" :key="g.id" type="button" class="chip group" :aria-expanded="openGroup === g.id"
                :class="{ has: refs.categoryById[modelValue]?.parent_id === g.id }"
                @click="openGroup = openGroup === g.id ? null : g.id">{{ g.name }}</button>
      </div>
      <div v-if="current" class="chips children">
        <button v-for="c in current.children" :key="c.id" type="button" class="chip" :aria-pressed="modelValue === c.id" @click="pick(c.id)">{{ c.name }}</button>
      </div>
    </template>
  </div>
</template>

<style>
.catpick { display: grid; gap: 10px; }
.chip.group { border-style: dashed; color: var(--muted); }
.chip.group[aria-expanded='true'] { border-style: solid; color: var(--text); background: var(--surface-2); }
.chip.group.has { color: var(--brass); border-color: var(--brass); }
.children { padding: 10px; border-radius: 10px; background: var(--surface); }
</style>
