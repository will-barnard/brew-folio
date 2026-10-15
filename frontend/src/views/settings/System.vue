<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { ago } from '../../format';

const sys = ref(null);
const conns = ref(null);
const audit = ref([]);
const err = ref('');
Promise.all([api.get('/system'), api.get('/connectors'), api.get('/audit?limit=30')])
  .then(([s, c, a]) => { sys.value = s; conns.value = c; audit.value = a; })
  .catch((e) => { err.value = e.message; });
const JOB = { balance_snapshot: 'Nightly balance snapshot', db_backup: 'Nightly database backup' };
</script>

<template>
  <div>
    <header class="page-head"><h1>System</h1></header>
    <p v-if="err" class="error">{{ err }}</p>
    <template v-if="sys">
      <dl class="kv">
        <dt>Files</dt><dd>{{ sys.storage === 'brew-bucket' ? 'brew-bucket, encrypted' : 'Local volume, encrypted' }}</dd>
        <dt>Backups</dt><dd :class="{ danger: sys.storage !== 'brew-bucket' }">{{ sys.backups }}</dd>
        <dt>dry-dock</dt><dd>{{ sys.drydock }}</dd>
        <dt>Ledger</dt><dd>{{ sys.counts.transactions }} transactions, {{ sys.counts.imports }} imports, {{ sys.counts.rules }} rules, {{ sys.counts.receipts }} receipts</dd>
      </dl>

      <section class="section">
        <h2>Jobs</h2>
        <p v-if="!sys.jobs.length" class="small muted">Nothing has run yet — the nightly jobs start after 2am.</p>
        <ul class="ledger">
          <li v-for="j in sys.jobs" :key="j.kind" class="cat-line">
            <span>{{ JOB[j.kind] || j.kind }}<span v-if="j.result?.skipped" class="small muted"> (skipped: {{ j.result.skipped }})</span></span>
            <span class="small" :class="j.status === 'failed' ? 'danger' : 'muted'">{{ j.status }}, {{ ago(j.finished_at) }}</span>
          </li>
        </ul>
      </section>
    </template>

    <section v-if="conns" class="section">
      <h2>Connections</h2>
      <ul class="ledger">
        <li v-for="c in conns.available" :key="c.id" class="cat-line"><span>{{ c.name }} <span class="small muted">{{ c.covers }}</span></span><span class="small in">Working</span></li>
        <li v-for="c in conns.planned" :key="c.id" class="cat-line"><span>{{ c.name }} <span class="small muted">{{ c.covers }}</span></span><span class="small faint">Phase {{ c.phase }}</span></li>
      </ul>
    </section>

    <section class="section">
      <h2>Recent changes</h2>
      <ul class="ledger small">
        <li v-for="a in audit" :key="a.id" class="cat-line"><span>{{ a.action }} {{ a.entity }} {{ a.entity_id }}</span><span class="muted">{{ a.actor }}, {{ ago(a.at) }}</span></li>
      </ul>
    </section>
  </div>
</template>
