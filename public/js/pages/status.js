// ============================================================================
// STATUS PAGE — nothing here is invented.
//
// Every row comes from GET /api/health, which reports what the server actually
// observed on this request: whether the database answered, which driver is in
// use, whether the supplier is configured and whether it is the mock fixture,
// and whether automatic payment is enabled.
//
// When the endpoint itself fails, the page says so. It never shows a green
// badge for something it could not check.
// ============================================================================
import { el, Badge, Card, KeyValue, Spinner, Button, Alert } from '../ui.js';
import { icon } from '../icons.js';
import { formatDate, formatNumber } from '../store.js';

const tone = (ok) => (ok ? 'success' : 'danger');
const badge = (ok, textOk, textFail) =>
  Badge({ tone: tone(ok), children: ok ? textOk : textFail });

function row(label, value, hint) {
  return el('div', { class: 'status-row' },
    el('div', { class: 'status-row__label', text: label }),
    el('div', { class: 'status-row__value' }, value),
    hint ? el('div', { class: 'status-row__hint text-muted text-xs', text: hint }) : null
  );
}

export default async function statusPage(ctx) {
  const { api, layout, navigate } = ctx;

  const catalogCard = (summary) => {
    if (!summary || summary.available !== true) {
      return Alert({
        tone: 'warning',
        title: 'Jumlah layanan belum bisa dibaca',
        children: 'Ringkasan katalog tidak merespons. Sampai data terbaca, halaman ini tidak mengklaim ada layanan yang siap dijual.'
      });
    }
    const services = Number(summary.activeServices ?? 0);
    const stale = !summary.lastCatalogSync;
    return Card({
      title: 'Katalog layanan',
      subtitle: 'Dihitung dari database, bukan dari data contoh',
      children: [
        row('Layanan siap dijual', el('span', { class: 'mono', text: formatNumber(services) }),
          services > 0 ? null : 'Katalog kosong: landing belum bisa menampilkan harga sampai sinkronisasi berhasil.'),
        row('Negara', el('span', { class: 'mono', text: formatNumber(Number(summary.countries ?? 0)) }), null),
        row('Aplikasi', el('span', { class: 'mono', text: formatNumber(Number(summary.apps ?? 0)) }), null),
        row('Sinkron terakhir', el('span', { text: summary.lastCatalogSync ? formatDate(summary.lastCatalogSync) : 'belum pernah' }),
          stale ? 'Belum ada sinkronisasi tercatat. Jalankan POST /api/cron/catalog dengan CRON_SECRET.' : null)
      ]
    });
  };

  const body = el('div', { class: 'stack' }, el('div', { class: 'row' }, Spinner({}), el('span', { text: 'Memeriksa status layanan…' })));

  const load = async () => {
    body.replaceChildren(el('div', { class: 'row' }, Spinner({}), el('span', { text: 'Memeriksa status layanan…' })));
    try {
      const health = await api.get('/api/health');
      // Counts come from the database, never from a constant. If the call fails
      // the catalogue row says so instead of showing zero.
      const summary = await api.get('/api/public/summary').catch(() => null);

      const db = health.database || {};
      const supplier = health.supplier || {};
      const payment = health.payment || {};

      const supplierLabel = supplier.mock
        ? 'mock (data contoh, bukan supplier nyata)'
        : supplier.configured
          ? 'terkonfigurasi'
          : 'belum terkonfigurasi';

      body.replaceChildren(
        el('div', { class: 'grid grid--2' },
          Card({
            title: 'Database',
            subtitle: 'Koneksi yang dipakai permintaan ini',
            children: [
              row('Status', badge(db.ok, 'terhubung', 'tidak terhubung'),
                db.ok ? `driver: ${db.driver}` : 'Periksa DATABASE_URL dan konektivitas.'),
              db.latencyMs !== null && db.latencyMs !== undefined
                ? row('Latensi', el('span', { class: 'mono', text: `${db.latencyMs} ms` }), null)
                : null
            ].filter(Boolean)
          }),
          Card({
            title: 'Supplier nomor',
            subtitle: 'TeleKos',
            children: [
              row('Mode', el('span', { text: supplierLabel }), null),
              row('Kontrak terverifikasi', badge(Boolean(supplier.contractVerified), 'ya', 'belum'),
                'Selama belum terverifikasi, integrasi tidak boleh disebut aktif.'),
              row('Webhook', badge(Boolean(supplier.webhookConfigured), 'dikonfigurasi', 'belum diset'), null),
              supplier.lastError
                ? row('Error terakhir', el('span', { class: 'mono text-xs', text: String(supplier.lastError) }), null)
                : null
            ].filter(Boolean)
          }),
          Card({
            title: 'Pembayaran otomatis',
            subtitle: 'Gateway',
            children: [
              row('Status', badge(Boolean(payment.enabled), 'aktif', 'nonaktif'),
                payment.enabled ? null : 'Tanpa gateway, deposit diproses manual oleh admin.'),
              row('Mode', el('span', { text: payment.mode || 'disabled' }), null)
            ]
          }),
          Card({
            title: 'Server',
            subtitle: 'Build yang sedang melayani',
            children: [
              row('Versi', el('span', { class: 'mono', text: health.version || '—' }), null),
              row('Lingkungan', el('span', { text: health.environment || '—' }), null),
              row('Waktu server', el('span', { text: formatDate(health.time) }), null),
              row('Latensi permintaan', el('span', { class: 'mono', text: `${health.latencyMs ?? 0} ms` }), null)
            ]
          })
        ),
        catalogCard(summary),
        el('p', { class: 'text-muted text-sm', text: 'Data di atas diambil langsung dari server saat halaman ini dimuat. Tidak ada angka yang dikarang atau disimpan sebelumnya.' }),
        el('div', { class: 'row' },
          Button({ variant: 'outline', size: 'sm', iconName: 'refresh', children: 'Periksa ulang', onClick: () => load() }),
          Button({ variant: 'ghost', size: 'sm', children: 'Kembali', onClick: () => navigate('/') })
        )
      );

      // Surface job counters only when the server actually reports them.
      if (health.jobs?.poller) {
        body.appendChild(
          Card({
            title: 'Pekerjaan terjadwal',
            subtitle: 'Penghitung runtime proses ini',
            children: KeyValue({
              items: [
                { label: 'Tick poller', value: String(health.jobs.poller.ticks ?? 0) },
                { label: 'Order diproses', value: String(health.jobs.poller.processed ?? 0) },
                { label: 'Kegagalan', value: String(health.jobs.poller.failures ?? 0) },
                { label: 'Rekonsiliasi', value: String(health.jobs.reconciliation?.runs ?? 0) }
              ]
            })
          })
        );
      }
    } catch (err) {
      body.replaceChildren(
        Alert({
          tone: 'danger',
          title: 'Status tidak dapat diperiksa',
          children: 'Endpoint /api/health tidak merespons. Ini berarti ada gangguan nyata — halaman ini tidak akan menampilkan status hijau tanpa data.'
        }),
        el('div', { class: 'row' },
          Button({ variant: 'outline', size: 'sm', children: 'Coba lagi', onClick: () => load() })
        )
      );
    }
  };

  await load();

  const node = el('div', {},
    layout.header({ variant: 'public' }),
    el('div', { class: 'page page--narrow' },
      el('div', { class: 'page__head' },
        el('div', {},
          el('div', { class: 'row', style: { gap: '8px' } }, icon('activity', { size: 18 }), el('h1', { class: 'page__title', text: 'Status layanan' })),
          el('p', { class: 'page__subtitle', text: 'Pemeriksaan langsung terhadap komponen yang benar-benar dipakai transaksi Anda.' })
        )
      ),
      body
    ),
    layout.footer ? layout.footer() : null
  );

  return { node, title: 'Status Layanan — FINZZ Store' };
}
