<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useSession } from '../stores/session';

const router = useRouter();
const session = useSession();
const username = ref('');
const password = ref('');
const confirm = ref('');
const err = ref('');
const busy = ref(false);

async function submit() {
  err.value = '';
  if (password.value !== confirm.value) { err.value = 'Passwords don’t match'; return; }
  busy.value = true;
  try {
    const { user } = await api.post('/auth/bootstrap', { username: username.value.trim(), password: password.value });
    session.user = user;
    session.bootstrapped = true;
    router.replace({ name: 'more', query: { welcome: '1' } });
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div class="auth">
    <h1 class="auth-title">folio</h1>
    <p class="muted">Create the owner account. This is the only account — sign-up closes once it exists.</p>
    <form @submit.prevent="submit">
      <label class="field"><span>Username</span><input v-model="username" class="input" autocomplete="username" autocapitalize="off" required /></label>
      <label class="field"><span>Password (10+ characters)</span><input v-model="password" class="input" type="password" autocomplete="new-password" minlength="10" required /></label>
      <label class="field"><span>Password again</span><input v-model="confirm" class="input" type="password" autocomplete="new-password" required /></label>
      <p v-if="err" class="error">{{ err }}</p>
      <button class="btn primary big" :disabled="busy">Create account</button>
    </form>
  </div>
</template>

<style>
.auth { max-width: 380px; margin: 12vh auto 0; }
.auth-title { font-size: var(--step-4); font-weight: 300; letter-spacing: -0.04em; margin-bottom: 12px; }
</style>
