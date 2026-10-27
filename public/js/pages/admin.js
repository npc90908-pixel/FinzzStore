// ============================================================================
// ADMIN PANEL — every action is re-authorised on the server; the UI only
// reflects what the backend allows. All mutations are audited.
// ============================================================================
import { el, Button, Badge, Card, StatCard, Table, Tabs, Input, Select, Textarea, Checkbox, Modal, Alert, toast, Skeleton, EmptyState, runWithLoading, KeyValue } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError, newIdempotencyKey } from '../api.js';
import { formatRupiah, formatDate, formatNumber, statusMeta, depositStatusMeta, timeAgo } from '../store.js';

const TABS = [
  { id: 'overview', label: 'Ringkasan' },
  { id: 'deposits', label: 'Deposit' },
  { id: 'orders', label: 'Order' },
  { id: 'users', label: 'Pengguna' },
  { id: 'services', label: 'Layanan' },
  { id: 'audit', label: 'Audit log' },
  { id: 'settings', label: 'Pengaturan' }
];

export default async function adminPage(ctx) {
  const { api, layout } = ctx;
  const state = { tab: 'overview', usersPage: 1, ordersPage: 1, depositsPage: 1, depositsStatus: 'pending', auditPage: 1, servicesSearch: '', usersSearch: '' };

  const body = el('div', { class: 'stack' }, new Skeleton({ lines: 8 }));
  const tabBar = Tabs({ items: TABS, active: state.tab, onChange: (id) => { state.tab = id; renderTabs(); renderBody(); } });

  const content = el('div', { class: 'page' },
    el('div', { class: 'page__head' },
      el('div', {},
        el('h1', { class: 'page__title', text: 'Panel admin' }),
        el('p', { class: 'page__subtitle', text: 'Ringkasan transaksi aktual, persetujuan deposit, pengelolaan layanan, dan audit log.' })
      ),
      Badge({ tone: 'brand', dot: true, children: 'Admin' })
    ),
    el('div', { class: 'scroll-x' }, tabBar),
    body
  );

  const { shell } = appShell(layout, 'admin', content);

  const renderTabs = () => {
    const fresh = Tabs({ items: TABS, active: state.tab, onChange: (id) => { state.tab = id; renderTabs(); renderBody(); } });
    content.querySelector('.scroll-x').replaceChildren(fresh);
  };

  // ------------------------------------------------------------------ overview
  const renderOverview = async () => {
    body.replaceChildren(new Skeleton({ card: true }), new Skeleton({ card: true }));
    try {
      const data = await api.get('/api/admin/dashboard');
      const supplier = data.supplier || {};
      const catalog = data.catalog || {};
      body.replaceChildren(
        el('div', { class: 'grid grid--4' },
          StatCard({ label: 'Pengguna', value: formatNumber(data.users.total), hint: `${data.users.active} aktif · ${data.users.admins} admin`, iconName: 'users', tone: 'brand' }),
          StatCard({ label: 'Order aktif', value: formatNumber(data.orders.active), hint: `${data.orders.total} total order`, iconName: 'clock', tone: 'info' }),
          StatCard({ label: 'Pendapatan selesai', value: formatRupiah(data.finance.gross_revenue), hint: `Biaya supplier ${formatRupiah(data.finance.supplier_cost)}`, iconName: 'trendingUp', tone: 'success' }),
          StatCard({ label: 'Laba bersih', value: formatRupiah(data.finance.net_profit), hint: 'Hanya dari order selesai', iconName: 'zap', tone: 'success' })
        ),
        el('div', { class: 'grid grid--3' },
          StatCard({ label: 'Refund tercatat', value: formatRupiah(data.finance.refunded_total), hint: `${data.orders.refunded} order direfund`, iconName: 'refresh', tone: 'warning' }),
          StatCard({ label: 'Deposit menunggu', value: formatNumber(data.finance.deposits_pending_count), hint: formatRupiah(data.finance.deposits_pending_amount), iconName: 'inbox', tone: 'warning' }),
          StatCard({ label: 'Liabilitas saldo', value: formatRupiah(data.finance.wallet_liability), hint: 'Total saldo pengguna', iconName: 'wallet', tone: 'neutral' })
        ),
        el('div', { class: 'grid grid--3' },
          Card({ title: 'Supplier' },
            KeyValue({
              items: [
                { label: 'Mode', value: Badge({ tone: supplier.mode === 'live' ? 'success' : supplier.mock ? 'warning' : 'neutral', dot: true, children: supplier.mode || 'unknown' }) },
                { label: 'Terkonfigurasi', value: supplier.configured ? 'Ya' : 'Tidak' },
                { label: 'Permintaan', value: formatNumber(supplier.requests || 0) },
                { label: 'Gagal', value: formatNumber(supplier.failures || 0) },
                { label: 'Rate limit', value: supplier.rateLimit?.remaining != null ? `${supplier.rateLimit.remaining}/${supplier.rateLimit.limit}` : '—' },
                { label: 'Error terakhir', value: supplier.lastError?.code || '—' }
              ]
            })
          ),
          Card({ title: 'Katalog' },
            KeyValue({
              items: [
                { label: 'Status job', value: catalog.lastResult?.status || 'belum berjalan' },
                { label: 'Layanan diupsert', value: formatNumber(catalog.lastResult?.upserted || 0) },
                { label: 'Dinyatakan nonaktif', value: formatNumber(catalog.lastResult?.deactivated || 0) },
                { label: 'Terakhir jalan', value: catalog.lastRunAt ? timeAgo(catalog.lastRunAt) : '—' }
              ]
            })
          ),
          Card({ title: 'Job & payment' },
            KeyValue({
              items: [
                { label: 'Poller', value: data.jobs?.poller ? `${data.jobs.poller.ticks} tick · ${data.jobs.poller.processed} diproses` : 'nonaktif' },
                { label: 'Rekonsiliasi', value: data.jobs?.reconciliation ? `${data.jobs.reconciliation.runs} run · ${data.jobs.reconciliation.orphaned} orphan` : 'nonaktif' },
                { label: 'Payment gateway', value: Badge({ tone: 'neutral', children: data.payment?.enabled ? 'aktif' : 'nonaktif' }) }
              ]
            })
          )
        ),
        Card({ title: 'Order terbaru', flush: true },
          Table({
            compact: true,
            columns: [
              { label: 'Waktu', render: (o) => el('span', { class: 'text-xs text-dim', text: formatDate(o.created_at) }) },
              { label: 'Pengguna', render: (o) => o.email || '—' },
              { label: 'Status', render: (o) => Badge({ tone: statusMeta(o.status).tone, children: statusMeta(o.status).label }) },
              { label: 'Total', align: 'right', render: (o) => formatRupiah(o.total_price) }
            ],
            rows: data.recent_orders || [],
            empty: EmptyState({ title: 'Belum ada order' })
          })
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat ringkasan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  // ------------------------------------------------------------------ deposits
  const renderDeposits = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const data = await api.get(`/api/admin/deposits?status=${state.depositsStatus}&page=${state.depositsPage}`);
      const filter = el('div', { class: 'pill-row' },
        ['pending', 'approved', 'rejected', 'all'].map((status) =>
          el('button', {
            class: 'tabs__btn',
            style: {
              border: '1px solid var(--border)', borderRadius: '999px', padding: '6px 14px',
              background: state.depositsStatus === status ? 'var(--brand-soft)' : 'transparent',
              color: state.depositsStatus === status ? 'var(--text)' : 'var(--text-muted)'
            },
            attrs: { type: 'button' },
            text: status === 'all' ? 'Semua' : depositStatusMeta(status).label,
            onClick: () => { state.depositsStatus = status; state.depositsPage = 1; renderDeposits(); }
          })
        )
      );

      const rows = data.deposits.map((d) => ({
        ...d,
        actions: el('div', { class: 'row', style: { gap: '6px' } },
          d.hasProof
            ? Button({ size: 'sm', variant: 'ghost', iconName: 'eye', title: 'Lihat bukti', onClick: () => window.open(`/api/admin/deposits/${d.id}/proof`, '_blank', 'noopener') })
            : null,
          d.status === 'pending'
            ? Button({ size: 'sm', variant: 'success', children: 'Setujui', onClick: () => approveDeposit(d) })
            : null,
          d.status === 'pending'
            ? Button({ size: 'sm', variant: 'danger', children: 'Tolak', onClick: () => rejectDeposit(d) })
            : null
        )
      }));

      body.replaceChildren(
        Card({
          title: 'Deposit manual',
          subtitle: 'Bukti transfer hanya dapat dibuka oleh admin',
          actions: filter
        },
          Table({
            columns: [
              { label: 'Diajukan', render: (d) => el('div', {}, el('div', { class: 'text-xs', text: formatDate(d.createdAt) }), el('div', { class: 'text-xs text-dim', text: d.user?.email || '—' })) },
              { label: 'Nominal', align: 'right', render: (d) => el('span', { class: 'mono', text: formatRupiah(d.amount) }) },
              { label: 'Status', render: (d) => Badge({ tone: depositStatusMeta(d.status).tone, children: depositStatusMeta(d.status).label }) },
              { label: 'Catatan', render: (d) => el('span', { class: 'text-xs text-dim', text: d.userNote || '—' }) },
              { label: 'Aksi', align: 'right', render: (d) => d.actions }
            ],
            rows,
            empty: EmptyState({ title: 'Tidak ada deposit', description: 'Deposit baru akan muncul di sini untuk diverifikasi.', iconName: 'inbox' })
          }),
          el('div', {}, data.pagination.pages > 1 ? Button({ size: 'sm', variant: 'outline', children: `Halaman ${data.pagination.page} / ${data.pagination.pages}`, onClick: () => { state.depositsPage = state.depositsPage >= data.pagination.pages ? 1 : state.depositsPage + 1; renderDeposits(); } }) : null)
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat deposit', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const approveDeposit = (deposit) => {
    const amountInput = Input({ label: 'Nominal disetujui', name: 'approved_amount', type: 'number', value: String(deposit.amount), hint: `Diajukan: ${formatRupiah(deposit.amount)}` });
    const noteInput = Textarea({ label: 'Catatan (opsional)', name: 'note', rows: 2, maxlength: 300 });
    const errorArea = el('div');
    const button = Button({
      variant: 'success', children: 'Setujui & kreditkan',
      onClick: async () => {
        await runWithLoading(button, async () => {
          try {
            await api.post(`/api/admin/deposits/${deposit.id}/approve`, {
              approved_amount: Number(form.elements.approved_amount.value) || undefined,
              note: form.elements.note.value.trim() || undefined
            });
            modal.close();
            toast({ type: 'success', title: 'Deposit disetujui', message: 'Saldo pengguna telah dikreditkan.' });
            renderDeposits();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal menyetujui', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Memproses…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, amountInput, noteInput, errorArea);
    const modal = Modal({
      title: 'Setujui deposit',
      description: `${deposit.user?.email || 'Pengguna'} · ${formatRupiah(deposit.amount)}`,
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  const rejectDeposit = (deposit) => {
    const reason = Textarea({ label: 'Alasan penolakan', name: 'reason', rows: 3, maxlength: 300 });
    const errorArea = el('div');
    const button = Button({
      variant: 'danger', children: 'Tolak deposit',
      onClick: async () => {
        const form = button.closest('.modal')?.querySelector('form');
        const value = form.elements.reason.value.trim();
        if (value.length < 5) {
          errorArea.replaceChildren(Alert({ tone: 'warning', title: 'Alasan terlalu pendek', children: 'Minimal 5 karakter agar pengguna tahu penyebabnya.' }));
          return;
        }
        await runWithLoading(button, async () => {
          try {
            await api.post(`/api/admin/deposits/${deposit.id}/reject`, { reason: value });
            modal.close();
            toast({ type: 'success', title: 'Deposit ditolak' });
            renderDeposits();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal menolak', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Memproses…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, reason, errorArea);
    const modal = Modal({
      title: 'Tolak deposit',
      description: 'Penolakan dicatat pada audit log dan terlihat oleh pengguna.',
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  // -------------------------------------------------------------------- orders
  const renderOrders = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const data = await api.get(`/api/admin/orders?page=${state.ordersPage}`);
      body.replaceChildren(
        Card({ title: 'Order', subtitle: 'Sinkronisasi supplier dan refund manual tercatat pada audit log', flush: true },
          Table({
            compact: true,
            columns: [
              { label: 'Order', render: (o) => el('div', {}, el('div', { class: 'mono text-xs', text: o.id.slice(0, 8) }), el('div', { class: 'text-xs text-dim', text: o.user?.email || '—' })) },
              { label: 'Layanan', render: (o) => `${o.app.name} · ${o.country.name}` },
              { label: 'Status', render: (o) => Badge({ tone: statusMeta(o.status).tone, children: statusMeta(o.status).label }) },
              { label: 'Total', align: 'right', render: (o) => formatRupiah(o.pricing.total) },
              { label: 'Dibuat', align: 'right', render: (o) => el('span', { class: 'text-xs text-dim', text: timeAgo(o.createdAt) }) },
              {
                label: 'Aksi', align: 'right', render: (o) => el('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
                  Button({ size: 'sm', variant: 'ghost', iconName: 'eye', title: 'Detail', onClick: () => openOrderDetail(o.id) }),
                  Button({ size: 'sm', variant: 'ghost', iconName: 'refresh', title: 'Sinkronkan', onClick: () => syncOrder(o.id) }),
                  o.refundedAt ? null : Button({ size: 'sm', variant: 'ghost', iconName: 'wallet', title: 'Refund manual', onClick: () => refundOrder(o) })
                )
              }
            ],
            rows: data.orders,
            empty: EmptyState({ title: 'Belum ada order' })
          }),
          el('div', {}, data.pagination.pages > 1 ? Button({ size: 'sm', variant: 'outline', children: `Halaman ${data.pagination.page} / ${data.pagination.pages}`, onClick: () => { state.ordersPage = state.ordersPage >= data.pagination.pages ? 1 : state.ordersPage + 1; renderOrders(); } }) : null)
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat order', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const openOrderDetail = async (orderId) => {
    try {
      const data = await api.get(`/api/admin/orders/${orderId}`);
      const order = data.order;
      const modal = Modal({
        title: `Order ${order.id.slice(0, 8)}`,
        description: data.user?.email || '',
        body: el('div', { class: 'stack' },
          KeyValue({
            items: [
              { label: 'Status', value: Badge({ tone: statusMeta(order.status).tone, children: statusMeta(order.status).label }) },
              { label: 'Nomor', value: order.number || '—' },
              { label: 'Layanan', value: `${order.app.name} · ${order.country.name}` },
              { label: 'Total', value: formatRupiah(order.pricing.total) },
              { label: 'Supplier order', value: order.supplier?.orderId || '—' },
              { label: 'OTP', value: order.otp ? el('span', { class: 'mono', text: order.otp.code }) : '—' },
              { label: 'Refund', value: order.refundedAt ? formatDate(order.refundedAt) : 'Belum' },
              { label: 'Sinkron terakhir', value: order.supplier?.lastSyncedAt ? formatDate(order.supplier.lastSyncedAt) : '—' }
            ]
          }),
          el('div', {},
            el('div', { class: 'section-label', style: { marginBottom: '8px' }, text: 'Riwayat' }),
            el('ul', { class: 'timeline' },
              (data.events || []).slice(0, 12).map((e) =>
                el('li', { class: 'timeline__item' },
                  el('div', { text: e.message || e.event_type }),
                  el('div', { class: 'timeline__time', text: `${formatDate(e.created_at)} · ${e.source}` })
                )
              )
            )
          )
        ),
        actions: [Button({ variant: 'ghost', children: 'Tutup', onClick: () => modal.close() })]
      });
    } catch (err) {
      toast({ type: 'error', title: 'Gagal memuat order', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
    }
  };

  const syncOrder = async (orderId) => {
    try {
      await api.post(`/api/admin/orders/${orderId}/sync`);
      toast({ type: 'success', title: 'Order disinkronkan' });
      renderOrders();
    } catch (err) {
      toast({ type: 'error', title: 'Sinkronisasi gagal', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
    }
  };

  const refundOrder = (order) => {
    const reason = Textarea({ label: 'Alasan refund', name: 'reason', rows: 3, maxlength: 300, hint: 'Minimal 5 karakter. Refund hanya dapat dilakukan sekali per order.' });
    const errorArea = el('div');
    const button = Button({
      variant: 'danger', children: 'Proses refund',
      onClick: async () => {
        const form = button.closest('.modal')?.querySelector('form');
        const value = form.elements.reason.value.trim();
        if (value.length < 5) {
          errorArea.replaceChildren(Alert({ tone: 'warning', title: 'Alasan wajib', children: 'Tulis alasan minimal 5 karakter.' }));
          return;
        }
        await runWithLoading(button, async () => {
          try {
            const result = await api.post(`/api/admin/orders/${order.id}/refund`, { reason: value });
            modal.close();
            toast({ type: 'success', title: result.refunded ? 'Refund dicatat' : 'Sudah pernah direfund' });
            renderOrders();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Refund gagal', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Memproses…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, reason, errorArea);
    const modal = Modal({
      title: 'Refund manual',
      description: `${formatRupiah(order.pricing.total)} untuk ${order.user?.email || 'pengguna'}`,
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  // --------------------------------------------------------------------- users
  const renderUsers = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const data = await api.get(`/api/admin/users?page=${state.usersPage}&search=${encodeURIComponent(state.usersSearch)}`);
      const searchInput = Input({ label: '', name: 'search', placeholder: 'Cari email atau username…', value: state.usersSearch });
      const searchButton = Button({ variant: 'outline', iconName: 'search', children: 'Cari', onClick: () => { state.usersSearch = searchInput.querySelector('input').value.trim(); state.usersPage = 1; renderUsers(); } });

      body.replaceChildren(
        Card({ title: 'Pengguna', subtitle: 'Role dan status hanya dapat diubah admin melalui endpoint teraudit', actions: el('div', { class: 'row' }, searchInput, searchButton) },
          Table({
            compact: true,
            columns: [
              { label: 'Email', render: (u) => el('div', {}, el('div', { text: u.email }), el('div', { class: 'text-xs text-dim', text: u.username || '—' })) },
              { label: 'Role', render: (u) => Badge({ tone: u.role === 'admin' ? 'brand' : 'neutral', children: u.role }) },
              { label: 'Status', render: (u) => Badge({ tone: u.status === 'active' ? 'success' : 'danger', dot: true, children: u.status }) },
              { label: 'Saldo', align: 'right', render: (u) => el('span', { class: 'mono', text: formatRupiah(u.balance) }) },
              { label: 'Terdaftar', align: 'right', render: (u) => el('span', { class: 'text-xs text-dim', text: formatDate(u.createdAt, { withTime: false }) }) },
              {
                label: 'Aksi', align: 'right', render: (u) => el('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
                  Button({ size: 'sm', variant: 'ghost', iconName: 'user', title: u.role === 'admin' ? 'Turunkan ke user' : 'Jadikan admin', onClick: () => changeRole(u) }),
                  Button({ size: 'sm', variant: 'ghost', iconName: u.status === 'active' ? 'pause' : 'play', title: u.status === 'active' ? 'Tangguhkan' : 'Aktifkan', onClick: () => changeStatus(u) }),
                  Button({ size: 'sm', variant: 'ghost', iconName: 'wallet', title: 'Sesuaikan saldo', onClick: () => adjustBalance(u) })
                )
              }
            ],
            rows: data.users,
            empty: EmptyState({ title: 'Tidak ada pengguna' })
          }),
          el('div', {}, data.pagination.pages > 1 ? Button({ size: 'sm', variant: 'outline', children: `Halaman ${data.pagination.page} / ${data.pagination.pages}`, onClick: () => { state.usersPage = state.usersPage >= data.pagination.pages ? 1 : state.usersPage + 1; renderUsers(); } }) : null)
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat pengguna', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const changeRole = async (user) => {
    const target = user.role === 'admin' ? 'user' : 'admin';
    try {
      await api.patch(`/api/admin/users/${user.id}/role`, { role: target });
      toast({ type: 'success', title: 'Role diperbarui', message: `${user.email} → ${target}` });
      renderUsers();
    } catch (err) {
      toast({ type: 'error', title: 'Gagal mengubah role', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
    }
  };

  const changeStatus = (user) => {
    const nextStatus = user.status === 'active' ? 'suspended' : 'active';
    if (nextStatus === 'active') {
      api.patch(`/api/admin/users/${user.id}/status`, { status: 'active' })
        .then(() => { toast({ type: 'success', title: 'Akun diaktifkan kembali' }); renderUsers(); })
        .catch((err) => toast({ type: 'error', title: 'Gagal', message: err instanceof ApiError ? err.message : 'Coba lagi.' }));
      return;
    }
    const reason = Textarea({ label: 'Alasan penangguhan', name: 'reason', rows: 3, maxlength: 300 });
    const errorArea = el('div');
    const button = Button({
      variant: 'danger', children: 'Tangguhkan akun',
      onClick: async () => {
        const form = button.closest('.modal')?.querySelector('form');
        const value = form.elements.reason.value.trim();
        if (value.length < 3) {
          errorArea.replaceChildren(Alert({ tone: 'warning', title: 'Alasan wajib', children: 'Tulis alasan penangguhan.' }));
          return;
        }
        await runWithLoading(button, async () => {
          try {
            await api.patch(`/api/admin/users/${user.id}/status`, { status: nextStatus, reason: value });
            modal.close();
            toast({ type: 'success', title: 'Akun ditangguhkan' });
            renderUsers();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Memproses…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, reason, errorArea);
    const modal = Modal({
      title: 'Tangguhkan akun',
      description: `${user.email} tidak akan bisa masuk sampai diaktifkan kembali.`,
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  const adjustBalance = (user) => {
    const directionSelect = Select({ label: 'Arah', name: 'direction', options: [{ value: 'credit', label: 'Tambah saldo' }, { value: 'debit', label: 'Kurangi saldo' }] });
    const amountInput = Input({ label: 'Nominal', name: 'amount', type: 'number', min: 1, placeholder: '50000' });
    const reasonInput = Input({ label: 'Alasan (tercatat di audit log)', name: 'reason', placeholder: 'Kompensasi gangguan layanan' });
    const errorArea = el('div');
    const reference = newIdempotencyKey('adj');
    const button = Button({
      variant: 'primary', children: 'Simpan penyesuaian',
      onClick: async () => {
        const form = button.closest('.modal')?.querySelector('form');
        const amount = Number(form.elements.amount.value);
        const reason = form.elements.reason.value.trim();
        if (!Number.isFinite(amount) || amount <= 0) {
          errorArea.replaceChildren(Alert({ tone: 'warning', title: 'Nominal tidak valid', children: 'Masukkan nominal lebih dari 0.' }));
          return;
        }
        if (reason.length < 5) {
          errorArea.replaceChildren(Alert({ tone: 'warning', title: 'Alasan wajib', children: 'Minimal 5 karakter.' }));
          return;
        }
        await runWithLoading(button, async () => {
          try {
            await api.post(`/api/admin/users/${user.id}/wallet`, {
              direction: form.elements.direction.value,
              amount,
              reason,
              reference
            });
            modal.close();
            toast({ type: 'success', title: 'Saldo disesuaikan', message: 'Tercatat pada ledger dan audit log.' });
            renderUsers();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Menyimpan…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, directionSelect, amountInput, reasonInput, errorArea);
    const modal = Modal({
      title: 'Penyesuaian saldo',
      description: `${user.email} · saldo saat ini ${formatRupiah(user.balance)}`,
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  // ------------------------------------------------------------------ services
  const renderServices = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const data = await api.get('/api/admin/services');
      const filtered = state.servicesSearch
        ? data.services.filter((s) => `${s.name} ${s.appName} ${s.countryName}`.toLowerCase().includes(state.servicesSearch.toLowerCase()))
        : data.services;
      const searchInput = Input({ label: '', name: 'search', placeholder: 'Cari layanan…', value: state.servicesSearch });
      body.replaceChildren(
        Card({
          title: 'Layanan & harga',
          subtitle: data.lastSync ? `Sync terakhir: ${formatDate(data.lastSync.startedAt)} · ${data.lastSync.status}` : 'Belum pernah sinkron',
          actions: el('div', { class: 'row' },
            searchInput,
            Button({ variant: 'outline', iconName: 'search', children: 'Cari', onClick: () => { state.servicesSearch = searchInput.querySelector('input').value.trim(); renderServices(); } }),
            Button({ variant: 'primary', iconName: 'refresh', children: 'Sinkronkan', onClick: () => triggerSync() })
          )
        },
          Table({
            compact: true,
            columns: [
              { label: 'Layanan', render: (s) => el('div', {}, el('div', { text: s.name }), el('div', { class: 'text-xs text-dim', text: `${s.server} · ${s.code}` })) },
              { label: 'Harga supplier', align: 'right', render: (s) => el('span', { class: 'mono text-xs', text: formatRupiah(s.supplierPrice) }) },
              { label: 'Harga jual', align: 'right', render: (s) => el('span', { class: 'mono', text: formatRupiah(s.price) }) },
              { label: 'Markup', align: 'right', render: (s) => `${(s.markupBps / 100).toFixed(2)}%` },
              { label: 'Stok', align: 'right', render: (s) => formatNumber(s.stock) },
              { label: 'Status', render: (s) => Badge({ tone: s.active ? 'success' : 'neutral', dot: true, children: s.active ? 'aktif' : 'nonaktif' }) },
              { label: 'Aksi', align: 'right', render: (s) => Button({ size: 'sm', variant: 'ghost', iconName: 'settings', title: 'Edit layanan', onClick: () => editService(s) }) }
            ],
            rows: filtered.slice(0, 100),
            empty: EmptyState({ title: 'Belum ada layanan', description: 'Jalankan sinkronisasi katalog untuk mengisi layanan.' })
          }),
          el('p', { class: 'text-xs text-dim', text: `Menampilkan ${Math.min(filtered.length, 100)} dari ${filtered.length} layanan.` })
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat layanan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const triggerSync = async () => {
    try {
      await api.post('/api/admin/catalog/sync');
      toast({ type: 'info', title: 'Sinkronisasi dimulai', message: 'Proses berjalan di latar belakang. Muat ulang beberapa saat lagi.' });
    } catch (err) {
      toast({ type: 'error', title: 'Gagal memulai sinkronisasi', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
    }
  };

  const editService = (service) => {
    const priceInput = Input({ label: 'Harga jual', name: 'price', type: 'number', value: String(service.price), min: 1 });
    const markupInput = Input({ label: 'Markup (bps)', name: 'markup_bps', type: 'number', value: String(service.markupBps), min: 0, max: 10000, hint: '1500 bps = 15%' });
    const sortInput = Input({ label: 'Urutan', name: 'sort_order', type: 'number', value: '100', min: 0 });
    const activeToggle = Checkbox({ label: 'Layanan aktif (dapat dibeli)', name: 'active', checked: service.active });
    const errorArea = el('div');
    const button = Button({
      variant: 'primary', children: 'Simpan',
      onClick: async () => {
        const form = button.closest('.modal')?.querySelector('form');
        await runWithLoading(button, async () => {
          try {
            await api.patch(`/api/admin/services/${service.id}`, {
              price: Number(form.elements.price.value),
              markup_bps: Number(form.elements.markup_bps.value),
              sort_order: Number(form.elements.sort_order.value),
              active: form.elements.active.checked
            });
            modal.close();
            toast({ type: 'success', title: 'Layanan diperbarui' });
            renderServices();
          } catch (err) {
            errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal menyimpan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        }, { loadingLabel: 'Menyimpan…' });
      }
    });
    const form = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() }, priceInput, markupInput, sortInput, activeToggle, errorArea);
    const modal = Modal({
      title: service.name,
      description: `${service.server} · stok ${formatNumber(service.stock)}`,
      body: form,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
    });
  };

  // --------------------------------------------------------------------- audit
  const renderAudit = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const data = await api.get(`/api/admin/audit?page=${state.auditPage}`);
      body.replaceChildren(
        Card({ title: 'Audit log admin', subtitle: 'Setiap perubahan sensitif dicatat dengan aktor dan alasannya', flush: true },
          Table({
            compact: true,
            columns: [
              { label: 'Waktu', render: (e) => el('span', { class: 'text-xs text-dim', text: formatDate(e.createdAt) }) },
              { label: 'Admin', render: (e) => e.admin?.email || '—' },
              { label: 'Aksi', render: (e) => el('span', { class: 'mono text-xs', text: e.action }) },
              { label: 'Target', render: (e) => `${e.targetType}${e.targetId ? ` · ${String(e.targetId).slice(0, 8)}` : ''}` },
              { label: 'Alasan', render: (e) => el('span', { class: 'text-xs text-dim', text: e.reason || '—' }) }
            ],
            rows: data.entries,
            empty: EmptyState({ title: 'Belum ada aktivitas admin' })
          }),
          el('div', {}, data.pagination.pages > 1 ? Button({ size: 'sm', variant: 'outline', children: `Halaman ${data.pagination.page} / ${data.pagination.pages}`, onClick: () => { state.auditPage = state.auditPage >= data.pagination.pages ? 1 : state.auditPage + 1; renderAudit(); } }) : null)
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat audit log', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  // ------------------------------------------------------------------ settings
  const saveSetting = async (key, value, button, errorArea) => {
    await runWithLoading(button, async () => {
      try {
        await api.patch(`/api/admin/settings/${key}`, { value });
        toast({ type: 'success', title: 'Pengaturan disimpan', message: key });
      } catch (err) {
        errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal menyimpan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
      }
    }, { loadingLabel: 'Menyimpan…' });
  };

  const renderSettings = async () => {
    body.replaceChildren(new Skeleton({ card: true }));
    try {
      const { settings, payment } = await api.get('/api/admin/settings');

      const storeForm = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() });
      const storeError = el('div');
      const storeSave = Button({ variant: 'primary', children: 'Simpan profil toko' });
      storeForm.append(
        el('div', { class: 'form-grid form-grid--2' },
          Input({ label: 'Nama toko', name: 'name', value: settings.store_profile.name }),
          Input({ label: 'Tagline', name: 'tagline', value: settings.store_profile.tagline || '' }),
          Input({ label: 'Email dukungan', name: 'support_email', type: 'email', value: settings.store_profile.support_email || '' }),
          Input({ label: 'WhatsApp dukungan', name: 'support_whatsapp', value: settings.store_profile.support_whatsapp || '' })
        ),
        storeError,
        el('div', { class: 'form-actions' }, storeSave)
      );
      storeSave.addEventListener('click', () => saveSetting('store_profile', {
        name: storeForm.elements.name.value,
        tagline: storeForm.elements.tagline.value,
        support_email: storeForm.elements.support_email.value,
        support_whatsapp: storeForm.elements.support_whatsapp.value,
        support_telegram: settings.store_profile.support_telegram || ''
      }, storeSave, storeError));

      // deposit policy + repeatable bank accounts
      const accountsArea = el('div', { class: 'stack' });
      const addAccountRow = (account = {}) => {
        const row = el('div', { class: 'form-grid form-grid--2' },
          Input({ label: 'Bank', name: 'bank_name', value: account.bank_name || '' }),
          Input({ label: 'Nomor rekening', name: 'account_number', value: account.account_number || '' }),
          Input({ label: 'Atas nama', name: 'account_holder', value: account.account_holder || '' }),
          Button({ variant: 'ghost', size: 'sm', iconName: 'trash', children: 'Hapus', onClick: () => row.remove() })
        );
        accountsArea.appendChild(row);
      };
      (settings.deposit_policy.bank_accounts || []).forEach(addAccountRow);

      const depositForm = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() });
      const depositError = el('div');
      const depositSave = Button({ variant: 'primary', children: 'Simpan kebijakan deposit' });
      depositForm.append(
        el('div', { class: 'form-grid form-grid--2' },
          Input({ label: 'Minimum deposit', name: 'min_amount', type: 'number', value: String(settings.deposit_policy.min_amount) }),
          Input({ label: 'Maksimum deposit', name: 'max_amount', type: 'number', value: String(settings.deposit_policy.max_amount) }),
          Input({ label: 'Kedaluwarsa (jam)', name: 'expiry_hours', type: 'number', value: String(settings.deposit_policy.expiry_hours) })
        ),
        Textarea({ label: 'Instruksi deposit', name: 'instructions', rows: 3, maxlength: 1000, value: settings.deposit_policy.instructions || '' }),
        el('div', {}, el('div', { class: 'section-label', style: { marginBottom: '8px' }, text: 'Rekening tujuan' }), accountsArea,
          Button({ variant: 'outline', size: 'sm', iconName: 'plus', children: 'Tambah rekening', onClick: () => addAccountRow() })),
        depositError,
        el('div', { class: 'form-actions' }, depositSave)
      );
      depositSave.addEventListener('click', () => {
        const accounts = [...accountsArea.children].map((row) => ({
          bank_name: row.querySelector('[name="bank_name"]').value,
          account_number: row.querySelector('[name="account_number"]').value,
          account_holder: row.querySelector('[name="account_holder"]').value
        })).filter((a) => a.bank_name || a.account_number);
        saveSetting('deposit_policy', {
          min_amount: Number(depositForm.elements.min_amount.value),
          max_amount: Number(depositForm.elements.max_amount.value),
          expiry_hours: Number(depositForm.elements.expiry_hours.value),
          instructions: depositForm.elements.instructions.value,
          bank_accounts: accounts
        }, depositSave, depositError);
      });

      const policy = settings.pricing_policy || {};
      const pricingForm = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() });
      const pricingError = el('div');
      const pricingSave = Button({ variant: 'primary', children: 'Simpan harga' });

      const categoriesValue = Object.entries(policy.category_bps || {})
        .map(([key, bps]) => `${key}=${bps}`)
        .join('\n');

      pricingForm.append(
        el('div', { class: 'form-grid form-grid--2' },
          Input({ label: 'Markup default (bps)', name: 'default_markup_bps', type: 'number', value: String(policy.default_markup_bps ?? 1500), min: 0, max: 10000, hint: '1500 bps = 15% dari harga supplier' }),
          Input({ label: 'Markup tetap (Rp)', name: 'fixed_markup', type: 'number', value: String(policy.fixed_markup ?? 0), min: 0, hint: 'Ditambahkan setelah persentase' }),
          Input({ label: 'Margin minimum (Rp)', name: 'min_margin', type: 'number', value: String(policy.min_margin ?? 0), min: 0, hint: 'Lantai keuntungan per order' }),
          Input({ label: 'Pajak (bps)', name: 'tax_bps', type: 'number', value: String(policy.tax_bps ?? 0), min: 0, max: 10000, hint: '1100 bps = 11%' }),
          Input({ label: 'Label pajak', name: 'tax_label', value: policy.tax_label || 'PPN' }),
          Select({
            label: 'Pembulatan', name: 'rounding_mode',
            options: [
              { value: 'none', label: 'Tanpa pembulatan' },
              { value: 'nearest', label: 'Ke terdekat' },
              { value: 'up', label: 'Selalu ke atas' },
              { value: 'down', label: 'Selalu ke bawah' }
            ],
            value: policy.rounding?.mode || 'none'
          }),
          Input({ label: 'Kelipatan pembulatan (Rp)', name: 'rounding_step', type: 'number', value: String(policy.rounding?.step ?? 1), min: 1 }),
          Input({ label: 'Markup per kategori (app=satuan bps)', name: 'category_bps', value: categoriesValue, hint: 'Satu per baris, contoh: wa=2000' })
        ),
        pricingError,
        el('div', { class: 'form-actions' }, pricingSave)
      );

      const readPricingForm = () => {
        const category = {};
        String(pricingForm.elements.category_bps.value || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            const [key, value] = line.split('=');
            if (key && Number.isFinite(Number(value))) category[key.trim()] = Number(value);
          });
        return {
          default_markup_bps: Number(pricingForm.elements.default_markup_bps.value),
          fixed_markup: Number(pricingForm.elements.fixed_markup.value),
          min_margin: Number(pricingForm.elements.min_margin.value),
          tax_bps: Number(pricingForm.elements.tax_bps.value),
          tax_label: pricingForm.elements.tax_label.value,
          rounding: {
            mode: pricingForm.elements.rounding_mode.value,
            step: Number(pricingForm.elements.rounding_step.value)
          },
          category_bps: category
        };
      };

      pricingSave.addEventListener('click', () => saveSetting('pricing_policy', readPricingForm(), pricingSave, pricingError));

      // ---- Simulator: shows exactly what a customer would pay, before saving.
      const simulatorInput = Input({ label: 'Harga supplier (Rp)', name: 'supplier_price', type: 'number', value: '3500', min: 0 });
      const simulatorCategory = Input({ label: 'Kategori (opsional)', name: 'category', value: '' });
      const simulatorOut = el('div', { class: 'text-muted text-sm', text: 'Isi harga supplier lalu jalankan simulasi.' });
      const simulatorRun = Button({
        variant: 'outline', size: 'sm', children: 'Hitung simulasi',
        onClick: () => runWithLoading(simulatorRun, async () => {
          try {
            const response = await api.post('/api/admin/pricing/preview', {
              supplier_price: Number(simulatorInput.querySelector('input').value),
              category: simulatorCategory.querySelector('input').value || undefined,
              policy: readPricingForm()
            });
            const r = response.result;
            simulatorOut.replaceChildren(
              KeyValue({
                items: [
                  { label: 'Harga supplier', value: formatRupiah(r.supplierPrice) },
                  { label: 'Markup', value: `${formatRupiah(r.markupAmount)} (${(r.markupBps / 100).toFixed(2)}%)` },
                  { label: 'Pajak', value: formatRupiah(r.taxAmount) },
                  { label: 'Total pelanggan', value: formatRupiah(r.totalPrice) },
                  { label: 'Aturan aktif', value: r.rule },
                  { label: 'Penyesuaian', value: (r.adjustments || []).join(', ') || '—' }
                ]
              }),
              el('p', { class: 'text-muted text-sm', text: response.explanation })
            );
          } catch (err) {
            simulatorOut.replaceChildren(Alert({ tone: 'danger', title: 'Simulasi gagal', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
          }
        })
      });

      const pricingCard = Card({
        title: 'Markup & harga',
        subtitle: 'Perubahan berlaku pada quote berikutnya. Order lama menyimpan snapshot harga sendiri.',
        children: [
          pricingForm,
          el('div', { class: 'divider' }),
          el('div', { class: 'section-label', text: 'Simulator harga' }),
          el('div', { class: 'form-grid form-grid--2' }, simulatorInput, simulatorCategory),
          el('div', { class: 'form-actions' }, simulatorRun),
          simulatorOut
        ]
      });

      const opsForm = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() });
      const opsError = el('div');
      const opsSave = Button({ variant: 'primary', children: 'Simpan operasional' });
      const salesToggle = Checkbox({ label: 'Penjualan dibuka', name: 'sales_open', checked: settings.operations.sales_open });
      opsForm.append(
        salesToggle,
        el('div', { class: 'form-grid form-grid--2' },
          Input({ label: 'Maks order aktif / pengguna', name: 'max_active_orders_per_user', type: 'number', value: String(settings.operations.max_active_orders_per_user) }),
          Input({ label: 'Interval poll klien (ms)', name: 'order_poll_interval_ms', type: 'number', value: String(settings.operations.order_poll_interval_ms) })
        ),
        Textarea({ label: 'Pesan pemeliharaan', name: 'maintenance_message', rows: 2, maxlength: 300, value: settings.operations.maintenance_message || '' }),
        opsError,
        el('div', { class: 'form-actions' }, opsSave)
      );
      opsSave.addEventListener('click', () => saveSetting('operations', {
        sales_open: opsForm.elements.sales_open.checked,
        max_active_orders_per_user: Number(opsForm.elements.max_active_orders_per_user.value),
        order_poll_interval_ms: Number(opsForm.elements.order_poll_interval_ms.value),
        maintenance_message: opsForm.elements.maintenance_message.value,
        server_poll_interval_ms: settings.operations.server_poll_interval_ms,
        order_expiry_seconds: settings.operations.order_expiry_seconds
      }, opsSave, opsError));

      const supplierSelect = Select({
        label: 'Server supplier', name: 'server',
        options: [{ value: 'server1', label: 'Server 1' }, { value: 'server2', label: 'Server 2' }, { value: 'server3', label: 'Server 3' }],
        value: settings.supplier.server
      });
      const supplierForm = el('form', { class: 'stack', attrs: { novalidate: true }, onSubmit: (e) => e.preventDefault() },
        supplierSelect,
        Input({ label: 'Allowlist app (pisahkan koma, kosongkan untuk semua)', name: 'app_allowlist', value: (settings.supplier.app_allowlist || []).join(',') }),
        Checkbox({ label: 'Sinkronisasi katalog aktif', name: 'sync_enabled', checked: settings.supplier.sync_enabled })
      );
      const supplierError = el('div');
      const supplierSave = Button({ variant: 'primary', children: 'Simpan konfigurasi supplier' });
      supplierForm.append(supplierError, el('div', { class: 'form-actions' }, supplierSave));
      supplierSave.addEventListener('click', () => saveSetting('supplier', {
        provider: 'telekos',
        server: supplierForm.elements.server.value,
        app_allowlist: supplierForm.elements.app_allowlist.value.split(',').map((s) => s.trim()).filter(Boolean),
        sync_enabled: supplierForm.elements.sync_enabled.checked
      }, supplierSave, supplierError));

      body.replaceChildren(
        el('div', { class: 'grid grid--2' },
          Card({ title: 'Profil toko', subtitle: 'Tampil pada landing page dan footer' }, storeForm),
          pricingCard,
          Card({ title: 'Deposit manual', subtitle: 'Rekening yang tampil ke pengguna' }, depositForm),
          Card({ title: 'Operasional', subtitle: 'Kontrol penjualan dan batas order' }, opsForm),
          Card({ title: 'Supplier', subtitle: 'Server aktif dan allowlist aplikasi' }, supplierForm),
          Card({ title: 'Payment gateway', subtitle: 'Status integrasi' },
            KeyValue({ items: [
              { label: 'Status', value: Badge({ tone: 'neutral', children: payment.enabled ? 'aktif' : 'nonaktif' }) },
              { label: 'Provider', value: payment.provider || 'belum ditetapkan' },
              { label: 'Mode', value: payment.mode },
              { label: 'Pesan', value: el('span', { class: 'text-xs', text: payment.message }) }
            ] })
          )
        )
      );
    } catch (err) {
      body.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat pengaturan', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  const renderBody = () => {
    switch (state.tab) {
      case 'deposits': return renderDeposits();
      case 'orders': return renderOrders();
      case 'users': return renderUsers();
      case 'services': return renderServices();
      case 'audit': return renderAudit();
      case 'settings': return renderSettings();
      default: return renderOverview();
    }
  };

  await renderBody();

  return { node: shell, title: 'Admin — FINZZ Store' };
}
