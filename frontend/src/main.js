import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource-variable/public-sans';
import './styles.css';
import App from './App.vue';
import router from './router';
import { useSession } from './stores/session';
import { useRef } from './stores/ref';
import { flush } from './outbox';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.checked) await session.check();
  if (to.meta.public) {
    if (session.user) return { name: 'glance' };
    if (to.name === 'login' && !session.bootstrapped) return { name: 'setup' };
    return true;
  }
  if (!session.user) return session.bootstrapped ? { name: 'login', query: { next: to.fullPath } } : { name: 'setup' };
  const refs = useRef();
  if (!refs.loaded) await refs.load();
  return true;
});

router.afterEach(() => { flush(); });

app.mount('#app');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
