<script setup>
import { ref, watch } from 'vue';
import { api, qs } from '../api';
import { useRef } from '../stores/ref';
import { privateMode } from '../privacy';
import { monthLabel, shiftMonth, todayISO, KIND_LABEL } from '../format';
import Money from '../components/Money.vue';
import TxRow from '../components/TxRow.vue';
import TxSheet from '../components/TxSheet.vue';
import Icon from '../components/Icon.vue';

const refs = useRef();
const month = ref(todayISO().slice(0, 7));
const g = ref(null);
const err = ref('');
const openId = ref(null);

async function load() {
  err.value = '';
  try {
    g.value = await api.get(`/reports/glance${qs({ month: month.value })}`);
    refs.reviewCount = g.value.review_count;
  } catch (e) { err.value = e.message; }
}
watch(month, load, { immediate: true });
const isCurrent = () => month.value === todayISO().slice(0, 7);
</script>

<template>
  <div>
    <header class="page-head">
      <div class="month-nav">
        <button class="btn icon quiet" aria-label="Previous month" @click="month = shiftMonth(month, -1)"><Icon name="back" /></button>
        <h1>{{ monthLabel(month) }}</h1>
        <button class="btn icon quiet flip" aria-label="Next month" :disabled="isCurrent()" @click="month = shiftMonth(month, 1)"><Icon name="back" /></button>
      </div>
      <button class="btn icon quiet" :aria-pressed="privateMode" :aria-label="privateMode ? 'Show amounts' : 'Hide amounts'"
              @click="privateMode = !privateMode"><Icon :name="privateMode ? 'eyeOff' : 'eye'" /></button>
    </header>

    <p v-if="err" class="error">{{ err }}</p>

    <template v-if="g">
      <section v-if="!g.accounts.length" class="empty">
        <strong>Start with your accounts.</strong>
        Add Chase checking and each card, then import an activity CSV for each.
        <div class="actions-row"><RouterLink class="btn primary" to="/accounts">Add accounts</RouterLink></div>
      </section>

      <template v-else>
        <div class="worth">
          <div class="muted small">Net worth</div>
          <Money :cents="g.net_worth_cents" hero />
        </div>

        <div class="flow">
          <div><span class="muted small">In</span><Money :cents="g.income_cents" class="flow-n in" /></div>
          <div><span class="muted small">Spent</span><Money :cents="g.spending_cents" class="flow-n" /></div>
          <div v-if="g.uncategorized_in_cents || g.uncategorized_out_cents">
            <span class="muted small">Not sorted yet</span>
            <span class="flow-n small"><Money :cents="g.uncategorized_in_cents" sign="always" /> / <Money :cents="-g.uncategorized_out_cents" /></span>
          </div>
        </div>

        <RouterLink v-if="g.review_count" to="/review" class="review-cta">
          <span><strong>{{ g.review_count }}</strong> transaction{{ g.review_count === 1 ? '' : 's' }} need a category</span>
          <span class="btn primary">Review</span>
        </RouterLink>

        <section class="section">
          <h2>Income streams</h2>
          <ul class="ledger">
            <li v-for="s in g.streams" :key="s.id" class="stream">
              <span class="stream-name"><span class="dot" :style="{ background: s.color || 'var(--muted)' }" />{{ s.name }}</span>
              <span class="stream-figs small muted">
                <span>in <Money :cents="s.income_cents" /></span>
                <span v-if="s.expense_cents">costs <Money :cents="s.expense_cents" /></span>
              </span>
              <Money class="stream-net" :cents="s.net_cents" color-in />
            </li>
          </ul>
        </section>

        <section v-if="g.top_categories.length" class="section">
          <h2>Where it went</h2>
          <ul class="ledger">
            <li v-for="c in g.top_categories" :key="c.id" class="cat-line">
              <RouterLink :to="{ name: 'activity', query: { category_id: c.id, month } }">{{ c.name }}</RouterLink>
              <Money :cents="c.spent_cents" />
            </li>
          </ul>
        </section>

        <section class="section">
          <h2>Accounts <RouterLink to="/accounts">Manage</RouterLink></h2>
          <ul class="ledger">
            <li v-for="a in g.accounts" :key="a.id">
              <RouterLink :to="`/accounts/${a.id}`" class="acct-line">
                <span class="acct-left">
                  <span>{{ a.name }}</span>
                  <span class="small faint">{{ KIND_LABEL[a.kind] }}</span>
                  <span v-if="a.stale" class="small uncat-text">needs a fresh import</span>
                </span>
                <Money :cents="a.balance_cents" />
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="g.recent.length" class="section">
          <h2>Latest <RouterLink to="/activity">All activity</RouterLink></h2>
          <div class="ledger">
            <TxRow v-for="t in g.recent" :key="t.id" :t="t" @open="openId = t.id" />
          </div>
        </section>
      </template>
    </template>

    <TxSheet v-if="openId" :id="openId" @close="openId = null" @changed="load" />
  </div>
</template>

<style>
.month-nav { display: flex; align-items: center; gap: 2px; margin-left: -10px; }
.month-nav h1 { font-size: var(--step-1); min-width: 9.5em; text-align: center; }
.flip svg { transform: scaleX(-1); }
.worth { margin: 8px 0 18px; display: grid; gap: 6px; }
.flow { display: flex; flex-wrap: wrap; gap: 10px 28px; padding: 14px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.flow > div { display: grid; gap: 2px; }
.flow-n { font-size: var(--step-1); }
.review-cta {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px;
  padding: 12px 12px 12px 16px; border-radius: 12px; background: var(--brass-soft); text-decoration: none;
  border: 1px solid color-mix(in srgb, var(--brass) 40%, transparent);
}
.stream { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); }
.stream-name { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.stream-figs { grid-column: 1; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.stream-figs > span { white-space: nowrap; display: inline-flex; gap: 4px; align-items: baseline; }
.stream-net { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-size: var(--step-1); }
.cat-line, .acct-line { display: flex; justify-content: space-between; gap: 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); }
.cat-line a, .acct-line { text-decoration: none; }
.uncat-text { color: var(--brass); }
.acct-left { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
</style>
