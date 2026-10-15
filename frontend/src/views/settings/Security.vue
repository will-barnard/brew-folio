<script setup>
import { ref } from 'vue';
import { api } from '../../api';
import { useSession } from '../../stores/session';
import { toast } from '../../toast';

const session = useSession();
const setup = ref(null);
const code = ref('');
const disablePw = ref('');
const pw = ref({ current: '', next: '', again: '' });
const err = ref('');

async function act(fn) { err.value = ''; try { await fn(); } catch (e) { err.value = e.message; } }
const begin = () => act(async () => { setup.value = await api.post('/auth/totp/setup', {}); });
const enable = () => act(async () => {
  await api.post('/auth/totp/enable', { code: code.value });
  setup.value = null; code.value = ''; await session.check(); toast('Two-factor is on');
});
const disable = () => act(async () => {
  await api.post('/auth/totp/disable', { password: disablePw.value });
  disablePw.value = ''; await session.check(); toast('Two-factor is off');
});
const changePw = () => act(async () => {
  if (pw.value.next !== pw.value.again) throw new Error('New passwords don’t match');
  await api.post('/auth/password', { current: pw.value.current, next: pw.value.next });
  pw.value = { current: '', next: '', again: '' }; toast('Password changed — other devices signed out');
});
</script>

<template>
  <div>
    <header class="page-head"><h1>Security</h1></header>
    <p v-if="err" class="error">{{ err }}</p>

    <section class="section panel">
      <h2>Two-factor sign-in</h2>
      <template v-if="session.user?.totpEnabled">
        <p class="in">On. Signing in asks for a code from your authenticator.</p>
        <form class="inline-add" @submit.prevent="disable">
          <input v-model="disablePw" class="input" type="password" placeholder="Password to turn off" autocomplete="current-password" />
          <button class="btn quiet danger">Turn off</button>
        </form>
      </template>
      <template v-else-if="!setup">
        <p class="muted">Off. This app holds every account you have — turn this on.</p>
        <button class="btn primary" @click="begin">Set up two-factor</button>
      </template>
      <template v-else>
        <p>On your iPhone, tap <a :href="setup.otpauth">Add to authenticator</a> (opens Passwords or your authenticator app),
          or enter this key by hand:</p>
        <p class="key">{{ setup.secret.match(/.{1,4}/g).join(' ') }}</p>
        <form class="inline-add" @submit.prevent="enable">
          <input v-model="code" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="7" />
          <button class="btn primary">Turn on</button>
        </form>
      </template>
    </section>

    <section class="section panel">
      <h2>Password</h2>
      <form @submit.prevent="changePw">
        <label class="field"><span>Current</span><input v-model="pw.current" class="input" type="password" autocomplete="current-password" /></label>
        <div class="row-fields">
          <label class="field"><span>New (10+ characters)</span><input v-model="pw.next" class="input" type="password" autocomplete="new-password" /></label>
          <label class="field"><span>New again</span><input v-model="pw.again" class="input" type="password" autocomplete="new-password" /></label>
        </div>
        <button class="btn">Change password</button>
      </form>
    </section>
  </div>
</template>

<style>
.key { font-size: var(--step-1); letter-spacing: 0.08em; word-break: break-all; padding: 10px 12px; background: var(--surface-2); border-radius: 8px; }
</style>
