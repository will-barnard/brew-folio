<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { ago } from '../../format';
import { toast } from '../../toast';

const keys = ref([]);
const scopes = ref([]);
const name = ref('iPhone Shortcuts');
const chosen = ref(['inbox:write', 'transactions:write']);
const fresh = ref(null);
const err = ref('');
const origin = location.origin;

async function load() { const r = await api.get('/api-keys'); keys.value = r.keys; scopes.value = r.scopes; }
load().catch((e) => { err.value = e.message; });

async function create() {
  err.value = '';
  try { fresh.value = await api.post('/api-keys', { name: name.value, scopes: chosen.value }); load(); } catch (e) { err.value = e.message; }
}
async function revoke(k) {
  if (!window.confirm(`Revoke “${k.name}”? Shortcuts using it stop working.`)) return;
  await api.del(`/api-keys/${k.id}`); toast('Key revoked'); load();
}
async function copy() { try { await navigator.clipboard.writeText(fresh.value.key); toast('Copied'); } catch { /* select manually */ } }
const SCOPE = { 'inbox:write': 'Send files (statements, receipts)', 'transactions:write': 'Add transactions' };
</script>

<template>
  <div>
    <header class="page-head"><h1>Phone shortcuts</h1></header>
    <p class="muted">iPhone can’t share a file straight into a web app, so an iOS Shortcut sends it instead. Each Shortcut needs an API key.</p>
    <p v-if="err" class="error">{{ err }}</p>

    <section v-if="fresh" class="section note">
      <p><strong>Copy this key now.</strong> It won’t be shown again.</p>
      <p class="key">{{ fresh.key }}</p>
      <button class="btn" @click="copy">Copy key</button>
    </section>

    <section class="section panel">
      <h2>New key</h2>
      <label class="field"><span>Name</span><input v-model="name" class="input" maxlength="60" /></label>
      <div class="field"><span>Allowed to</span>
        <label v-for="s in scopes" :key="s" class="always"><input v-model="chosen" type="checkbox" :value="s" /> {{ SCOPE[s] || s }}</label>
      </div>
      <button class="btn primary" :disabled="!chosen.length || !name" @click="create">Create key</button>
    </section>

    <section class="section">
      <h2>Keys</h2>
      <ul class="ledger">
        <li v-for="k in keys" :key="k.id" class="stream-edit" :class="{ off: k.revoked_at }">
          <span class="grow">{{ k.name }} <span class="small muted">fk_{{ k.prefix }}…, used {{ ago(k.last_used_at) }}</span></span>
          <span v-if="k.revoked_at" class="small muted">Revoked</span>
          <button v-else class="btn quiet small danger" @click="revoke(k)">Revoke</button>
        </li>
      </ul>
    </section>

    <section class="section">
      <h2>Building the Shortcuts</h2>
      <h3>Send to folio (share sheet)</h3>
      <ol class="small steps">
        <li>New Shortcut, turn on “Show in Share Sheet”, accept Files and Images.</li>
        <li>Add “Get Contents of URL”: <code>{{ origin }}/api/v1/inbox</code>, method POST.</li>
        <li>Headers: <code>X-API-Key</code> = your key, <code>X-Filename</code> = Shortcut Input’s Name, <code>Content-Type</code> = <code>application/pdf</code> or <code>image/jpeg</code>.</li>
        <li>Request body: File, set to Shortcut Input.</li>
      </ol>
      <p class="small muted">Statements show up under Imports for you to confirm. Anything else is kept as a receipt.</p>
      <h3>Log cash</h3>
      <ol class="small steps">
        <li>Ask for Number (“How much?”) and Text (“What for?”).</li>
        <li>“Get Contents of URL”: <code>{{ origin }}/api/v1/transactions</code>, POST, header <code>X-API-Key</code>.</li>
        <li>Request body JSON: <code>amount</code> = minus the number, <code>description</code> = the text, optional <code>stream</code> (“Music”), <code>category</code> (“Business/Travel”), <code>account</code> (defaults to your Cash account).</li>
      </ol>
    </section>
  </div>
</template>

<style>
.steps { padding-left: 20px; display: grid; gap: 6px; }
code { font-size: 0.92em; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.off { opacity: 0.55; }
</style>
