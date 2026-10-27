// ============================================================================
// PAGE REGISTRY — the single source of truth for page routes, titles and access
// rules. The server uses it to render the initial HTML and to redirect
// anonymous visitors; the client uses the same keys to pick a page module.
// ============================================================================

export const PAGES = Object.freeze({
  '/': {
    key: 'landing',
    title: 'FINZZ Store — Nomor Virtual Instan untuk Verifikasi Akun',
    description:
      'Beli nomor virtual (nokos) untuk verifikasi WhatsApp, Telegram, Google, Instagram dan layanan lain. OTP tampil otomatis di dashboard FINZZ Store.',
    requiresAuth: false,
    nav: 'home'
  },
  '/login': {
    key: 'login',
    title: 'Masuk — FINZZ Store',
    description: 'Masuk ke akun FINZZ Store untuk membeli nomor virtual dan melihat OTP.',
    requiresAuth: false,
    guestOnly: true,
    nav: null
  },
  '/register': {
    key: 'register',
    title: 'Daftar — FINZZ Store',
    description: 'Buat akun FINZZ Store untuk mulai membeli nomor virtual.',
    requiresAuth: false,
    guestOnly: true,
    nav: null
  },
  '/forgot-password': {
    key: 'forgot-password',
    title: 'Lupa Password — FINZZ Store',
    description: 'Minta tautan reset password untuk akun FINZZ Store Anda.',
    requiresAuth: false,
    nav: null
  },
  '/reset-password': {
    key: 'reset-password',
    title: 'Reset Password — FINZZ Store',
    description: 'Atur password baru untuk akun FINZZ Store Anda.',
    requiresAuth: false,
    nav: null
  },
  '/verify-email': {
    key: 'verify-email',
    title: 'Verifikasi Email — FINZZ Store',
    description: 'Verifikasi alamat email akun FINZZ Store Anda.',
    requiresAuth: false,
    nav: null
  },
  '/dashboard': {
    key: 'dashboard',
    title: 'Dashboard — FINZZ Store',
    description: 'Ringkasan saldo, order aktif, dan OTP terbaru Anda.',
    requiresAuth: true,
    nav: 'dashboard'
  },
  '/services': {
    key: 'services',
    title: 'Katalog Layanan — FINZZ Store',
    description: 'Jelajahi layanan dan negara yang tersedia. Masuk hanya diperlukan saat membeli nomor.',
    // Browsing is public on purpose: a visitor must be able to compare prices
    // before creating an account. Buying is gated server-side, not by hiding
    // this page.
    requiresAuth: false,
    nav: 'services'
  },
  '/orders': {
    key: 'orders',
    title: 'Order & OTP — FINZZ Store',
    description: 'Pantau order aktif dan lihat kode OTP Anda.',
    requiresAuth: true,
    nav: 'orders'
  },
  '/wallet': {
    key: 'wallet',
    title: 'Saldo & Deposit — FINZZ Store',
    description: 'Kelola saldo, riwayat transaksi, dan ajukan deposit.',
    requiresAuth: true,
    nav: 'wallet'
  },
  '/profile': {
    key: 'profile',
    title: 'Profil & Keamanan — FINZZ Store',
    description: 'Kelola profil, password, dan sesi akun FINZZ Store Anda.',
    requiresAuth: true,
    nav: 'profile'
  },
  '/admin': {
    key: 'admin',
    title: 'Admin — FINZZ Store',
    description: 'Panel administrasi FINZZ Store.',
    requiresAuth: true,
    requiresAdmin: true,
    nav: 'admin'
  },
  '/notifications': {
    key: 'notifications',
    title: 'Notifikasi — FINZZ Store',
    description: 'Kabar dari peristiwa nyata di akun Anda: order, OTP, dan deposit.',
    requiresAuth: true,
    nav: 'notifications'
  },
  '/status': {
    key: 'status',
    title: 'Status Layanan — FINZZ Store',
    description: 'Status nyata database, supplier, dan pembayaran FINZZ Store.',
    requiresAuth: false,
    nav: null
  },
  '/terms': {
    key: 'terms',
    title: 'Ketentuan Layanan — FINZZ Store',
    description: 'Ketentuan layanan FINZZ Store.',
    requiresAuth: false,
    nav: null
  },
  '/privacy': {
    key: 'privacy',
    title: 'Kebijakan Privasi — FINZZ Store',
    description: 'Kebijakan privasi dan penanganan data FINZZ Store.',
    requiresAuth: false,
    nav: null
  }
});

export function pageFor(pathname) {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PAGES[clean] || null;
}
