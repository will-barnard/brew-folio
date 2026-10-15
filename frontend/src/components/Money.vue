<script setup>
import { computed } from 'vue';
import { splitMoney } from '../format';

const props = defineProps({
  cents: { type: Number, required: true },
  sign: { type: String, default: 'auto' }, // auto | always | none
  hero: Boolean,
  colorIn: Boolean, // tint positive amounts as money-in
});
const m = computed(() => splitMoney(props.cents, { sign: props.sign }));
const label = computed(() => `${m.value.neg ? 'minus ' : ''}${m.value.dollars} dollars ${m.value.cents} cents`);
</script>

<template>
  <span class="money amt" :class="{ hero, in: colorIn && cents > 0 }" :aria-label="label">
    <span aria-hidden="true">{{ m.sign }}</span><span class="cur" aria-hidden="true">$</span><span aria-hidden="true">{{ m.dollars }}</span><span class="c" aria-hidden="true">{{ m.cents }}</span>
  </span>
</template>
