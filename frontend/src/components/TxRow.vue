<script setup>
import Money from './Money.vue';
import Icon from './Icon.vue';

defineProps({ t: { type: Object, required: true }, showAccount: { type: Boolean, default: true } });
defineEmits(['open']);
</script>

<template>
  <button type="button" class="row" @click="$emit('open', t)">
    <span class="who">{{ t.merchant || t.description_raw }}</span>
    <Money class="amt" :cents="t.amount_cents" color-in />
    <span class="what">
      <span v-if="t.stream_name" class="dot" :style="{ background: t.stream_color || 'var(--muted)' }" :title="t.stream_name" />
      <span v-if="t.is_split">Split</span>
      <span v-else-if="t.category_name">{{ t.category_name }}</span>
      <span v-else class="uncat">Needs a category</span>
      <span v-if="showAccount" class="faint">{{ t.account_name }}</span>
      <Icon v-if="Number(t.receipt_count)" name="receipt" :size="14" />
    </span>
  </button>
</template>
