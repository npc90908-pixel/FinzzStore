// ============================================================================
// CLIENT BOOTSTRAP — reads the server state, wires the router, mounts pages.
// No framework: ES modules + DOM API only.
// ============================================================================
import { createApi, ApiError } from './api.js';
import { createStore } from './store.js';
import { createLayout } from './layout.js';
import { el, toast, LoadingBlock } from './ui.js';

const PAGE_MODULES = {
  landing: () => import('./pages/landing.js'),
  login: () => import('./pages/login.js'),
  register: () => import('./pages/register.js'),
  'forgot-password': () => import('./pages/forgot-password.js'),
  'reset-password': () => import('./pages/reset-password.js'),
  'verify-email': () => import('./pages/verify-email.js'),
  dashboard: () => import('./pages/dashboard.js'),
  services: () => import('./pages/services.js'),
  orders: () => import('./pages/orders.js'),
  wallet: () => import('./pages/wallet.js'),
  profile: () => import('./pages/profile.js'),
  admin: () => import('./pages/admin.js'),
  terms: () => import('./pages/terms.js'),
  privacy: () => import('./pages/privacy.js'),
  status: () => import('./pages/status.js'),
  notifications: () => import('./pages/notifications.js'),
  tentang: () => import('./pages/tentang.js'),
  bantuan: () => import('./pages/bantuan.js'),
  keamanan: () => import('./pages/keamanan.js'),
  kontak: () => import('./pages/kontak.js'),
  'not-found': () => import('./pages/not-found.js'),
  forbidden: () => import('./pages/forbidden.js'),
  error: () => import('./pages/not-found.js')
};

const ROUTE_MAP = {
  '/': 'landing',
  '/login': 'login',
  '/register': 'register',
  '/forgot-password': 'forgot-password',
  '/reset-password': 'reset-password',
  '/verify-email': 'verify-email',
  '/dashboard': 'dashboard',
  '/services': 'services',
  '/orders': 'orders',
  '/wallet': 'wallet',
  '/profile': 'profile',
  '/admin': 'admin',
  '/status': 'status',
  '/notifications': 'notifications',
  '/tentang': 'tentang',
  '/bantuan': 'bantuan',
  '/keamanan': 'keamanan',
  '/kontak': 'kontak',
  '/terms': 'terms',
  '/privacy': 'privacy'
};

const PRIVATE_ROUTES = new Set(['dashboard', 'services', 'orders', 'wallet', 'profile', 'admin', 'notifications']);

function readBootState() {
  const node = document.getElementById('finzz-state');
  if (!node) return {};
  try {
    return JSON.parse(node.textContent || '{}');
  } catch {
    return {};
  }
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f7fe' : '#06070d');
}

async function bootstrap() {
  const boot = readBootState();
  const root = document.getElementById('app-root');
  if (!root) return;

  const storedTheme = localStorage.getItem('fz-theme');
  const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'dark';
  applyTheme(theme);

  const store = createStore({
    user: boot.user || null,
    config: boot.config || {},
    csrfToken: boot.csrfToken || readCookie(boot.config?.csrfCookieName || 'fz_csrf'),
    publicSettings: null,
    balance: null,
    theme
  });

  let currentCleanup = null;

  const navigate = (path, { replace = false, keepScroll = false } = {}) => {
    const url = new URL(path, window.location.origin);
    const target = `${url.pathname}${url.search}`;
    if (replace) window.history.replaceState({}, '', target);
    else if (`${window.location.pathname}${window.location.search}` !== target) window.history.pushState({}, '', target);
    render();
    // 'instant' is part of the ScrollBehavior enum in every current browser and
    // is explicitly exempt from prefers-reduced-motion.
    if (!keepScroll) window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const api = createApi({
    getCsrfToken: () => store.get('csrfToken') || readCookie('fz_csrf'),
    onUnauthorized: () => {
      if (PRIVATE_ROUTES.has(currentPageKey)) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login?next=${next}`);
      }
    }
  });

  let currentPageKey = boot.page || 'landing';

  const layout = createLayout({
    store,
    navigate,
    getTheme: () => store.get('theme'),
    onToggleTheme: (next) => {
      localStorage.setItem('fz-theme', next);
      store.set({ theme: next });
      applyTheme(next);
    },
    onLogout: async () => {
      try {
        await api.post('/api/auth/logout');
      } catch (err) {
        if (!(err instanceof ApiError)) toast({ type: 'error', title: 'Gagal keluar', message: 'Coba lagi.' });
      }
      store.set({ user: null, balance: null });
      navigate('/login');
    }
  });

  const refreshSession = async () => {
    try {
      const session = await api.get('/api/auth/session', { retries: 0 });
      store.set({ user: session.user });
      return session.user;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        store.set({ user: null, balance: null });
      }
      return null;
    }
  };

  /**
   * Sliding session refresh. Rather than running a permanent timer, this runs
   * when the tab becomes visible again and the session has not been touched for
   * a while — no background wake-ups, no leaked intervals, and a long-idle tab
   * is renewed exactly when the user comes back to it.
   */
  const SESSION_TOUCH_MS = 20 * 60 * 1000;
  let lastSessionTouch = Date.now();

  const extendSession = async () => {
    if (!store.get('user')) return null;
    if (Date.now() - lastSessionTouch < SESSION_TOUCH_MS) return null;
    try {
      const refreshed = await api.post('/api/auth/refresh', {}, { retries: 0 });
      lastSessionTouch = Date.now();
      store.set({ user: refreshed.user, csrfToken: refreshed.csrfToken });
      return refreshed;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        store.set({ user: null, balance: null });
      }
      return null;
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') extendSession();
  });

  const loadPublicSettings = async () => {
    if (store.get('publicSettings')) return store.get('publicSettings');
    try {
      const data = await api.get('/api/public/config');
      store.set({ publicSettings: data });
      return data;
    } catch {
      return null;
    }
  };

  const refreshBalance = async () => {
    if (!store.get('user')) return null;
    try {
      const wallet = await api.get('/api/wallet?page=1');
      store.set({ balance: wallet.balance });
      return wallet.balance;
    } catch {
      return null;
    }
  };

  /**
   * Unread counter for the header bell. One request per page render, no timer:
   * a badge that polls forever costs battery and can lie about freshness.
   */
  const refreshNotifications = async () => {
    if (!store.get('user')) {
      store.set({ unreadNotifications: 0 });
      return null;
    }
    try {
      const data = await api.get('/api/notifications?per_page=1', { retries: 0 });
      store.set({ unreadNotifications: data.unreadCount ?? 0 });
      return data.unreadCount ?? 0;
    } catch {
      return null;
    }
  };

  const ctx = {
    api,
    store,
    navigate,
    layout,
    toast,
    refreshSession,
    refreshBalance,
    refreshNotifications,
    ApiError,
    loadPublicSettings
  };

  const render = async () => {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
    let key = ROUTE_MAP[pathname] || 'not-found';
    const user = store.get('user');

    if (PRIVATE_ROUTES.has(key) && !user) {
      const next = encodeURIComponent(pathname + window.location.search);
      window.location.assign(`/login?next=${next}`);
      return;
    }
    if ((key === 'login' || key === 'register') && user) {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (key === 'admin' && user?.role !== 'admin') key = 'forbidden';

    currentPageKey = key;
    try {
      currentCleanup?.();
    } catch (err) {
      console.error('page cleanup failed', err);
    }
    currentCleanup = null;

    root.replaceChildren(LoadingBlock({ label: 'Memuat halaman…' }));

    try {
      const module = await PAGE_MODULES[key]();
      const page = await module.default({
        ...ctx,
        key,
        query: new URLSearchParams(window.location.search),
        pathname
      });
      if (!page || !(page.node instanceof Node)) throw new Error('page renderer returned no node');
      root.replaceChildren(page.node);
      currentCleanup = page.cleanup || null;
      if (page.title) document.title = page.title;
      if (page.status === 404 || key === 'not-found') {
        // Client-side 404: keep the shell honest about the status.
        root.dataset.status = '404';
      }
      // One unread-count refresh per navigation; never a background timer.
      refreshNotifications();
    } catch (err) {
      console.error('render failed', err);
      root.replaceChildren(
        el(
          'div',
          { class: 'container', style: { padding: '80px 20px' } },
          el('h1', { text: 'Halaman gagal dimuat' }),
          el('p', { class: 'text-muted', text: err?.message || 'Terjadi kesalahan tak terduga.' }),
          el('a', { class: 'btn btn--primary', attrs: { href: '/dashboard' }, text: 'Kembali ke dashboard' })
        )
      );
    }
  };

  // ------------------------------------------------------------ navigation
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.hasAttribute('data-native-navigation')) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (href.startsWith('#') || href.startsWith('/#')) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', () => render());
  window.addEventListener('finzz:refresh-balance', () => refreshBalance());

  // Load shared data once, then render.
  await Promise.all([loadPublicSettings(), store.get('user') ? refreshBalance() : Promise.resolve()]);
  store.subscribe(({ user }) => {
    if (!user) store.set({ balance: null });
  });
  await render();

  // A stale CSRF token or expired session surfaces as 401 on any call; the API
  // client redirects, but we also re-check the session when the tab regains focus.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && store.get('user')) refreshBalance();
  });
}

bootstrap().catch((err) => {
  console.error('boot failed', err);
  const root = document.getElementById('app-root');
  if (root) {
    root.replaceChildren(
      el('div', { class: 'container', style: { padding: '80px 20px' } },
        el('h1', { text: 'FINZZ Store gagal dimuat' }),
        el('p', { class: 'text-muted', text: 'Muat ulang halaman. Jika masalah berlanjut, hubungi dukungan.' }),
        el('button', { class: 'btn btn--primary', attrs: { type: 'button' }, text: 'Muat ulang', onClick: () => window.location.reload() })
      )
    );
  }
});
