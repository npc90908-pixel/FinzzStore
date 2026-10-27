// ============================================================================
// DASHBOARD — balance, active orders with live OTP, recent activity.
// ============================================================================
import { el, Button, Badge, Card, StatCard, Table, Skeleton, EmptyState, toast, PageHeader } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { createOrderPoller } from '../poller.js';
import { formatRupiah, formatDate, formatNumber, statusMeta, timeAgo } from '../store.js';

export default async function dashboard(ctx) {
  const { api, store, navigate, layout } = ctx;
  const user = store.get('user');

  const statsRow = el('div', { class: 'grid grid--4' },
    el('div', { class: 'skeleton skeleton-card' }),
    el('div', { class: 'skeleton skeleton-card' }),
    el('div', { class: 'skeleton skeleton-card' }),
    el('div', { class: 'skeleton skeleton-card' })
  );

  const activeSection = el('div', {}, el('div', { class: 'skeleton skeleton-block' }));
  const recentSection = el('div', {}, el('div', { class: 'skeleton skeleton-block' }));

  const content = el('div', { class: 'page animate-rise' },
    PageHeader({
      eyebrow: 'Dashboard',
      iconName: 'home',
      title: `Halo${user?.username ? `, ${user.username}` : ''}`,
      subtitle: 'Ringkasan saldo, order aktif, dan kode OTP terbaru Anda.',
      actions: el('div', { class: 'row row--wrap' },
        Button({ variant: 'outline', iconName: 'wallet', children: 'Isi saldo', onClick: () => navigate('/wallet') }),
        Button({ variant: 'primary', iconName: 'plus', children: 'Beli nokos', onClick: () => navigate('/services') })
      )
    }),
    statsRow,
    el('section', { class: 'card' },
      el('header', { class: 'card__head' },
        el('div', {}, el('h2', { class: 'card__title', text: 'Order aktif' }),
          el('p', { class: 'card__subtitle', text: 'Diperbarui otomatis setiap 4 detik selama halaman terbuka.' })),
        Badge({ tone: 'brand', dot: true, pulse: true, children: 'Live' })
      ),
      el('div', { class: 'card__body' }, activeSection)
    ),
    el('section', { class: 'card' },
      el('header', { class: 'card__head' },
        el('div', {}, el('h2', { class: 'card__title', text: 'Order terakhir' })),
        el('a', { class: 'text-sm', attrs: { href: '/orders' }, text: 'Lihat semua', onClick: (e) => { e.preventDefault(); navigate('/orders'); } })
      ),
      el('div', { class: 'card__body', style: { padding: '0' } }, recentSection)
    )
  );

  const { shell } = appShell(layout, 'dashboard', content);
  let poller = null;

  const renderActive = (orders) => {
    if (!orders.length) {
      activeSection.replaceChildren(
        EmptyState({
          title: 'Tidak ada order aktif',
          description: 'Order baru akan muncul di sini beserta kode OTP-nya.',
          iconName: 'inbox',
          action: Button({ variant: 'primary', size: 'sm', iconName: 'plus', children: 'Beli nomor', onClick: () => navigate('/services') })
        })
      );
      return;
    }

    activeSection.replaceChildren(
      el('div', { class: 'stack' },
        orders.map((order) => {
          const meta = statusMeta(order.status);
          const otpCard = order.otp
            ? el('div', { class: 'otp-display', attrs: { 'aria-label': 'Kode OTP' } }, el('span', { text: order.otp.code }))
            : el('div', { class: 'otp-waiting' }, icon('clock', { size: 16 }),
                el('span', { text: order.status === 'pending' ? 'Menunggu konfirmasi supplier…' : 'Menunggu OTP masuk…' }));
          return el('div', { class: 'order-card order-card--active' },
            el('div', { class: 'row row--between row--wrap' },
              el('div', { class: 'row' },
                el('span', { class: 'service-card__logo' }, icon('smartphone', { size: 17 })),
                el('div', {},
                  el('div', { class: 'service-card__name', text: `${order.app.name} · ${order.country.name}` }),
                  el('div', { class: 'service-card__meta' }, el('span', { class: 'mono', text: order.number || 'Nomor disiapkan…' }))
                )
              ),
              Badge({ tone: meta.tone, dot: true, pulse: order.status === 'waiting', children: meta.label })
            ),
            otpCard,
            el('div', { class: 'row row--between row--wrap' },
              el('span', { class: 'text-xs text-dim', text: `Dibuat ${timeAgo(order.createdAt)} · ${formatRupiah(order.pricing.total)}` }),
              el('div', { class: 'row' },
                order.otp ? Button({ variant: 'outline', size: 'sm', iconName: 'copy', children: 'Salin OTP', onClick: async () => {
                  try { await navigator.clipboard.writeText(order.otp.code); toast({ type: 'success', title: 'OTP disalin' }); }
                  catch { toast({ type: 'error', title: 'Gagal menyalin', message: 'Salin manual dari kotak OTP.' }); }
                } }) : null,
                Button({ variant: 'ghost', size: 'sm', iconName: 'arrowRight', children: 'Detail', onClick: () => navigate(`/orders?id=${order.id}`) })
              )
            )
          );
        })
      )
    );
  };

  const load = async () => {
    try {
      const [wallet, recent] = await Promise.all([
        api.get('/api/wallet?page=1'),
        api.get('/api/orders?page=1&per_page=5')
      ]);
      store.set({ balance: wallet.balance });

      const completed = recent.orders.filter((o) => o.status === 'completed').length;
      const refunded = recent.orders.filter((o) => o.refundedAt).length;
      statsRow.replaceChildren(
        StatCard({ label: 'Saldo tersedia', value: formatRupiah(wallet.balance), hint: `Diperbarui ${timeAgo(wallet.updatedAt)}`, iconName: 'wallet', tone: 'brand' }),
        StatCard({ label: 'Order aktif', value: formatNumber(wallet.activeOrders.length), hint: 'Pending, menunggu OTP, atau diterima', iconName: 'clock', tone: 'info' }),
        StatCard({ label: 'Selesai', value: formatNumber(completed), hint: 'Dari 5 order terakhir', iconName: 'check', tone: 'success' }),
        StatCard({ label: 'Refund', value: formatNumber(refunded), hint: 'Saldo kembali ke dompet Anda', iconName: 'refresh', tone: 'warning' })
      );

      recentSection.replaceChildren(
        Table({
          compact: true,
          columns: [
            { label: 'Layanan', render: (o) => el('div', {}, el('div', { text: `${o.app.name}` }), el('div', { class: 'text-xs text-dim', text: o.country.name })) },
            { label: 'Status', render: (o) => Badge({ tone: statusMeta(o.status).tone, children: statusMeta(o.status).label }) },
            { label: 'Total', align: 'right', render: (o) => formatRupiah(o.pricing.total) },
            { label: 'Waktu', align: 'right', render: (o) => el('span', { class: 'text-xs text-dim', text: formatDate(o.createdAt, { withTime: false }) }) }
          ],
          rows: recent.orders,
          empty: EmptyState({ title: 'Belum ada order', description: 'Mulai dengan membeli nomor pertama Anda.', iconName: 'receipt' })
        })
      );
    } catch (err) {
      toast({ type: 'error', title: 'Gagal memuat dashboard', message: err?.message || 'Coba muat ulang halaman.' });
    }
  };

  poller = createOrderPoller({ api, onOrders: renderActive, onError: () => {} });
  await load();
  renderActive((await api.get('/api/orders/active').catch(() => ({ orders: [] }))).orders);

  return {
    node: shell,
    title: 'Dashboard — FINZZ Store',
    cleanup() {
      poller?.stop();
    }
  };
}
