import { ref } from 'vue';

export const toastMsg = ref('');
let t = null;
export function toast(msg, ms = 2600) {
  toastMsg.value = msg;
  clearTimeout(t);
  t = setTimeout(() => { toastMsg.value = ''; }, ms);
}
