<script setup>
// Bottom sheet on phones, centred dialog on desktop. Esc and backdrop close it.
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
import Icon from './Icon.vue';

defineProps({ title: String, wide: Boolean });
const emit = defineEmits(['close']);
const panel = ref(null);
let prevFocus = null;

function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(async () => {
  prevFocus = document.activeElement;
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  await nextTick();
  panel.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
  prevFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="sheet-backdrop" @click.self="emit('close')">
      <div ref="panel" class="sheet" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <header class="sheet-head">
          <h2>{{ title }}</h2>
          <button class="btn icon quiet" type="button" aria-label="Close" @click="emit('close')"><Icon name="x" /></button>
        </header>
        <div class="sheet-body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style>
.sheet-backdrop {
  position: fixed; inset: 0; z-index: 50; background: rgba(6, 12, 10, 0.55);
  display: flex; align-items: flex-end; justify-content: center;
}
.sheet {
  width: 100%; max-height: 92dvh; overflow: auto; background: var(--bg);
  border-radius: 16px 16px 0 0; border: 1px solid var(--rule-strong); border-bottom: 0;
  padding: 0 var(--gutter) calc(env(safe-area-inset-bottom) + 20px); outline: none;
  animation: sheet-up 0.18s ease-out;
}
.sheet-head { position: sticky; top: 0; background: var(--bg); display: flex; justify-content: space-between; align-items: center; padding: 14px 0 10px; z-index: 1; }
@keyframes sheet-up { from { transform: translateY(24px); opacity: 0.6; } }
@media (min-width: 700px) {
  .sheet-backdrop { align-items: center; }
  .sheet { width: 520px; border-radius: 14px; border-bottom: 1px solid var(--rule-strong); box-shadow: var(--shadow); }
  .sheet.wide { width: 760px; }
}
</style>
