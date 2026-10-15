import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/setup', name: 'setup', component: () => import('./views/Setup.vue'), meta: { public: true } },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/', name: 'glance', component: () => import('./views/Glance.vue') },
  { path: '/activity', name: 'activity', component: () => import('./views/Activity.vue') },
  { path: '/add', name: 'add', component: () => import('./views/Add.vue') },
  { path: '/review', name: 'review', component: () => import('./views/Review.vue') },
  { path: '/imports', name: 'imports', component: () => import('./views/Imports.vue') },
  { path: '/imports/:id', name: 'import', component: () => import('./views/ImportDetail.vue'), props: true },
  { path: '/accounts', name: 'accounts', component: () => import('./views/Accounts.vue') },
  { path: '/accounts/:id', name: 'account', component: () => import('./views/AccountDetail.vue'), props: true },
  { path: '/mileage', name: 'mileage', component: () => import('./views/Mileage.vue') },
  { path: '/more', name: 'more', component: () => import('./views/More.vue') },
  { path: '/more/categories', name: 'categories', component: () => import('./views/settings/Categories.vue') },
  { path: '/more/streams', name: 'streams', component: () => import('./views/settings/Streams.vue') },
  { path: '/more/rules', name: 'rules', component: () => import('./views/settings/Rules.vue') },
  { path: '/more/security', name: 'security', component: () => import('./views/settings/Security.vue') },
  { path: '/more/shortcuts', name: 'shortcuts', component: () => import('./views/settings/Shortcuts.vue') },
  { path: '/more/system', name: 'system', component: () => import('./views/settings/System.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, saved) => saved || { top: 0 },
});

// Auth guard is installed in main.js (it needs pinia, which needs the app).
export default router;
