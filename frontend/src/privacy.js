// Privacy mode blurs every amount (tap to peek). Remembered per device.
import { ref, watchEffect } from 'vue';

const KEY = 'folio.private';
let initial = false;
try { initial = localStorage.getItem(KEY) === '1'; } catch { /* storage blocked */ }
export const privateMode = ref(initial);

watchEffect(() => {
  document.documentElement.classList.toggle('private', privateMode.value);
  try { localStorage.setItem(KEY, privateMode.value ? '1' : '0'); } catch { /* ignore */ }
});
