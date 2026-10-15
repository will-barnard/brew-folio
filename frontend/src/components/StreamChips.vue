<script setup>
import { useRef } from '../stores/ref';

defineProps({ modelValue: { type: Number, default: null } });
const emit = defineEmits(['update:modelValue']);
const refs = useRef();
</script>

<template>
  <div class="chips" role="group" aria-label="Income stream">
    <button type="button" class="chip" :aria-pressed="modelValue === null" @click="emit('update:modelValue', null)">Household</button>
    <button v-for="s in refs.activeStreams" :key="s.id" type="button" class="chip" :aria-pressed="modelValue === s.id"
            @click="emit('update:modelValue', s.id)">
      <span class="dot" :style="{ background: s.color || 'var(--muted)' }" />{{ s.name }}
    </button>
  </div>
</template>
