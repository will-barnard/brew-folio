<script setup>
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session';
import { privateMode } from '../privacy';

const route = useRoute();
const router = useRouter();
const session = useSession();
async function logout() { await session.logout(); router.replace({ name: 'login' }); }

const links = [
  { to: '/imports', label: 'Imports', hint: 'Chase CSVs and statement PDFs' },
  { to: '/accounts', label: 'Accounts', hint: 'Balances, starting balances, monthly checks' },
  { to: '/mileage', label: 'Mileage', hint: 'Trips for gigs and client work' },
  { to: '/more/rules', label: 'Rules', hint: 'Automatic categories' },
  { to: '/more/categories', label: 'Categories', hint: 'Groups, names and tax lines' },
  { to: '/more/streams', label: 'Streams and books', hint: 'W2, Dev, Music — and the LLC when it exists' },
  { to: '/more/shortcuts', label: 'Phone shortcuts', hint: 'API keys for iOS Shortcuts' },
  { to: '/more/security', label: 'Security', hint: 'Two-factor sign-in, password' },
  { to: '/more/system', label: 'System', hint: 'Storage, backups, connectors' },
];
</script>

<template>
  <div>
    <header class="page-head"><h1>More</h1></header>
    <div v-if="route.query.welcome" class="note">
      Welcome. Next: turn on two-factor under Security, add your accounts, then import a Chase CSV for each.
    </div>
    <ul class="ledger">
      <li v-for="l in links" :key="l.to">
        <RouterLink :to="l.to" class="more-link"><span>{{ l.label }}</span><span class="small muted">{{ l.hint }}</span></RouterLink>
      </li>
      <li>
        <button class="more-link as-btn" @click="privateMode = !privateMode">
          <span>{{ privateMode ? 'Show amounts' : 'Hide amounts' }}</span><span class="small muted">Blurs figures for using folio in public. Tap a figure to peek.</span>
        </button>
      </li>
      <li><button class="more-link as-btn" @click="logout"><span>Sign out</span><span class="small muted">{{ session.user?.username }}</span></button></li>
    </ul>
  </div>
</template>

<style>
.more-link { display: grid; gap: 2px; padding: 12px 2px; border-bottom: 1px solid var(--rule); text-decoration: none; }
.more-link > span:first-child { font-weight: 500; }
.as-btn { width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--rule); cursor: pointer; }
</style>
