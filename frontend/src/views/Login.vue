<script setup>
import { ref, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { useSession } from '../stores/session';

const router = useRouter();
const route = useRoute();
const session = useSession();
const username = ref('');
const password = ref('');
const code = ref('');
const needsCode = ref(false);
const codeInput = ref(null);
const err = ref('');
const busy = ref(false);

async function submit() {
  err.value = '';
  busy.value = true;
  try {
    const { user } = await api.post('/auth/login', { username: username.value.trim(), password: password.value, code: code.value || undefined });
    session.user = user;
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/';
    router.replace(next);
  } catch (e) {
    if (e.body?.totpRequired) {
      const first = !needsCode.value;
      needsCode.value = true;
      if (!first) err.value = e.message;
      await nextTick();
      codeInput.value?.focus();
    } else {
      err.value = e.message;
    }
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="auth">
    <h1 class="auth-title">folio</h1>
    <form @submit.prevent="submit">
      <label class="field"><span>Username</span><input v-model="username" class="input" autocomplete="username" autocapitalize="off" required /></label>
      <label class="field"><span>Password</span><input v-model="password" class="input" type="password" autocomplete="current-password" required /></label>
      <label v-if="needsCode" class="field"><span>Authenticator code</span>
        <input ref="codeInput" v-model="code" class="input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" />
      </label>
      <p v-if="err" class="error">{{ err }}</p>
      <button class="btn primary big" :disabled="busy">Sign in</button>
    </form>
  </div>
</template>
