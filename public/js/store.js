// ============================================================================
// STORE — tiny reactive container (no framework).
// ============================================================================

export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  const notify = (changed) => {
    for (const listener of listeners) {
      try {
        listener(state, changed);
      } catch (err) {
        console.error('store listener failed', err);
      }
    }
  };

  return {
    get state() {
      return state;
    },
    get(key) {
      return state[key];
    },
    set(patch) {
      const changed = Object.keys(patch).filter((key) => state[key] !== patch[key]);
      if (changed.length === 0) return state;
      state = { ...state, ...patch };
      notify(changed);
      return state;
    },
    update(key, updater) {
      return this.set({ [key]: updater(state[key]) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

// ---------------------------------------------------------------------------
// formatting helpers shared by pages
// ---------------------------------------------------------------------------
const rupiah = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
const plain = new Intl.NumberFormat('id-ID');

export const formatRupiah = (value) => rupiah.format(Number(value) || 0);
export const formatNumber = (value) => plain.format(Number(value) || 0);

export function formatDate(value, { withTime = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const options = withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('id-ID', options).format(date);
}

export function timeAgo(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '—';
  const seconds = Math.round(diff / 1000);
  if (seconds < 45) return 'baru saja';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.round(hours / 24);
  return `${days} hari lalu`;
}

export function countdown(target) {
  if (!target) return null;
  const diff = new Date(target).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return '00:00';
  const total = Math.floor(diff / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export const STATUS_META = {
  pending: { label: 'Mengonfirmasi supplier', tone: 'info' },
  waiting: { label: 'Menunggu OTP', tone: 'brand' },
  received: { label: 'OTP diterima', tone: 'success' },
  completed: { label: 'Selesai', tone: 'success' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
  expired: { label: 'Kedaluwarsa', tone: 'warning' },
  failed: { label: 'Gagal', tone: 'danger' },
  needs_review: { label: 'Perlu peninjauan', tone: 'warning' }
};

export const DEPOSIT_STATUS_META = {
  pending: { label: 'Menunggu review', tone: 'warning' },
  approved: { label: 'Disetujui', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' }
};

export const statusMeta = (status) => STATUS_META[status] || { label: status || 'Tidak diketahui', tone: 'neutral' };
export const depositStatusMeta = (status, method = null) => {
  if (status === 'pending' && method === 'gateway') return { label: 'Menunggu pembayaran', tone: 'info' };
  return DEPOSIT_STATUS_META[status] || { label: status || 'Tidak diketahui', tone: 'neutral' };
};
