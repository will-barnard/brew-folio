<script setup>
import { ref, watch } from 'vue';
import { api } from '../api';
import { dayLabel } from '../format';
import { toast } from '../toast';

const thisYear = new Date().getFullYear();
const year = ref(thisYear);
const data = ref(null);
const err = ref('');
async function load() { try { data.value = await api.get(`/mileage?year=${year.value}`); } catch (e) { err.value = e.message; } }
watch(year, load, { immediate: true });
async function remove(id) {
  if (!window.confirm('Delete this trip?')) return;
  await api.del(`/mileage/${id}`); toast('Trip deleted'); load();
}
</script>

<template>
  <div>
    <header class="page-head">
      <h1>Mileage</h1>
      <div class="actions">
        <select v-model="year" class="input" aria-label="Year">
          <option v-for="y in [thisYear, thisYear - 1, thisYear - 2]" :key="y" :value="y">{{ y }}</option>
        </select>
        <RouterLink class="btn primary" :to="{ name: 'add' }">Log a trip</RouterLink>
      </div>
    </header>
    <p v-if="err" class="error">{{ err }}</p>
    <template v-if="data">
      <p class="big-figure"><span class="money hero">{{ data.total_miles.toLocaleString() }}</span> <span class="muted">miles in {{ data.year }}</span></p>
      <p class="small muted">Business miles for gigs and client work. Your accountant applies the year’s IRS rate.</p>
      <div v-if="!data.trips.length" class="empty"><strong>No trips logged for {{ data.year }}.</strong> Use Add → Miles after a gig.</div>
      <div class="scroll-x" v-else>
        <table class="table">
          <thead><tr><th>Date</th><th>Purpose</th><th>Stream</th><th class="num">Miles</th><th /></tr></thead>
          <tbody>
            <tr v-for="t in data.trips" :key="t.id">
              <td class="nowrap">{{ dayLabel(t.on_date) }}</td>
              <td>{{ t.purpose }}<div v-if="t.from_place || t.to_place" class="faint">{{ t.from_place }} to {{ t.to_place }}</div></td>
              <td>{{ t.stream_name || '' }}</td>
              <td class="num">{{ Number(t.miles).toFixed(1) }}</td>
              <td><button class="btn quiet small" @click="remove(t.id)">Delete</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style>
.big-figure { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 8px; }
</style>
