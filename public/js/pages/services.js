// ============================================================================
// SERVICES / BUY FLOW
// Guest-readable TeleKos discovery. The browser selects supplier IDs and an
// offer; the server revalidates the offer and price before atomically debiting
// the wallet. Browser-supplied prices are only a confirmation guard, never an
// amount of record.
// ============================================================================
import { el, Button, Badge, Card, Skeleton, EmptyState, Modal, Alert, toast, PageHeader, Input } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError, newIdempotencyKey } from '../api.js';
import { formatRupiah, formatNumber, formatDate } from '../store.js';

const APP_ICON = {
  WhatsApp: 'smartphoneCheck', Telegram: 'link', Google: 'globe', Instagram: 'sparkles',
  TikTok: 'play', Discord: 'users', Facebook: 'users', X: 'x', Shopee: 'inbox', Grab: 'zap'
};

const timestamp = (value) => value ? formatDate(value) : 'tidak disediakan';

export default async function services(ctx) {
  const { api, store, navigate, layout } = ctx;
  const signedIn = Boolean(store.get('user'));
  const params = new URLSearchParams(window.location.search);
  const state = {
    servers: [], server: null,
    apps: [], app: null,
    countries: [], country: null,
    offers: [], pricesMeta: null,
    loading: false,
    countrySearch: '',
    availableOnly: true,
    sort: 'price-asc',
    serverRequest: 0,
    appRequest: 0,
    countryRequest: 0,
    priceRequest: 0
  };

  const metaRow = el('div', { class: 'row row--between row--wrap' });
  const filtersArea = el('div', { class: 'filter-bar' });
  const catalogArea = el('div', { class: 'grid grid--sidebar' },
    el('div', { class: 'stack' }, Skeleton({ lines: 5 })),
    el('div', { class: 'card' }, el('div', { class: 'card__body' }, Skeleton({ lines: 4 })))
  );
  const content = el('div', { class: 'page animate-rise' },
    PageHeader({
      eyebrow: 'Katalog TeleKos',
      iconName: 'grid',
      title: 'Beli nomor virtual',
      subtitle: 'Jelajahi server, aplikasi, negara, dan penawaran. Harga dikonfirmasi ulang sebelum saldo dipotong.',
      actions: Button({
        variant: 'outline', iconName: 'wallet', children: signedIn ? 'Isi saldo' : 'Masuk untuk isi saldo',
        onClick: () => navigate(signedIn ? '/wallet' : '/login?next=%2Fwallet')
      })
    }),
    metaRow,
    filtersArea,
    catalogArea
  );

  const shell = signedIn
    ? appShell(layout, 'services', content).shell
    : el('div', { class: 'app-shell' },
        layout.header({ variant: 'public' }),
        el('main', { class: 'main', attrs: { id: 'main' } },
          content,
          el('div', { class: 'container' }, Alert({
            tone: 'info',
            title: 'Masuk untuk membeli',
            children: 'Anda dapat melihat katalog dan harga tanpa akun. Sebelum pembelian, masuk atau daftar; konteks penawaran akan dibawa kembali dan diperiksa ulang.'
          }))
        ),
        layout.footer({ compact: true })
      );

  function renderMeta(cache = null) {
    const items = [];
    if (state.servers.length) items.push(el('span', { class: 'badge badge--brand' }, icon('server', { size: 13 }), el('span', { text: `${formatNumber(state.servers.length)} server` })));
    if (state.apps.length) items.push(el('span', { class: 'badge badge--neutral' }, icon('layers', { size: 13 }), el('span', { text: `${formatNumber(state.apps.length)} aplikasi` })));
    if (cache?.source === 'mock') items.push(el('span', { class: 'badge badge--warning' }, el('span', { text: 'Data demo (mock)' })));
    if (cache?.source === 'telekos') items.push(el('span', { class: 'badge badge--success' }, el('span', { text: 'Sumber TeleKos' })));
    metaRow.replaceChildren(
      el('div', { class: 'pill-row' }, ...items),
      cache?.fetchedAt
        ? el('span', { class: 'text-xs text-dim', text: `Respons diterima ${timestamp(cache.fetchedAt)}${cache.cacheHit ? ' · dari cache' : ''}` })
        : null
    );
  }

  function renderControls() {
    if (!state.servers.length) {
      filtersArea.replaceChildren(Alert({ tone: 'warning', title: 'Server belum tersedia', children: 'Supplier belum mengembalikan data server yang dapat ditampilkan.' }));
      return;
    }

    const serverSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Pilih server' },
      onChange: (event) => loadApps(event.target.value)
    }, ...state.servers.map((server) => el('option', {
      attrs: { value: server.id, selected: String(server.id) === String(state.server) ? '' : null },
      text: `${server.name}${server.maintenance ? ' · maintenance' : !server.available ? ' · tidak tersedia' : ''}`
    })));

    const appSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Pilih aplikasi', disabled: !state.apps.length },
      onChange: (event) => loadCountries(event.target.value)
    },
      el('option', { attrs: { value: '' }, text: state.apps.length ? 'Pilih aplikasi' : 'Memuat aplikasi…' }),
      ...state.apps.map((app) => el('option', {
        attrs: { value: app.id, selected: String(app.id) === String(state.app) ? '' : null },
        text: app.name
      }))
    );

    const search = el('input', {
      class: 'input',
      attrs: { type: 'search', placeholder: 'Cari negara, ISO, atau kode telepon', 'aria-label': 'Cari negara' },
      onInput: (event) => { state.countrySearch = event.target.value; renderCountries(); }
    });
    search.value = state.countrySearch;

    const sortSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': 'Urutkan penawaran' },
      onChange: (event) => { state.sort = event.target.value; renderOffers(); }
    },
      ...[['price-asc', 'Harga termurah'], ['price-desc', 'Harga termahal'], ['stock-desc', 'Stok terbanyak']]
        .map(([value, label]) => el('option', { attrs: { value, selected: value === state.sort ? '' : null }, text: label }))
    );

    const availableToggle = el('label', { class: 'row', attrs: { style: 'gap:8px;align-items:center' } },
      el('input', {
        attrs: { type: 'checkbox', checked: state.availableOnly ? '' : null },
        onChange: (event) => { state.availableOnly = event.target.checked; renderCountries(); renderOffers(); }
      }),
      el('span', { class: 'text-sm text-muted', text: 'Hanya tampilkan stok tersedia' })
    );

    filtersArea.replaceChildren(
      el('div', { class: 'filter-bar__fields' }, serverSelect, appSelect, search, sortSelect, availableToggle)
    );
  }

  function countryList() {
    const query = state.countrySearch.trim().toLowerCase();
    return state.countries.filter((country) => {
      if (state.availableOnly && !(country.stock > 0)) return false;
      if (!query) return true;
      return `${country.name || ''} ${country.iso || ''} ${country.callingCode || ''}`.toLowerCase().includes(query);
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));
  }

  function renderCountries() {
    if (!state.app) {
      catalogArea.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'card__body' }, EmptyState({
          title: 'Pilih aplikasi', description: 'Negara dan penawaran akan dimuat dari supplier setelah aplikasi dipilih.', iconName: 'grid'
        }))),
        el('div', { class: 'card' }, el('div', { class: 'card__body' }, EmptyState({
          title: 'Belum ada penawaran dipilih', description: 'Pilih aplikasi lalu negara untuk memeriksa harga.', iconName: 'globe'
        })))
      );
      return;
    }

    const countries = countryList();
    const listCard = el('div', { class: 'card' },
      el('header', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: `${state.apps.find((app) => String(app.id) === String(state.app))?.name || state.app} · pilih negara` }),
          el('p', { class: 'card__subtitle', text: `${formatNumber(countries.length)} dari ${formatNumber(state.countries.length)} negara ditampilkan` })
        ),
        state.countriesMeta?.fetchedAt ? el('span', { class: 'text-xs text-dim', text: `Respons ${timestamp(state.countriesMeta.fetchedAt)}` }) : null
      ),
      el('div', { class: 'card__body' }, countries.length
        ? el('div', { class: 'country-grid' }, ...countries.map((country) => {
            const active = String(country.id) === String(state.country);
            return el('button', {
              class: 'country-chip',
              attrs: { type: 'button', 'aria-pressed': String(active) },
              onClick: () => loadPrices(country.id)
            },
              el('span', { class: 'stack', style: { gap: '2px' } },
                el('span', { text: country.name }),
                el('span', { class: 'country-chip__stock', text: [country.iso, country.callingCode].filter(Boolean).join(' · ') || '—' })
              ),
              el('span', { class: 'country-chip__stock', text: `${formatNumber(country.stock)} stok` })
            );
          }))
        : EmptyState({
            title: 'Tidak ada negara yang cocok',
            description: 'Ubah pencarian atau matikan filter stok untuk menampilkan semua data negara.',
            iconName: 'search'
          })
      )
    );

    const offersCard = el('div', { class: 'card' });
    renderOffers(offersCard);
    catalogArea.replaceChildren(listCard, offersCard);
  }

  function renderOffers(target = null) {
    const offersCard = target || catalogArea.children[1];
    if (!offersCard) return;
    if (!state.country) {
      offersCard.replaceChildren(el('div', { class: 'card__body' }, EmptyState({
        title: 'Pilih negara', description: 'Semua penawaran yang dikembalikan untuk negara terpilih akan tampil di sini.', iconName: 'globe'
      })));
      return;
    }

    const country = state.countries.find((item) => String(item.id) === String(state.country));
    const app = state.apps.find((item) => String(item.id) === String(state.app));
    const head = el('header', { class: 'card__head' },
      el('div', {},
        el('h2', { class: 'card__title', text: `${app?.name || state.app} · ${country?.name || state.country}` }),
        el('p', { class: 'card__subtitle', text: state.pricesMeta?.providerQuotedAt
          ? `Waktu quote supplier: ${timestamp(state.pricesMeta.providerQuotedAt)}`
          : state.pricesMeta?.fetchedAt
            ? `Waktu respons aplikasi: ${timestamp(state.pricesMeta.fetchedAt)} · supplier tidak memberi timestamp quote`
            : 'Memeriksa harga…' })
      ),
      Button({ variant: 'ghost', size: 'sm', iconName: 'refresh', children: 'Perbarui harga', onClick: () => loadPrices(state.country, { refresh: true }) })
    );

    const body = el('div', { class: 'card__body stack' });
    if (state.pricesMeta?.stale) {
      body.append(Alert({
        tone: 'warning',
        title: 'Menampilkan cache lama',
        children: state.pricesMeta.lastError
          ? `Supplier tidak dapat dihubungi (${state.pricesMeta.lastError}). Harga ini belum dikonfirmasi ulang.`
          : 'Data harga melewati masa cache. Perbarui harga sebelum melanjutkan.'
      }));
    }
    if (state.loading) {
      body.append(Skeleton({ lines: 4 }));
    } else {
      const offers = sortedOffers();
      if (!offers.length) {
        body.append(EmptyState({
          title: 'Tidak ada penawaran',
          description: 'Supplier belum mengembalikan offer yang valid untuk pilihan ini.',
          iconName: 'inbox'
        }));
      } else {
        body.append(el('div', { class: 'stack', style: { gap: '8px' } }, ...offers.map((offer, index) => {
          const available = offer.stock > 0 && state.serverRow?.available && !state.serverRow?.maintenance;
          const row = el('div', { class: 'copy-field', style: { justifyContent: 'space-between', gap: '12px' } },
            el('span', { class: 'stack', style: { gap: '3px' } },
              el('strong', { class: 'mono', text: formatRupiah(offer.salePrice) }),
              el('span', { class: 'text-xs text-dim', text: `Offer ${index + 1} · stok ${formatNumber(offer.stock)}` })
            ),
            available
              ? (signedIn
                  ? Button({ variant: 'primary', size: 'sm', iconName: 'zap', children: 'Pilih', onClick: () => openConfirm(offer) })
                  : Button({ variant: 'outline', size: 'sm', iconName: 'login', children: 'Masuk untuk membeli', onClick: () => goToLogin(offer) }))
              : Badge({ tone: 'warning', children: offer.stock <= 0 ? 'Stok kosong' : 'Tidak tersedia' })
          );
          return row;
        })));
      }
    }
    if (state.pricesMeta?.fetchedAt) {
      body.append(el('p', { class: 'text-xs text-dim', text: `Respons diterima ${timestamp(state.pricesMeta.fetchedAt)}${state.pricesMeta.cacheHit ? ' dari cache lokal' : ''}. Harga penjualan diurutkan berdasarkan nilai numerik.` }));
    }
    offersCard.replaceChildren(head, body);
  }

  function sortedOffers() {
    const offers = state.offers.slice();
    if (state.availableOnly) {
      // Keep valid zero-stock offers visible only when the caller explicitly
      // disables the stock filter; by default they remain available in data.
      const stocked = offers.filter((offer) => offer.stock > 0);
      offers.splice(0, offers.length, ...stocked);
    }
    if (state.sort === 'price-desc') offers.sort((a, b) => Number(b.salePrice) - Number(a.salePrice));
    else if (state.sort === 'stock-desc') offers.sort((a, b) => Number(b.stock) - Number(a.stock));
    else offers.sort((a, b) => Number(a.salePrice) - Number(b.salePrice));
    return offers;
  }

  function goToLogin(offer) {
    const next = new URL('/services', window.location.origin);
    next.searchParams.set('server', String(state.server));
    next.searchParams.set('app', String(state.app));
    next.searchParams.set('country', String(state.country));
    if (offer?.offerId) next.searchParams.set('offer', String(offer.offerId));
    navigate(`/login?next=${encodeURIComponent(`${next.pathname}${next.search}`)}`);
  }

  function quoteUrl(offer) {
    const query = new URLSearchParams({
      server: String(state.server),
      app: String(state.app),
      country: String(state.country),
      offer_id: String(offer.offerId)
    });
    return `/api/public/quote?${query.toString()}`;
  }

  function openConfirm(offer) {
    const idempotencyKey = newIdempotencyKey('ord');
    const country = state.countries.find((item) => String(item.id) === String(state.country));
    const app = state.apps.find((item) => String(item.id) === String(state.app));
    const quoteArea = el('div', {}, Skeleton({ lines: 3 }));
    const errorArea = el('div');
    let currentQuote = null;
    let modal;
    const confirmButton = Button({
      variant: 'primary', size: 'lg', children: 'Konfirmasi & potong saldo', disabled: true,
      onClick: async () => {
        if (!currentQuote || confirmButton.dataset.loading === '1') return;
        confirmButton.dataset.loading = '1';
        confirmButton.disabled = true;
        confirmButton.replaceChildren(el('span', { class: 'btn__spinner' }), el('span', { text: 'Memeriksa & memproses…' }));
        errorArea.replaceChildren();
        try {
          const result = await api.post('/api/orders', {
            server_id: state.server,
            app_id: state.app,
            country_id: Number(state.country),
            offer_id: offer.offerId,
            expected_price: currentQuote.price,
            idempotency_key: idempotencyKey
          });
          modal.close();
          if (result.balance !== null && result.balance !== undefined) store.set({ balance: result.balance });
          if (result.pending) {
            toast({ type: 'info', title: 'Sedang dikonfirmasi', message: result.notice?.message || 'Order sedang dikonfirmasi ke supplier.' });
          } else {
            toast({ type: 'success', title: 'Order dibuat', message: 'Nomor sedang disiapkan. OTP hanya tersedia di dashboard akun Anda.' });
          }
          navigate(`/orders?id=${result.order.id}`);
        } catch (err) {
          errorArea.replaceChildren(Alert({
            tone: 'danger',
            title: err?.code === 'PRICE_CHANGED' || err?.code === 'OFFER_STALE' ? 'Penawaran berubah' : 'Pembelian belum berhasil',
            children: err instanceof ApiError ? err.message : 'Coba periksa kembali penawaran.'
          }));
          if (['PRICE_CHANGED', 'OFFER_STALE', 'OUT_OF_STOCK'].includes(err?.code)) {
            currentQuote = null;
            quoteArea.replaceChildren(
              Button({ variant: 'outline', children: 'Periksa ulang harga', onClick: () => refreshQuote() })
            );
          }
        } finally {
          confirmButton.dataset.loading = '0';
          confirmButton.disabled = !currentQuote || !signedIn || currentQuote.stock <= 0
            || (currentQuote.source !== 'mock' && !(currentQuote.source === 'telekos' && currentQuote.live === true));
          confirmButton.replaceChildren(el('span', { text: 'Konfirmasi & potong saldo' }));
        }
      }
    });

    async function refreshQuote() {
      quoteArea.replaceChildren(Skeleton({ lines: 3 }));
      errorArea.replaceChildren();
      confirmButton.disabled = true;
      currentQuote = null;
      try {
        const quote = await api.get(quoteUrl(offer));
        currentQuote = quote;
        const rows = [
          ['Harga saat ini', formatRupiah(quote.price)],
          ['Stok offer', formatNumber(quote.stock)],
          ['Server', state.serverRow?.name || state.server]
        ];
        const mockSource = quote.source === 'mock';
        const supplierConfirmed = quote.source === 'telekos' && quote.live === true;
        const freshnessText = mockSource
          ? 'Data fixture mock; bukan harga supplier produksi.'
          : supplierConfirmed
            ? 'Respons supplier berhasil dikonfirmasi ulang untuk penawaran ini.'
            : quote.cache?.stale
              ? `Data cache stale${Number.isFinite(quote.cache.ageSeconds) ? ` (${quote.cache.ageSeconds} dtk)` : ''}; pembelian dinonaktifkan sampai supplier mengonfirmasi.`
              : 'Harga belum dikonfirmasi oleh supplier; pembelian dinonaktifkan.';
        quoteArea.replaceChildren(
          Card({
            title: mockSource ? 'Harga demo (mock)' : supplierConfirmed ? 'Harga supplier dikonfirmasi' : 'Harga belum dikonfirmasi',
            subtitle: freshnessText
          },
            el('div', { class: 'stack', style: { gap: '8px' } }, ...rows.map(([label, value]) =>
              el('div', { class: 'row row--between' }, el('span', { class: 'text-sm text-muted', text: label }), el('strong', { class: 'text-sm mono', text: value }))
            )),
            quote.cache?.fetchedAt ? el('p', { class: 'text-xs text-dim', text: `Katalog diperoleh: ${timestamp(quote.cache.fetchedAt)}` }) : null,
            quote.quotedAt ? el('p', { class: 'text-xs text-dim', text: `Waktu quote supplier: ${timestamp(quote.quotedAt)}` }) : null
          )
        );
        confirmButton.disabled = !signedIn || quote.stock <= 0 || (!mockSource && !supplierConfirmed);
      } catch (err) {
        quoteArea.replaceChildren(Alert({ tone: 'warning', title: 'Harga belum dapat dikonfirmasi', children: err instanceof ApiError ? err.message : 'Coba muat ulang harga.' }));
      }
    }

    const modalBody = el('div', { class: 'stack' },
      el('div', { class: 'row' },
        el('span', { class: 'service-card__logo' }, icon(APP_ICON[app?.name] || 'smartphone', { size: 18 })),
        el('div', {},
          el('div', { class: 'service-card__name', text: `${app?.name || state.app} · ${country?.name || state.country}` }),
          el('div', { class: 'service-card__meta', text: `Penawaran supplier ${offer.offerId} · stok ${formatNumber(offer.stock)}` })
        )
      ),
      quoteArea,
      errorArea,
      signedIn ? el('p', { class: 'text-xs text-dim', text: `Saldo tersedia ${formatRupiah(store.get('balance') ?? 0)}. Harga akan divalidasi lagi oleh server sebelum pemotongan saldo.` }) : null,
      el('p', { class: 'text-xs text-dim', text: 'Jika supplier menolak order secara pasti, saldo dikembalikan. Hasil yang belum pasti tetap direkonsiliasi; jangan membuat order pengganti.' })
    );
    modal = Modal({
      title: 'Konfirmasi pembelian',
      body: modalBody,
      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), confirmButton]
    });
    refreshQuote();
  }

  async function loadPrices(countryId, { refresh = false } = {}) {
    state.country = Number(countryId);
    state.offers = [];
    state.pricesMeta = null;
    state.loading = true;
    const request = ++state.priceRequest;
    renderCountries();
    try {
      const query = new URLSearchParams({ server: String(state.server), app: String(state.app), country: String(state.country) });
      if (refresh) query.set('refresh', '1');
      const result = await api.get(`/api/public/catalog/prices?${query.toString()}`);
      if (request !== state.priceRequest) return;
      state.offers = result.offers || [];
      state.pricesMeta = result.cache || null;
      state.loading = false;
      state.serverRow = result.server;
      renderMeta(result.cache);
      renderCountries();
      const wantedOffer = params.get('offer');
      if (wantedOffer) {
        const matched = state.offers.find((item) => item.offerId === wantedOffer);
        params.delete('offer');
        if (matched && signedIn) {
          // The modal revalidates again; a stale deep link cannot buy directly.
          openConfirm(matched);
        } else if (!matched) {
          toast({ type: 'warning', title: 'Penawaran lama tidak tersedia', message: 'Pilih salah satu harga yang tersedia sekarang.' });
        }
      }
    } catch (err) {
      if (request !== state.priceRequest) return;
      state.loading = false;
      state.pricesMeta = { stale: false };
      renderCountries();
      toast({ type: 'error', title: 'Harga tidak tersedia', message: err instanceof ApiError ? err.message : 'Coba muat ulang harga.' });
    }
  }

  async function loadCountries(appId) {
    state.app = appId || null;
    state.country = null;
    state.offers = [];
    state.pricesMeta = null;
    state.countries = [];
    renderControls();
    if (!state.app) return renderCountries();
    const request = ++state.countryRequest;
    try {
      const query = new URLSearchParams({ server: String(state.server), app: String(state.app) });
      const result = await api.get(`/api/public/catalog/countries?${query.toString()}`);
      if (request !== state.countryRequest) return;
      state.countries = result.countries || [];
      state.countriesMeta = result.cache || null;
      renderMeta(result.cache);
      renderControls();
      renderCountries();
      const deepCountry = params.get('country');
      if (deepCountry && state.countries.some((country) => String(country.id) === String(deepCountry))) {
        await loadPrices(deepCountry);
      }
    } catch (err) {
      if (request !== state.countryRequest) return;
      catalogArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat negara', children: err instanceof ApiError ? err.message : 'Coba muat ulang.' }));
    }
  }

  async function loadApps(serverId) {
    state.server = serverId || null;
    state.app = null;
    state.country = null;
    state.apps = [];
    state.countries = [];
    state.offers = [];
    state.pricesMeta = null;
    renderControls();
    if (!state.server) return renderCountries();
    const request = ++state.appRequest;
    try {
      const query = new URLSearchParams({ server: String(state.server) });
      const result = await api.get(`/api/public/catalog/apps?${query.toString()}`);
      if (request !== state.appRequest) return;
      state.apps = result.apps || [];
      renderMeta(result.cache);
      renderControls();
      const deepApp = params.get('app');
      const chosen = state.apps.find((app) => String(app.id) === String(deepApp)) || state.apps[0];
      if (chosen) await loadCountries(chosen.id);
      else renderCountries();
    } catch (err) {
      if (request !== state.appRequest) return;
      catalogArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat aplikasi', children: err instanceof ApiError ? err.message : 'Coba muat ulang.' }));
    }
  }

  async function loadServers() {
    const request = ++state.serverRequest;
    try {
      const result = await api.get('/api/public/catalog/servers');
      if (request !== state.serverRequest) return;
      state.servers = result.servers || [];
      renderMeta(result.cache);
      renderControls();
      const wanted = params.get('server');
      const chosen = state.servers.find((server) => String(server.id) === String(wanted))
        || state.servers.find((server) => server.available && !server.maintenance)
        || state.servers[0];
      if (chosen) {
        state.serverRow = chosen;
        await loadApps(chosen.id);
      } else {
        renderCountries();
      }
    } catch (err) {
      catalogArea.replaceChildren(Alert({
        tone: 'danger', title: 'Katalog TeleKos tidak tersedia',
        children: err instanceof ApiError ? err.message : 'Supplier belum mengembalikan data. Coba muat ulang halaman.'
      }));
    }
  }

  loadServers();
  return { node: shell, title: 'Katalog layanan — FINZZ Store' };
}
