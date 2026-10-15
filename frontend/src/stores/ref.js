// Reference data: accounts, streams, categories, entities. Loaded once after
// sign-in and refreshed after edits.
import { defineStore } from 'pinia';
import { api } from '../api';

export const useRef = defineStore('ref', {
  state: () => ({ entities: [], streams: [], categories: [], accounts: [], loaded: false, reviewCount: 0 }),
  getters: {
    streamById: (s) => Object.fromEntries(s.streams.map((x) => [x.id, x])),
    categoryById: (s) => Object.fromEntries(s.categories.map((x) => [x.id, x])),
    accountById: (s) => Object.fromEntries(s.accounts.map((x) => [x.id, x])),
    activeStreams: (s) => s.streams.filter((x) => x.active),
    openAccounts: (s) => s.accounts.filter((x) => !x.is_closed),
    // Two-level tree: groups with their children, archived hidden.
    categoryTree: (s) => {
      const groups = s.categories.filter((c) => !c.parent_id && !c.archived);
      return groups.map((g) => ({ ...g, children: s.categories.filter((c) => c.parent_id === g.id && !c.archived) }));
    },
  },
  actions: {
    async load() {
      const [r, accounts] = await Promise.all([api.get('/reference'), api.get('/accounts')]);
      Object.assign(this, r, { accounts, loaded: true });
    },
    async loadAccounts() { this.accounts = await api.get('/accounts'); },
    categoryLabel(id) {
      return this.categoryById[id]?.name || null;
    },
    // "Business / Travel" — for places where the bare name is ambiguous.
    categoryPath(id) {
      const c = this.categoryById[id];
      if (!c) return null;
      return c.parent_name ? `${c.parent_name} / ${c.name}` : c.name;
    },
  },
});
