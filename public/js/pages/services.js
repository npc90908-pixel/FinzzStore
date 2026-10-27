// ============================================================================
// SERVICES / BUY FLOW
// The client never sends a price: the server re-quotes the supplier and debits
// the wallet inside one transaction. The idempotency key is created when the
// confirmation modal opens and reused if the user retries.
// ============================================================================
import { el, Button, Badge, Card, Skeleton, EmptyState, Modal, Alert, toast } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError, newIdempotencyKey } from '../api.js';
import { formatRupiah, formatNumber, formatDate } from '../store.js';

const APP_ICON = {
  WhatsApp: 'smartphoneCheck', Telegram: 'link', Google: 'globe', Instagram: 'sparkles',
  TikTok: 'play', Discord: 'users', Facebook: 'users', X: 'x', Shopee: 'inbox', Grab: 'zap'
};

export default async function services(ctx) {
  const { api, store, navigate, layout } = ctx;

  let catalog = null;
  let activeApp = null;
  let selected = null;

  // Catalogue filters. Everything is applied client-side to the already
  // fetched catalogue: the server has one authoritative price list, and
  // re-querying per keystroke would hammer the API for no benefit.
  const filters = {
    query: '',
    country: 'all',
    maxPrice: 'all',
    sort: 'price-asc',
    availableOnly: true
  };
  // Incremental loading: 24 at a time keeps the first paint fast on mobile and
  // avoids rendering hundreds of buttons that are never seen.
  const PAGE_SIZE = 24;
  let visibleCount = PAGE_SIZE;

  const listArea = el('div', { class: 'stack' });
  const detailArea = el('div', { class: 'card' }, el('div', { class: 'card__body' }, Skeleton({ lines: 4 })));
  const appTabs = el('div', { class: 'pill-row' });
  const metaRow = el('div', { class: 'row row--between row--wrap' });
  const filterBar = el('div', { class: 'filter-bar' });

  const priceSort = (a, b, dir) => (dir === 'desc' ? b.price - a.price : a.price - b.price);
  const nameSort = (a, b) => String(a.countryName || a.name).localeCompare(String(b.countryName || b.name), 'id');

  /** Apply every filter to a flat service list. Pure: returns a new array. */
  const applyFilters = (services) => {
    const q = filters.query.trim().toLowerCase();
    const maxPrice = filters.maxPrice === 'all' ? null : Number(filters.maxPrice);
    let list = services.filter((s) => {
      if (filters.availableOnly && !(s.stock > 0 && s.active !== false)) return false;
      if (filters.country !== 'all' && String(s.countryId) !== String(filters.country)) return false;
      if (maxPrice !== null && Number(s.price) > maxPrice) return false;
      if (q) {
        const haystack = `${s.appName || ''} ${s.countryName || ''} ${s.name || ''} ${s.callingCode || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    switch (filters.sort) {
      case 'price-desc': list = list.sort((a, b) => priceSort(a, b, 'desc')); break;
      case 'name-asc': list = list.sort(nameSort); break;
      case 'stock-desc': list = list.sort((a, b) => (b.stock || 0) - (a.stock || 0)); break;
      default: list = list.sort((a, b) => priceSort(a, b, 'asc'));
    }
    return list;
  };

  const isFiltering = () =>
    filters.query.trim() !== '' || filters.country !== 'all' || filters.maxPrice !== 'all' || !filters.availableOnly;

  const content = el('div', { class: 'page' },
    el('div', { class: 'page__head' },
      el('div', {},
        el('h1', { class: 'page__title', text: 'Beli nomor virtual' }),
        el('p', { class: 'page__subtitle', text: 'Pilih aplikasi dan negara. Harga diambil langsung dari katalog supplier dan dikonfirmasi ulang saat order dibuat.' })
      ),
      Button({ variant: 'outline', iconName: 'wallet', children: 'Isi saldo', onClick: () => navigate('/wallet') })
    ),
    metaRow,
    filterBar,
    appTabs,
    el('div', { class: 'grid grid--sidebar' }, listArea, detailArea)
  );

  // A visitor without an account may browse the catalogue; the buying actions
  // route to login. The server still enforces this — the UI is a courtesy.
  const signedIn = Boolean(store.get('user'));
  const shell = signedIn
    ? appShell(layout, 'services', content).shell
    : el('div', { class: 'app-shell' },
        layout.header({ variant: 'public' }),
        el('main', { class: 'main', attrs: { id: 'main' } },
          content,
          el('div', { class: 'container' },
            Alert({
              tone: 'info',
              title: 'Masuk untuk membeli',
              children: 'Anda bisa menjelajahi seluruh katalog dan harga tanpa akun. Untuk membeli nomor, masuk atau daftar — pilihan Anda akan kami bawa kembali ke sini.'
            })
          )
        ),
        layout.footer({ compact: true })
      );

  const renderDetail = (service) => {
    if (!service) {
      detailArea.replaceChildren(
        el('div', { class: 'card__body' },
          EmptyState({ title: 'Pilih negara', description: 'Rincian harga dan tombol pembelian muncul setelah Anda memilih salah satu negara.', iconName: 'globe' })
        )
      );
      return;
    }

    const priceRow = el('div', { class: 'row row--between' }, el('span', { class: 'text-sm text-muted', text: 'Harga' }), el('strong', { class: 'mono', text: formatRupiah(service.price) }));
    const stockRow = el('div', { class: 'row row--between' }, el('span', { class: 'text-sm text-muted', text: 'Stok tersedia' }), el('span', { class: 'text-sm', text: formatNumber(service.stock) }));

    const buyButton = signedIn
      ? Button({
          variant: 'primary',
          size: 'lg',
          block: true,
          iconName: 'zap',
          children: 'Beli sekarang',
          onClick: () => openConfirm(service)
        })
      : Button({
          variant: 'primary',
          size: 'lg',
          block: true,
          iconName: 'login',
          children: 'Masuk untuk membeli',
          // The chosen service survives the round trip, so the visitor resumes
          // exactly where they were instead of hunting for it again.
          onClick: () => navigate(`/login?next=${encodeURIComponent(`/services?service=${service.id}`)}`)
        });

    detailArea.replaceChildren(
      el('header', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: `${service.appName} · ${service.countryName}` }),
          el('p', { class: 'card__subtitle', text: service.code })
        ),
        Badge({ tone: service.stock > 0 ? 'success' : 'warning', dot: true, children: service.stock > 0 ? 'Tersedia' : 'Stok kosong' })
      ),
      el('div', { class: 'card__body stack' },
        el('div', { class: 'stack', style: { gap: '10px' } }, priceRow, stockRow,
          signedIn
            ? el('div', { class: 'row row--between' },
                el('span', { class: 'text-sm text-muted', text: 'Saldo Anda' }),
                el('span', { class: 'text-sm mono', text: formatRupiah(store.get('balance') ?? 0) })
              )
            : el('div', { class: 'row row--between' },
                el('span', { class: 'text-sm text-muted', text: 'Status' }),
                el('span', { class: 'text-sm', text: 'Menjelajah tanpa akun' })
              )
        ),
        el('div', { class: 'text-xs text-dim', text: `Harga katalog diperbarui ${formatDate(service.syncedAt)}. Harga final dikonfirmasi ulang saat order dibuat.` }),
        buyButton,
        el('p', { class: 'text-xs text-dim', text: 'Saldo dipotong satu kali. Jika supplier menolak pembelian, saldo dikembalikan otomatis.' })
      )
    );
  };

  const openConfirm = (service) => {
    const idempotencyKey = newIdempotencyKey('ord');
    const body = el('div', { class: 'stack' });
    const quoteArea = el('div', {}, Skeleton({ lines: 3 }));
    const errorArea = el('div');
    body.append(
      el('div', { class: 'row' },
        el('span', { class: 'service-card__logo' }, icon(APP_ICON[service.appName] || 'smartphone', { size: 18 })),
        el('div', {},
          el('div', { class: 'service-card__name', text: `${service.appName} ${service.countryName}` }),
          el('div', { class: 'service-card__meta', text: `Nomor ${service.callingCode || ''} · stok ${formatNumber(service.stock)}` })
        )
      ),
      quoteArea,
      errorArea,
      el('p', { class: 'text-xs text-dim', text: 'Dengan melanjutkan, saldo Anda dipotong sesuai harga final di atas. Order tidak dapat dibatalkan setelah OTP diterima.' })
    );

    const confirmButton = Button({
      variant: 'primary',
      size: 'lg',
      children: 'Konfirmasi & potong saldo',
      disabled: true,
      onClick: async () => {
        if (confirmButton.dataset.loading === '1') return;
        confirmButton.dataset.loading = '1';
        confirmButton.disabled = true;
        confirmButton.replaceChildren(el('span', { class: 'btn__spinner' }), el('span', { text: 'Memproses…' }));
        try {
          const result = await api.post('/api/orders', { service_id: service.id, idempotency_key: idempotencyKey });
          modal.close();
          store.set({ balance: result.balance });
          if (result.notice?.type === 'refunded') {
            toast({ type: 'warning', title: 'Pembelian ditolak supplier', message: result.notice.message });
            navigate('/orders');
            return;
          }
          if (result.pending) {
            toast({ type: 'info', title: 'Sedang dikonfirmasi', message: result.notice?.message || 'Order sedang dikonfirmasi ke supplier.' });
          } else {
            toast({ type: 'success', title: 'Order dibuat', message: 'Nomor sedang disiapkan. OTP akan muncul otomatis.' });
          }
          navigate(`/orders?id=${result.order.id}`);
        } catch (err) {
          const message = err instanceof ApiError ? err.message : 'Pembelian gagal.';
          errorArea.replaceChildren(
            Alert({ tone: 'danger', title: err?.code === 'INSUFFICIENT_BALANCE' ? 'Saldo tidak cukup' : 'Pembelian gagal', children: message })
          );
          if (err?.code === 'INSUFFICIENT_BALANCE') {
            errorArea.appendChild(
              el('div', { style: { marginTop: '10px' } },
                Button({ variant: 'outline', size: 'sm', iconName: 'wallet', children: 'Isi saldo sekarang', onClick: () => { modal.close(); navigate('/wallet'); } })
              )
            );
          }
          confirmButton.dataset.loading = '0';
          confirmButton.disabled = false;
          confirmButton.replaceChildren(el('span', { text: 'Coba lagi' }));
        }
      }
    });

    const modal = Modal({
      title: 'Konfirmasi pembelian',
      description: 'Periksa rincian sebelum saldo dipotong.',
      body,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), confirmButton]
    });

    (async () => {
      try {
        const quote = await api.get(`/api/public/quote?service_id=${encodeURIComponent(service.id)}`);
        const p = quote.price;
        quoteArea.replaceChildren(
          el('dl', { class: 'kv' },
            el('dt', { text: 'Harga supplier' }), el('dd', { class: 'mono', text: formatRupiah(p.supplierPrice) }),
            el('dt', { text: 'Markup layanan' }), el('dd', { class: 'mono', text: formatRupiah(p.markupAmount) }),
            p.taxAmount > 0 ? el('dt', { text: 'Pajak' }) : null,
            p.taxAmount > 0 ? el('dd', { class: 'mono', text: formatRupiah(p.taxAmount) }) : null,
            el('dt', { text: 'Total dibayar' }), el('dd', { class: 'mono', style: { fontWeight: '700' }, text: formatRupiah(p.totalPrice) }),
            el('dt', { text: 'Stok saat ini' }), el('dd', { text: formatNumber(quote.stock) })
          ),
          quote.live ? null : Alert({ tone: 'warning', title: 'Harga tersinkron', children: 'Harga live supplier belum tersedia; harga katalog terakhir digunakan dan diverifikasi ulang oleh server.' })
        );
        confirmButton.disabled = (store.get('balance') ?? 0) < p.totalPrice;
        if (confirmButton.disabled) {
          errorArea.replaceChildren(
            Alert({ tone: 'warning', title: 'Saldo tidak cukup', children: `Anda membutuhkan ${formatRupiah(p.totalPrice)}. Silakan isi saldo terlebih dahulu.` })
          );
        }
      } catch (err) {
        quoteArea.replaceChildren(
          el('div', { class: 'row row--between' },
            el('span', { class: 'text-sm text-muted', text: 'Harga katalog' }),
            el('strong', { class: 'mono', text: formatRupiah(service.price) })
          ),
          Alert({ tone: 'warning', title: 'Harga live tidak tersedia', children: err instanceof ApiError ? err.message : 'Server akan memvalidasi harga saat konfirmasi.' })
        );
        confirmButton.disabled = (store.get('balance') ?? 0) < service.price;
      }
    })();
  };

  const renderFilterBar = () => {
    const countries = catalog?.countries || [];
    const searchInput = el('input', {
      class: 'input',
      attrs: {
        type: 'search', placeholder: 'Cari aplikasi atau negara…', 'aria-label': 'Cari layanan',
        value: filters.query, autocomplete: 'off'
      },
      onInput: (event) => {
        filters.query = event.target.value;
        visibleCount = PAGE_SIZE;
        renderResults();
      }
    });

    const countrySelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Filter negara' },
      onChange: (event) => { filters.country = event.target.value; visibleCount = PAGE_SIZE; renderResults(); }
    },
      el('option', { attrs: { value: 'all' }, text: 'Semua negara' }),
      ...countries.map((c) => el('option', {
        attrs: { value: String(c.id), selected: String(c.id) === String(filters.country) ? '' : null },
        text: c.name
      }))
    );

    const priceSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Harga maksimum' },
      onChange: (event) => { filters.maxPrice = event.target.value; visibleCount = PAGE_SIZE; renderResults(); }
    },
      ...[['all', 'Semua harga'], ['5000', 'Di bawah Rp5.000'], ['10000', 'Di bawah Rp10.000'], ['25000', 'Di bawah Rp25.000'], ['50000', 'Di bawah Rp50.000']]
        .map(([value, label]) => el('option', { attrs: { value, selected: value === filters.maxPrice ? '' : null }, text: label }))
    );

    const sortSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Urutkan' },
      onChange: (event) => { filters.sort = event.target.value; renderResults(); }
    },
      ...[['price-asc', 'Termurah'], ['price-desc', 'Termahal'], ['name-asc', 'Nama A–Z'], ['stock-desc', 'Stok terbanyak']]
        .map(([value, label]) => el('option', { attrs: { value, selected: value === filters.sort ? '' : null }, text: label }))
    );

    const availableToggle = el('label', { class: 'row', attrs: { style: 'gap:8px;align-items:center' } },
      el('input', {
        attrs: { type: 'checkbox', checked: filters.availableOnly ? '' : null },
        onChange: (event) => { filters.availableOnly = event.target.checked; visibleCount = PAGE_SIZE; renderResults(); }
      }),
      el('span', { class: 'text-sm text-muted', text: 'Hanya yang ada stok' })
    );

    filterBar.replaceChildren(
      el('div', { class: 'filter-bar__fields' },
        el('div', { class: 'filter-bar__search' }, searchInput),
        countrySelect, priceSelect, sortSelect, availableToggle
      ),
      isFiltering()
        ? Button({
            variant: 'ghost', size: 'sm', iconName: 'refresh', children: 'Reset filter',
            onClick: () => {
              filters.query = ''; filters.country = 'all'; filters.maxPrice = 'all';
              filters.sort = 'price-asc'; filters.availableOnly = true; visibleCount = PAGE_SIZE;
              renderFilterBar(); renderResults();
            }
          })
        : null
    );
  };

  const countryCard = (service) => {
    const chip = el('button', {
      class: 'country-chip',
      attrs: { type: 'button', 'aria-pressed': String(selected?.id === service.id) },
      onClick: () => {
        for (const other of listArea.querySelectorAll('.country-chip')) other.setAttribute('aria-pressed', 'false');
        chip.setAttribute('aria-pressed', 'true');
        selected = service;
        renderDetail(service);
        if (window.innerWidth < 900) detailArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },
      el('span', { class: 'stack', style: { gap: '2px' } },
        el('span', { text: filters.query ? `${service.appName} · ${service.countryName}` : service.countryName }),
        el('span', { class: 'country-chip__stock', text: formatRupiah(service.price) })
      ),
      el('span', { class: 'country-chip__stock', text: formatNumber(service.stock) })
    );
    return chip;
  };

  /** Render either the selected app's countries or global search results. */
  const renderResults = () => {
    if (!catalog) return;
    const searching = filters.query.trim() !== '';
    const all = catalog.services || [];
    const app = (catalog.apps || []).find((a) => a.id === activeApp);

    // Two sources, deliberately:
    //   · no filters  -> the active app's own `countries` array (exactly what
    //                    the tab promised, no extra work);
    //   · any filter  -> the flat catalogue, so a price cap or a country search
    //                    can cross app boundaries instead of silently
    //                    pretending the other apps do not exist.
    let services;
    // `availableOnly` means the same thing in both branches: an offer that the
    // supplier cannot currently fill is not offered for sale. The unfiltered
    // path used to skip this check and listed zero-stock countries with a
    // working buy button, so it is applied here as well.
    const inStock = (list) => (filters.availableOnly ? list.filter((s) => s.stock > 0 && s.active !== false) : list);
    let soldOutApp = false;
    if (!isFiltering() && !searching && app) {
      const countries = (app.countries || []).slice().sort((a, b) => priceSort(a, b, 'asc'));
      services = inStock(countries);
      soldOutApp = services.length === 0 && countries.length > 0;
    } else {
      const pool = searching || !activeApp ? all : all;
      services = applyFilters(pool);
      if (!searching && app && filters.country === 'all') {
        services = services.filter((s) => String(s.appId) === String(activeApp));
      }
    }

    if (services.length === 0) {
      listArea.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'card__body' },
          soldOutApp
            ? EmptyState({
                title: 'Stok sedang kosong',
                description: 'Semua negara untuk aplikasi ini belum ada stok saat ini. Matikan “Hanya yang ada stok” untuk melihat daftar negaranya tanpa membeli.',
                iconName: 'alert'
              })
            : EmptyState({
                title: 'Tidak ada layanan yang cocok',
                description: 'Coba ubah kata kunci, negara, atau batas harga.',
                iconName: 'search'
              }),
          Button({ variant: 'outline', size: 'sm', children: soldOutApp ? 'Tampilkan semua negara' : 'Reset filter', onClick: () => {
            filters.query = ''; filters.country = 'all'; filters.maxPrice = 'all'; filters.availableOnly = soldOutApp ? false : true;
            visibleCount = PAGE_SIZE; renderFilterBar(); renderResults();
          } })
        ))
      );
      return;
    }

    const shown = services.slice(0, visibleCount);
    const headerTitle = searching || filters.country !== 'all'
      ? `${formatNumber(services.length)} layanan cocok`
      : app ? `${app.name} — pilih negara` : 'Layanan';

    const grid = el('div', { class: 'country-grid' }, ...shown.map(countryCard));

    listArea.replaceChildren(
      el('div', { class: 'card' },
        el('header', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: headerTitle }),
            el('p', { class: 'card__subtitle', text: `Menampilkan ${formatNumber(shown.length)} dari ${formatNumber(services.length)} · diurutkan ${filters.sort === 'price-desc' ? 'termahal' : filters.sort === 'name-asc' ? 'nama A–Z' : filters.sort === 'stock-desc' ? 'stok terbanyak' : 'termurah'}` })
          ),
          el('span', { class: 'text-xs text-dim', text: catalog.syncedAt ? `Harga ${formatDate(catalog.syncedAt)}` : 'Belum ada timestamp' })
        ),
        el('div', { class: 'card__body' },
          grid,
          shown.length < services.length
            ? el('div', { class: 'row', attrs: { style: 'justify-content:center;margin-top:14px' } },
                Button({
                  variant: 'outline', size: 'sm', children: `Muat ${Math.min(PAGE_SIZE, services.length - shown.length)} lagi`,
                  onClick: () => { visibleCount += PAGE_SIZE; renderResults(); }
                }))
            : null
        )
      )
    );
  };

  const renderApp = (appId) => {
    activeApp = appId;
    const apps = catalog.apps || [];
    appTabs.replaceChildren(
      ...apps.map((app) => {
        const active = app.id === activeApp;
        return el('button', {
          class: `country-chip${active ? ' is-active' : ''}`,
          attrs: { type: 'button', 'aria-pressed': String(active) },
          onClick: () => { filters.query = ''; renderApp(app.id); }
        }, el('span', { class: 'row', style: { gap: '6px' } }, icon(APP_ICON[app.name] || 'smartphone', { size: 15 }), el('span', { text: app.name })));
      })
    );

    selected = null;
    renderDetail(null);
    visibleCount = PAGE_SIZE;
    renderResults();
  };

  const load = async () => {
    try {
      catalog = await api.get('/api/public/catalog');
      const settings = store.get('publicSettings') || {};
      const salesOpen = settings.operations?.salesOpen !== false;

      metaRow.replaceChildren(
        el('div', { class: 'pill-row' },
          el('span', { class: 'badge badge--brand' }, icon('layers', { size: 13 }), el('span', { text: `${formatNumber(catalog.services.length)} layanan` })),
          el('span', { class: 'badge badge--neutral' }, icon('globe', { size: 13 }), el('span', { text: `${formatNumber(catalog.countries.length)} negara` })),
          catalog.source === 'mock' ? el('span', { class: 'badge badge--warning' }, el('span', { text: 'Data demo (mock)' })) : null,
          salesOpen ? null : el('span', { class: 'badge badge--danger' }, el('span', { text: 'Penjualan ditutup sementara' }))
        ),
        catalog.syncedAt ? el('span', { class: 'text-xs text-dim', text: `Sinkron ${formatDate(catalog.syncedAt)}` }) : null
      );

      renderFilterBar();

      if (!catalog.apps.length) {
        listArea.replaceChildren(
          Alert({ tone: 'warning', title: 'Katalog belum tersedia', children: 'Sinkronisasi katalog belum berhasil. Hubungi administrator bila berlanjut.' })
        );
        return;
      }
      renderApp(catalog.apps[0].id);
    } catch (err) {
      listArea.replaceChildren(
        Alert({ tone: 'danger', title: 'Gagal memuat katalog', children: err instanceof ApiError ? err.message : 'Coba muat ulang halaman.' })
      );
    }
  };

  await load();

  return { node: shell, title: 'Layanan Nokos — FINZZ Store' };
}
