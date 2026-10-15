import { defineStore } from 'pinia';
import { api } from '../api';

export const useSession = defineStore('session', {
  state: () => ({ user: null, checked: false, bootstrapped: true }),
  actions: {
    async check() {
      try {
        const { user } = await api.get('/auth/me');
        this.user = user;
      } catch {
        this.user = null;
        const s = await api.get('/auth/state').catch(() => ({ bootstrapped: true }));
        this.bootstrapped = s.bootstrapped;
      }
      this.checked = true;
      return this.user;
    },
    async logout() {
      await api.post('/auth/logout', {}).catch(() => {});
      this.user = null;
    },
  },
});
