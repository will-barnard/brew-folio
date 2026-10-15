<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSession } from './stores/session';
import { useRef } from './stores/ref';
import { privateMode } from './privacy';
import { toastMsg } from './toast';
import { pending } from './outbox';
import Icon from './components/Icon.vue';

const route = useRoute();
const session = useSession();
const refs = useRef();
const chrome = computed(() => session.user && !route.meta.public);

const tabs = [
  { to: '/', name: 'glance', label: 'Glance', icon: 'glance' },
  { to: '/activity', name: 'activity', label: 'Activity', icon: 'list' },
  { to: '/add', name: 'add', label: 'Add', icon: 'plus', primary: true },
  { to: '/review', name: 'review', label: 'Review', icon: 'review' },
  { to: '/more', name: 'more', label: 'More', icon: 'more' },
];
const desktopExtra = [
  { to: '/imports', label: 'Imports' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/mileage', label: 'Mileage' },
];
const isActive = (t) => (t.to === '/' ? route.path === '/' : route.path.startsWith(t.to));
</script>

<template>
  <div class="shell">
    <nav v-if="chrome" class="rail" aria-label="Main">
      <div class="brand">folio</div>
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="rail-link" :class="{ on: isActive(t) }">
        <Icon :name="t.icon" :size="18" />{{ t.label }}
        <span v-if="t.name === 'review' && refs.reviewCount" class="count">{{ refs.reviewCount }}</span>
      </RouterLink>
      <div class="rail-sep" />
      <RouterLink v-for="t in desktopExtra" :key="t.to" :to="t.to" class="rail-link" :class="{ on: isActive(t) }">{{ t.label }}</RouterLink>
      <button class="rail-link privacy" type="button" :aria-pressed="privateMode" @click="privateMode = !privateMode">
        <Icon :name="privateMode ? 'eyeOff' : 'eye'" :size="18" />{{ privateMode ? 'Amounts hidden' : 'Hide amounts' }}
      </button>
    </nav>

    <main class="main">
      <div v-if="chrome && pending.length" class="note small">
        {{ pending.length }} entr{{ pending.length === 1 ? 'y' : 'ies' }} waiting to send — they’ll go when you’re back online.
      </div>
      <RouterView />
    </main>

    <nav v-if="chrome" class="tabbar" aria-label="Main">
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab" :class="{ on: isActive(t), primary: t.primary }"
                  :aria-label="t.label">
        <span class="tab-icon"><Icon :name="t.icon" :size="t.primary ? 26 : 22" /></span>
        <span v-if="!t.primary" class="tab-label">{{ t.label }}</span>
        <span v-if="t.name === 'review' && refs.reviewCount" class="count">{{ refs.reviewCount > 99 ? '99+' : refs.reviewCount }}</span>
      </RouterLink>
    </nav>

    <div v-if="toastMsg" class="toast" role="status">{{ toastMsg }}</div>
  </div>
</template>

<style>
.rail { display: none; }
@media (min-width: 900px) {
  .rail {
    display: flex; flex-direction: column; gap: 2px; position: fixed; inset: 0 auto 0 0; width: var(--rail);
    padding: 28px 14px; border-right: 1px solid var(--rule); background: var(--bg);
  }
  .brand { font-size: var(--step-2); font-weight: 300; letter-spacing: -0.02em; padding: 0 10px 22px; }
  .rail-link {
    display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px;
    text-decoration: none; color: var(--muted); font-weight: 500; border: 0; background: none; cursor: pointer; text-align: left;
  }
  .rail-link:hover { color: var(--text); }
  .rail-link.on { color: var(--text); background: var(--surface-2); }
  .rail-link .count { margin-left: auto; }
  .rail-sep { height: 1px; background: var(--rule); margin: 12px 10px; }
  .privacy { margin-top: auto; }
}
.count {
  background: var(--brass); color: var(--on-brass); border-radius: 999px; font-size: 11px; font-weight: 700;
  min-width: 18px; height: 18px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center;
}
.tabbar {
  position: fixed; inset: auto 0 0 0; z-index: 40; display: grid; grid-template-columns: repeat(5, 1fr);
  height: calc(var(--tabbar) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);
  background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(12px);
  border-top: 1px solid var(--rule);
}
@media (min-width: 900px) { .tabbar { display: none; } }
.tab {
  position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  text-decoration: none; color: var(--faint); font-size: 11px; font-weight: 500;
}
.tab.on { color: var(--text); }
.tab.primary .tab-icon {
  width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center;
  background: var(--brass); color: var(--on-brass);
}
.tab .count { position: absolute; top: 6px; left: calc(50% + 6px); }
</style>
