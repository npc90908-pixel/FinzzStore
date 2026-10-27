// ============================================================================
// ORDERS — list, live OTP, timeline, cancellation.
// The browser polls the API every 4s while visible; the supplier is only
// contacted by the server (background poller) or by an explicit, throttled sync.
// ============================================================================
import { el, Button, Badge, Card, Table, Skeleton, EmptyState, Modal, Alert, toast, CopyField, PageHeader } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { createOrderPoller } from '../poller.js';
import { ApiError } from '../api.js';
import { formatRupiah, formatDate, statusMeta, timeAgo, countdown } from '../store.js';

const FILTERS = [
  { id: '', label: 'Semua' },
  { id: 'waiting', label: 'Menunggu OTP' },
  { id: 'received', label: 'OTP diterima' },
  { id: 'completed', label: 'Selesai' },
  { id: 'cancelled', label: 'Dibatalkan' },
  { id: 'expired', label: 'Kedaluwarsa' },
  { id: 'needs_review', label: 'Perlu review' }
];

export default async function ordersPage(ctx) {
  const { api, store, navigate, layout, query } = ctx;
  const selectedId = query.get('id');
  const state = { filter: '', orders: [], detail: null, page: 1 };

  const listArea = el('div', {}, new Skeleton({ card: true }));
  const detailArea = el('aside', { class: 'stack' }, new Skeleton({ card: true }));
  const filterRow = el('div', { class: 'pill-row' });
  const liveBadge = Badge({ tone: 'brand', dot: true, pulse: true, children: 'Live 4s' });

  const content = el('div', { class: 'page animate-rise' },
    PageHeader({
      eyebrow: 'Pesanan',
      iconName: 'receipt',
      title: 'Order & OTP',
      subtitle: 'Kode verifikasi hanya dapat dilihat oleh pemilik order. Halaman diperbarui otomatis saat order masih aktif.',
      actions: el('div', { class: 'row' },
        liveBadge,
        Button({ variant: 'primary', iconName: 'plus', children: 'Order baru', onClick: () => navigate('/services') })
      )
    }),
    filterRow,
    el('div', { class: 'grid grid--sidebar' }, listArea, detailArea)
  );

  const { shell } = appShell(layout, 'orders', content);

  const renderFilters = () => {
    filterRow.replaceChildren(
      ...FILTERS.map((f) =>
        el('button', {
          class: `tabs__btn${state.filter === f.id ? '' : ''}`,
          style: {
            border: '1px solid var(--border)', background: state.filter === f.id ? 'var(--brand-soft)' : 'transparent',
            color: state.filter === f.id ? 'var(--text)' : 'var(--text-muted)', borderRadius: '999px', padding: '6px 14px'
          },
          attrs: { type: 'button', 'aria-pressed': String(state.filter === f.id) },
          text: f.label,
          onClick: () => { state.filter = f.id; state.page = 1; renderFilters(); loadList(); }
        })
      )
    );
  };

  const renderList = () => {
    if (state.orders.length === 0) {
      listArea.replaceChildren(
        EmptyState({
          title: state.filter ? 'Tidak ada order pada filter ini' : 'Belum ada order',
          description: 'Beli nomor virtual pertama Anda untuk melihat OTP di halaman ini.',
          iconName: 'receipt',
          action: Button({ variant: 'primary', size: 'sm', iconName: 'plus', children: 'Beli nomor', onClick: () => navigate('/services') })
        })
      );
      return;
    }

    listArea.replaceChildren(
      Table({
        columns: [
          {
            label: 'Layanan',
            render: (o) => el('div', {}, el('div', { text: `${o.app.name} · ${o.country.name}` }),
              el('div', { class: 'text-xs text-dim mono', text: o.number || o.id.slice(0, 8) }))
          },
          { label: 'Status', render: (o) => Badge({ tone: statusMeta(o.status).tone, dot: true, children: statusMeta(o.status).label }) },
          { label: 'Total', align: 'right', render: (o) => formatRupiah(o.pricing.total) },
          { label: 'Dibuat', align: 'right', render: (o) => el('span', { class: 'text-xs text-dim', text: timeAgo(o.createdAt) }) },
          {
            label: '',
            align: 'right',
            render: (o) => Button({ size: 'sm', variant: 'ghost', iconName: 'chevronRight', title: 'Lihat detail', onClick: () => select(o.id) })
          }
        ],
        rows: state.orders,
        compact: true
      })
    );
  };

  const renderDetail = (order, events = []) => {
    if (!order) {
      detailArea.replaceChildren(
        Card({ title: 'Detail order' }, EmptyState({ title: 'Belum dipilih', description: 'Pilih order di kiri untuk melihat nomor, OTP, dan riwayat status.', iconName: 'receipt' }))
      );
      return;
    }

    const meta = statusMeta(order.status);
    const otpBlock = order.otp
      ? el('div', { class: 'stack', style: { gap: '10px' } },
          el('div', { class: 'otp-display' }, el('span', { text: order.otp.code })),
          order.otp.message ? el('p', { class: 'text-xs text-dim', text: order.otp.message }) : null,
          CopyField({ label: 'Kode OTP', value: order.otp.code })
        )
      : el('div', { class: 'otp-waiting' }, icon('clock', { size: 16 }),
          el('span', { text: order.status === 'pending' ? 'Menunggu konfirmasi supplier…' : order.status === 'waiting' ? 'Menunggu OTP masuk…' : 'Tidak ada OTP untuk order ini.' }));

    const cancelButton = order.canCancel && !order.otp && ['waiting', 'received'].includes(order.status)
      ? Button({
          variant: 'danger', size: 'sm', iconName: 'x', children: 'Batalkan order',
          onClick: () => confirmCancel(order)
        })
      : null;

    const expiryText = order.expiresAt && ['waiting', 'received'].includes(order.status)
      ? `Batas waktu ${countdown(order.expiresAt)}`
      : null;

    detailArea.replaceChildren(
      el('div', { class: 'order-card order-card--active' },
        el('div', { class: 'row row--between' },
          el('div', {},
            el('div', { class: 'section-label', text: 'Order' }),
            el('div', { class: 'mono text-sm', text: order.id.slice(0, 8) })
          ),
          Badge({ tone: meta.tone, dot: true, pulse: order.status === 'waiting', children: meta.label })
        ),
        otpBlock,
        el('dl', { class: 'kv' },
          el('dt', { text: 'Nomor' }), el('dd', { class: 'mono', text: order.number || '—' }),
          el('dt', { text: 'Layanan' }), el('dd', { text: `${order.app.name} · ${order.country.name}` }),
          el('dt', { text: 'Total' }), el('dd', { class: 'mono', text: formatRupiah(order.pricing.total) }),
          el('dt', { text: 'Dibuat' }), el('dd', { text: formatDate(order.createdAt) }),
          order.refundedAt ? el('dt', { text: 'Refund' }) : null,
          order.refundedAt ? el('dd', { text: `Saldo dikembalikan ${formatDate(order.refundedAt)}` }) : null
        ),
        expiryText ? el('div', { class: 'row row--between' }, el('span', { class: 'text-xs text-dim', text: expiryText }),
          Button({ variant: 'ghost', size: 'sm', iconName: 'refresh', children: 'Perbarui', onClick: () => forceSync(order.id) })) : null,
        cancelButton ? el('div', { class: 'row' }, cancelButton) : null,
        events.length
          ? el('div', {},
              el('div', { class: 'section-label', style: { marginBottom: '8px' }, text: 'Riwayat status' }),
              el('ul', { class: 'timeline' },
                events.slice(0, 8).map((e) =>
                  el('li', { class: `timeline__item${e.to === 'completed' || e.to === 'received' ? ' timeline__item--done' : ''}` },
                    el('div', { text: e.message || e.type }),
                    el('div', { class: 'timeline__time', text: `${formatDate(e.at)} · ${e.source || 'sistem'}` })
                  )
                )
              )
            )
          : null
      )
    );
  };

  const loadEvents = async (orderId) => {
    try {
      const { events } = await api.get(`/api/orders/${orderId}/events`);
      return events || [];
    } catch {
      return [];
    }
  };

  const select = async (orderId) => {
    try {
      const [{ order }, events] = await Promise.all([
        api.get(`/api/orders/${orderId}`),
        loadEvents(orderId)
      ]);
      state.detail = order;
      renderDetail(order, events);
      window.history.replaceState({}, '', `/orders?id=${encodeURIComponent(orderId)}`);
    } catch (err) {
      toast({ type: 'error', title: 'Gagal memuat order', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
    }
  };

  const forceSync = async (orderId) => {
    try {
      const { order } = await api.post(`/api/orders/${orderId}/sync`);
      state.detail = order;
      renderDetail(order, await loadEvents(orderId));
    } catch (err) {
      toast({ type: 'warning', title: 'Sinkronisasi tertunda', message: err instanceof ApiError ? err.message : 'Coba lagi beberapa saat.' });
    }
  };

  const confirmCancel = (order) => {
    const reason = el('div', { class: 'stack' });
    const button = Button({
      variant: 'danger', children: 'Ya, batalkan order',
      onClick: async () => {
        if (button.dataset.loading === '1') return;
        button.dataset.loading = '1';
        button.disabled = true;
        button.replaceChildren(el('span', { class: 'btn__spinner' }), el('span', { text: 'Membatalkan…' }));
        try {
          const result = await api.post(`/api/orders/${order.id}/cancel`);
          modal.close();
          if (result.refunded) {
            toast({ type: 'success', title: 'Order dibatalkan', message: 'Saldo dikembalikan penuh ke dompet Anda.' });
            window.dispatchEvent(new Event('finzz:refresh-balance'));
          } else if (result.pending) {
            toast({ type: 'info', title: 'Sedang diproses', message: 'Permintaan pembatalan sedang dikonfirmasi ke supplier.' });
          } else {
            toast({ type: 'success', title: 'Order dibatalkan' });
          }
          await loadList();
          select(order.id);
        } catch (err) {
          reason.replaceChildren(Alert({ tone: 'danger', title: 'Tidak dapat dibatalkan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          button.dataset.loading = '0';
          button.disabled = false;
          button.replaceChildren(el('span', { text: 'Coba lagi' }));
        }
      }
    });
    const modal = Modal({
      title: 'Batalkan order?',
      description: 'Pembatalan hanya berhasil jika supplier mengizinkan dan belum ada OTP yang diterima.',
      body: el('div', { class: 'stack' },
        Alert({ tone: 'warning', title: 'Sebelum melanjutkan', children: 'Jika pembatalan disetujui, saldo Anda dikembalikan penuh dan dicatat pada ledger.' }),
        reason
      ),
      actions: [Button({ variant: 'ghost', children: 'Tidak', onClick: () => modal.close() }), button]
    });
  };

  const loadList = async () => {
    try {
      const data = await api.get(`/api/orders?page=${state.page}${state.filter ? `&status=${state.filter}` : ''}`);
      state.orders = data.orders;
      renderList();
      const target = selectedId && !state.detail ? data.orders.find((o) => o.id === selectedId) : null;
      if (target) await select(target.id);
      else if (!state.detail && data.orders[0]) await select(data.orders[0].id);
      else renderDetail(state.detail, state.detail ? await loadEvents(state.detail.id) : []);
    } catch (err) {
      listArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat order', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const poller = createOrderPoller({
    api,
    onOrders: (active) => {
      if (!active.length) return;
      // keep the visible detail in sync with the poller without extra requests
      const updated = state.detail && active.find((o) => o.id === state.detail.id);
      if (updated) {
        state.detail = updated;
        loadEvents(updated.id).then((events) => renderDetail(updated, events));
      }
      loadList();
    },
    onError: () => {}
  });

  renderFilters();
  await loadList();

  return {
    node: shell,
    title: 'Order & OTP — FINZZ Store',
    cleanup() {
      poller.stop();
    }
  };
}
