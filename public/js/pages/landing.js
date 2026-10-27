// ============================================================================
// LANDING PAGE (public)
// Every number on this page comes from the API: real catalogue data when the
// supplier is reachable, an explicit "data belum tersedia" state otherwise.
// ============================================================================
import { el } from '../ui.js';
import { icon } from '../icons.js';
import { marqueeBrands, splitRows } from '../brands.js';
import { formatRupiah, formatNumber, formatDate } from '../store.js';

const HERO_ART = `
<svg viewBox="0 0 420 380" role="img" aria-label="Ilustrasi nomor virtual dan kode OTP" class="hero-art">
  <defs>
    <linearGradient id="heroCard" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c8cff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#2ee6b6" stop-opacity="0.12"/>
    </linearGradient>
    <linearGradient id="heroScreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c8cff"/>
      <stop offset="1" stop-color="#2ee6b6"/>
    </linearGradient>
  </defs>
  <rect x="30" y="24" width="360" height="330" rx="26" fill="url(#heroCard)" stroke="rgba(148,163,198,0.22)"/>
  <rect x="128" y="52" width="164" height="286" rx="28" fill="#0d1220" stroke="rgba(148,163,198,0.28)"/>
  <rect x="140" y="64" width="140" height="262" rx="20" fill="#111726"/>
  <rect x="176" y="72" width="68" height="7" rx="3.5" fill="rgba(148,163,198,0.35)"/>
  <rect x="152" y="98" width="116" height="34" rx="10" fill="rgba(124,140,255,0.18)" stroke="rgba(124,140,255,0.4)"/>
  <text x="210" y="120" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13" fill="#a9baff">+62 812 •••• 4471</text>
  <rect x="152" y="146" width="52" height="8" rx="4" fill="rgba(148,163,198,0.24)"/>
  <rect x="152" y="164" width="116" height="60" rx="12" fill="rgba(46,230,182,0.12)" stroke="rgba(46,230,182,0.38)"/>
  <text x="210" y="192" text-anchor="middle" font-family="ui-monospace, monospace" font-size="20" letter-spacing="6" fill="#6ff0cd">481 902</text>
  <text x="210" y="210" text-anchor="middle" font-family="Inter, sans-serif" font-size="9" fill="#6ff0cd" opacity="0.75">WhatsApp · OTP diterima</text>
  <rect x="152" y="238" width="116" height="8" rx="4" fill="rgba(148,163,198,0.18)"/>
  <rect x="152" y="254" width="86" height="8" rx="4" fill="rgba(148,163,198,0.14)"/>
  <rect x="152" y="286" width="116" height="30" rx="9" fill="url(#heroScreen)" opacity="0.9"/>
  <text x="210" y="305" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" font-weight="600" fill="#07120f">Selesai</text>
  <g opacity="0.95">
    <rect x="252" y="150" width="128" height="52" rx="12" fill="#0f1420" stroke="rgba(148,163,198,0.28)"/>
    <circle cx="274" cy="170" r="9" fill="rgba(46,230,182,0.2)" stroke="rgba(46,230,182,0.5)"/>
    <path d="m270 170 3 3 5-6" stroke="#2ee6b6" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <rect x="290" y="163" width="70" height="6" rx="3" fill="rgba(148,163,198,0.35)"/>
    <rect x="290" y="176" width="48" height="6" rx="3" fill="rgba(148,163,198,0.2)"/>
    <rect x="252" y="212" width="128" height="52" rx="12" fill="#0f1420" stroke="rgba(148,163,198,0.28)"/>
    <circle cx="274" cy="232" r="9" fill="rgba(124,140,255,0.2)" stroke="rgba(124,140,255,0.5)"/>
    <path d="M270 232h8M274 228v8" stroke="#7c8cff" stroke-width="1.8" stroke-linecap="round"/>
    <rect x="290" y="225" width="62" height="6" rx="3" fill="rgba(148,163,198,0.35)"/>
    <rect x="290" y="238" width="40" height="6" rx="3" fill="rgba(148,163,198,0.2)"/>
  </g>
  <circle cx="70" cy="86" r="4" fill="#2ee6b6" opacity="0.7"/>
  <circle cx="358" cy="300" r="5" fill="#7c8cff" opacity="0.6"/>
  <circle cx="84" cy="286" r="3" fill="#b18cff" opacity="0.7"/>
</svg>`;

const APPS_ICON = {
  WhatsApp: 'smartphoneCheck',
  Telegram: 'link',
  Google: 'globe',
  Instagram: 'sparkles',
  TikTok: 'play',
  Discord: 'users',
  Facebook: 'users',
  X: 'x',
  Shopee: 'inbox',
  Grab: 'zap'
};

function sectionHead(title, lead, { center = false, eyebrow = 'FINZZ Store' } = {}) {
  return el(
    'div',
    { class: `section__head animate-rise${center ? ' section__head--center' : ''}` },
    el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: eyebrow })),
    el('h2', { class: 'section__title', style: { marginTop: '14px' }, text: title }),
    lead ? el('p', { class: 'section__lead', text: lead }) : null
  );
}

const FEATURES = [
  { icon: 'zap', tone: 'brand', title: 'Nomor terbit instan', text: 'Order diteruskan ke supplier begitu saldo cukup. Nomor aktif dalam hitungan detik tanpa proses manual.' },
  { icon: 'smartphoneCheck', tone: 'mint', title: 'OTP tampil sendiri', text: 'Kode verifikasi ditarik otomatis dan muncul di dashboard serta notifikasi, tanpa memuat ulang halaman.' },
  { icon: 'wallet', tone: 'violet', title: 'Ledger yang bisa diaudit', text: 'Setiap debit, kredit, dan refund berpasangan di buku besar. Saldo tidak pernah berubah tanpa jejak.' },
  { icon: 'refresh', tone: 'info', title: 'Refund otomatis', text: 'Order tanpa OTP ditutup sistem dan dananya kembali ke dompet Anda, dicatat maksimal sekali per order.' },
  { icon: 'shield', tone: 'warning', title: 'Akun terlindungi', text: 'Password Argon2id, sesi HttpOnly, token CSRF, dan pembatas laju percobaan login.' },
  { icon: 'activity', tone: 'brand', title: 'Status apa adanya', text: 'Halaman status menampilkan kondisi supplier dan pembayaran yang sebenarnya, termasuk saat gangguan.' }
];

export default async function landing(ctx) {
  const { api, store, navigate, layout } = ctx;
  const shell = el('div', { class: 'app-shell' });
  shell.appendChild(layout.header({ variant: 'public' }));

  const main = el('main', { attrs: { id: 'main' } });
  shell.appendChild(main);

  // ------------------------------------------------------------------ hero
  const hero = el(
    'section',
    { class: 'hero' },
    el(
      'div',
      { class: 'container hero__grid' },
      el(
        'div',
        {},
        el('span', { class: 'hero__eyebrow' }, icon('sparkles', { size: 14 }), el('span', { text: 'Nomor virtual untuk verifikasi akun' })),
        el('h1', { class: 'hero__title' }, el('span', { text: 'Verifikasi akun tanpa ' }), el('span', { class: 'gradient-text', text: 'nomor pribadi' })),
        el('p', {
          class: 'hero__lead',
          text: 'Beli nomor virtual (nokos) untuk WhatsApp, Telegram, Google, dan layanan lain. Nomor diterbitkan langsung oleh supplier, OTP muncul otomatis di dashboard Anda, dan saldo tercatat rapi di ledger.'
        }),
        el(
          'div',
          { class: 'hero__cta' },
          el('a', {
            class: 'btn btn--primary btn--lg',
            attrs: { href: store.get('user') ? '/dashboard' : '/register' },
            text: store.get('user') ? 'Buka Dashboard' : 'Daftar Sekarang',
            onClick: (e) => { e.preventDefault(); navigate(store.get('user') ? '/dashboard' : '/register'); }
          }),
          el('a', {
            class: 'btn btn--outline btn--lg',
            attrs: { href: '#cara-kerja' },
            onClick: (e) => { e.preventDefault(); document.getElementById('cara-kerja')?.scrollIntoView({ behavior: 'smooth' }); }
          }, el('span', { text: 'Lihat cara kerja' }), icon('arrowRight', { size: 17 }))
        ),
        el(
          'div',
          { class: 'hero__meta', attrs: { id: 'hero-meta' } },
          el('div', { class: 'hero__meta-item' },
            el('span', { class: 'hero__meta-value', text: '—', attrs: { 'data-stat': 'services' } }),
            el('span', { class: 'hero__meta-label', text: 'layanan aktif' })),
          el('div', { class: 'hero__meta-item' },
            el('span', { class: 'hero__meta-value', text: '—', attrs: { 'data-stat': 'countries' } }),
            el('span', { class: 'hero__meta-label', text: 'negara tersedia' })),
          el('div', { class: 'hero__meta-item' },
            el('span', { class: 'hero__meta-value', text: '—', attrs: { 'data-stat': 'apps' } }),
            el('span', { class: 'hero__meta-label', text: 'aplikasi' })),
          el('div', { class: 'hero__meta-item' },
            el('span', { class: 'hero__meta-value', text: '1×', attrs: { 'data-stat': 'refund' } }),
            el('span', { class: 'hero__meta-label', text: 'refund otomatis tanpa OTP' }))
        )
      ),
      el('div', { class: 'hero__art hero-art-wrap' },
        el('div', { class: 'float-chip float-chip--tl' }, icon('check', { size: 14 }), el('span', { text: 'OTP masuk otomatis' })),
        el('div', { class: 'float-chip float-chip--br' }, icon('refresh', { size: 14 }), el('span', { text: 'Refund tanpa OTP' })),
        el('div', { html: HERO_ART })
      )
    )
  );
  main.appendChild(hero);

  // ---------------------------------------------------------- logo marquee
  // Rendered from the live catalogue: the strip only ever shows apps that can
  // actually be bought. Until data arrives the section stays hidden (no layout
  // shift, no invented logos).
  const marqueeSection = el('section', {
    class: 'brand-marquee',
    attrs: { 'aria-label': 'Merek yang tersedia di katalog layanan', hidden: '' }
  });
  main.appendChild(marqueeSection);

  const listBrands = (apps) => {
    const brands = marqueeBrands(apps);
    if (brands.length < 4) return;
    marqueeSection.removeAttribute('hidden');
    const rows = splitRows(brands, 2);
    marqueeSection.replaceChildren(
      ...rows.map((row, index) => {
        const track = el('div', { class: `brand-marquee__track brand-marquee__track--${index % 2 === 0 ? 'left' : 'right'}` });
        // A second, assistive-tech-hidden visual copy creates the seamless loop.
        // `row` itself is deduplicated by app id, so no extra service/inventory
        // is introduced by the animation.
        const group = (hiddenCopy) => el('div', {
          class: 'brand-marquee__group',
          attrs: hiddenCopy ? { 'aria-hidden': 'true' } : {}
        }, row.map((brand, itemIndex) => {
          const content = brand.src
            ? [
                el('img', { class: 'brand-chip__logo', attrs: { src: brand.src, alt: '', width: '22', height: '22', loading: 'lazy', decoding: 'async' } }),
                el('span', { class: 'brand-chip__label', text: brand.label })
              ]
            : [el('span', { class: 'brand-chip__wordmark', text: brand.label })];
          return el('span', {
            class: 'brand-chip',
            attrs: { title: brand.label },
            style: { '--float-delay': `${(itemIndex % 5) * -0.55}s` }
          }, content);
        }));
        track.replaceChildren(group(false), group(true));
        return el('div', { class: 'brand-marquee__row' }, track);
      })
    );
  };

  // ------------------------------------------------------------- features
  main.appendChild(
    el('section', { class: 'section', attrs: { id: 'fitur' } },
      el('div', { class: 'container' },
        sectionHead('Mengapa penjual memilih FINZZ Store', 'Enam alasan yang semuanya bisa Anda verifikasi sendiri lewat halaman status, keamanan, dan panduan bantuan.', { center: true, eyebrow: 'Keunggulan' }),
        el('div', { class: 'grid grid--3' },
          FEATURES.map((feature, i) =>
            el('div', { class: 'feature-card lift animate-rise', style: { '--d': `${(i % 3) * 80}ms` } },
              el('span', { class: `feature-tile feature-tile--${feature.tone}` }, icon(feature.icon, { size: 20 })),
              el('h3', { text: feature.title }),
              el('p', { class: 'text-muted', text: feature.text })
            )
          )
        ),
        el('div', { class: 'row row--wrap', style: { justifyContent: 'center', marginTop: '32px', gap: '12px' } },
          el('a', {
            class: 'btn btn--outline',
            attrs: { href: '/keamanan' },
            text: 'Baca praktik keamanan',
            onClick: (e) => { e.preventDefault(); navigate('/keamanan'); }
          }, icon('shield', { size: 16 })),
          el('a', {
            class: 'btn btn--ghost',
            attrs: { href: '/bantuan' },
            text: 'Pusat bantuan',
            onClick: (e) => { e.preventDefault(); navigate('/bantuan'); }
          }, icon('arrowRight', { size: 16 }))
        )
      )
    )
  );

  // -------------------------------------------------------------- catalogue
  const catalogSection = el('section', { class: 'section', attrs: { id: 'layanan' } });
  catalogSection.appendChild(
    el('div', { class: 'container' },
      sectionHead(
        'Katalog layanan dan negara',
        'Daftar di bawah dimuat langsung dari katalog supplier yang tersinkron. Harga sudah termasuk markup layanan; stok dapat berubah setiap saat.',
        { eyebrow: 'Katalog' }
      ),
      el('div', { attrs: { id: 'catalog-body' } }, el('div', { class: 'skeleton skeleton-block' }))
    )
  );
  main.appendChild(catalogSection);

  // --------------------------------------------------------------- workflow
  const steps = [
    { title: 'Daftar & isi saldo', text: 'Buat akun, lalu ajukan deposit manual. Admin memverifikasi bukti transfer sebelum saldo dikreditkan.' },
    { title: 'Pilih aplikasi & negara', text: 'Harga dan ketersediaan diambil dari supplier saat Anda memilih. Tidak ada harga yang dikarang.' },
    { title: 'Nomor diterbitkan', text: 'Saldo dipotong satu kali saat order dibuat. Nomor tampil di dashboard dan bisa langsung dipakai.' },
    { title: 'OTP otomatis', text: 'Kode verifikasi muncul di halaman order. Order tanpa OTP akan berakhir dan saldo dikembalikan otomatis.' }
  ];
  main.appendChild(
    el('section', { class: 'section section--alt', attrs: { id: 'cara-kerja' } },
      el('div', { class: 'container' },
        sectionHead('Empat langkah, tanpa aplikasi tambahan', 'Semua berjalan di browser: order, nomor, OTP, dan riwayat saldo.', { eyebrow: 'Cara kerja' }),
        el('div', { class: 'step-list' }, steps.map((s) => el('div', { class: 'step' }, el('h4', { text: s.title }), el('p', { text: s.text }))))
      )
    )
  );

  // --------------------------------------------------------------- policies
  main.appendChild(
    el('section', { class: 'section', attrs: { id: 'kebijakan' } },
      el('div', { class: 'container' },
        sectionHead('Kebijakan saldo, deposit, dan refund', 'Aturan ini berlaku pada setiap transaksi dan ditegakkan oleh sistem, bukan hanya oleh admin.', { eyebrow: 'Kebijakan' }),
        el('div', { class: 'grid grid--3' },
          el('div', { class: 'card' },
            el('div', { class: 'card__body' },
              el('div', { class: 'row' }, icon('wallet', { size: 18 }), el('h3', { class: 'card__title', text: 'Saldo & deposit' })),
              el('p', { class: 'text-sm text-muted', style: { marginTop: '10px' }, text: 'Deposit diproses manual dengan bukti transfer. Nominal minimum dan rekening tujuan tampil di halaman saldo setelah Anda masuk.' })
            )),
          el('div', { class: 'card' },
            el('div', { class: 'card__body' },
              el('div', { class: 'row' }, icon('refresh', { size: 18 }), el('h3', { class: 'card__title', text: 'Pembatalan' })),
              el('p', { class: 'text-sm text-muted', style: { marginTop: '10px' }, text: 'Pembatalan hanya tersedia jika supplier mengizinkannya dan belum ada OTP yang diterima. Tombol batal muncul otomatis saat syarat terpenuhi.' })
            )),
          el('div', { class: 'card' },
            el('div', { class: 'card__body' },
              el('div', { class: 'row' }, icon('shield', { size: 18 }), el('h3', { class: 'card__title', text: 'Refund' })),
              el('p', { class: 'text-sm text-muted', style: { marginTop: '10px' }, text: 'Refund otomatis penuh hanya jika nomor tidak pernah menerima OTP dan supplier menutup order. Refund tercatat di ledger dan terjadi maksimal satu kali per order.' })
            ))
        )
      )
    )
  );

  // -------------------------------------------------------------------- FAQ
  const faqs = [
    ['Apakah harga di halaman ini final?', 'Harga diambil dari katalog supplier yang tersinkron dan dapat berubah mengikuti stok. Harga final selalu ditampilkan pada konfirmasi sebelum saldo dipotong.'],
    ['Mengapa saldo harus diisi lewat deposit manual?', 'Payment gateway otomatis belum diaktifkan. Deposit manual memastikan tidak ada saldo yang masuk tanpa verifikasi bukti pembayaran.'],
    ['Apa yang terjadi jika OTP tidak kunjung datang?', 'Order berakhir sesuai batas waktu supplier. Jika tidak ada OTP yang diterima, saldo dikembalikan otomatis dan dicatat pada riwayat transaksi.'],
    ['Bisakah saya membatalkan order?', 'Bisa, selama supplier mengizinkan pembatalan dan belum ada OTP. Jika syarat belum terpenuhi, tombol batal nonaktif dan status ditampilkan apa adanya.'],
    ['Apakah nomor ini bisa dipakai berkali-kali?', 'Satu nomor untuk satu order dan satu verifikasi. Nomor dapat dipakai ulang oleh supplier lain setelah order selesai, jadi hanya gunakan untuk verifikasi yang Anda butuhkan saat itu.'],
    ['Bagaimana perlindungan data saya?', 'Password disimpan sebagai hash Argon2id dan tidak pernah dikirim kembali ke browser. Sesi memakai cookie HttpOnly; OTP hanya dapat dibaca pemilik order yang sah.']
  ];
  main.appendChild(
    el('section', { class: 'section section--alt', attrs: { id: 'faq' } },
      el('div', { class: 'container container--narrow' },
        sectionHead('Pertanyaan yang sering diajukan', null, { center: true, eyebrow: 'FAQ' }),
        el('div', { class: 'faq' },
          faqs.map(([q, a]) =>
            el('details', { class: 'faq__item' },
              el('summary', { text: q }),
              el('div', { class: 'faq__body', text: a })
            )
          )
        )
      )
    )
  );

  // -------------------------------------------------------------------- CTA
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'cta-band' },
          el('div', {},
            el('h2', { class: 'section__title', text: 'Siap mencoba FINZZ Store?' }),
            el('p', { class: 'text-muted', text: 'Buat akun, isi saldo, dan mulai verifikasi tanpa membagikan nomor pribadi Anda.' })
          ),
          el('div', { class: 'row row--wrap' },
            el('a', {
              class: 'btn btn--primary btn--lg',
              attrs: { href: '/register' },
              text: 'Daftar gratis',
              onClick: (e) => { e.preventDefault(); navigate('/register'); }
            }),
            el('a', {
              class: 'btn btn--outline btn--lg',
              attrs: { href: '/login' },
              text: 'Masuk',
              onClick: (e) => { e.preventDefault(); navigate('/login'); }
            })
          )
        )
      )
    )
  );

  shell.appendChild(layout.footer());

  // ------------------------------------------------------------ data loading
  const renderCatalog = (catalog) => {
    const body = catalogSection.querySelector('#catalog-body');
    body.replaceChildren();

    body.appendChild(
      el('div', { class: 'row row--between row--wrap', style: { marginBottom: '16px' } },
        el('div', { class: 'pill-row' },
          el('span', { class: 'badge badge--brand' }, icon('layers', { size: 13 }), el('span', { text: `${formatNumber(catalog.services.length)} layanan aktif` })),
          el('span', { class: 'badge badge--neutral' }, icon('globe', { size: 13 }), el('span', { text: `${formatNumber(catalog.countries.length)} negara` })),
          catalog.source === 'mock' ? el('span', { class: 'badge badge--warning' }, el('span', { text: 'Data demo (mock supplier)' })) : null
        ),
        catalog.syncedAt
          ? el('span', { class: 'text-xs text-dim', text: `Harga diperbarui ${formatDate(catalog.syncedAt)}` })
          : el('span', { class: 'text-xs text-dim', text: 'Waktu pembaruan harga belum tersedia' })
      )
    );

    // The marquee mirrors the catalogue that just arrived: no data, no logos.
    listBrands(catalog.apps);

    if (catalog.apps.length === 0) {
      body.appendChild(
        el('div', { class: 'alert alert--warning' },
          icon('alert', { size: 18 }),
          el('div', {},
            el('div', { class: 'alert__title', text: 'Data katalog belum tersedia' }),
            el('div', { text: 'Sinkronisasi katalog belum berhasil. Silakan periksa kembali beberapa saat lagi.' })
          )
        )
      );
      return;
    }

    // app cards
    body.appendChild(
      el('div', { class: 'grid grid--4' },
        catalog.apps.slice(0, 8).map((app) => {
          const brand = marqueeBrands([app])[0];
          return el('div', { class: 'service-card' },
            el('div', { class: 'service-card__head' },
              el('span', { class: 'service-card__logo' },
                brand?.src
                  ? el('img', { attrs: { src: brand.src, alt: '', width: '23', height: '23', loading: 'lazy', decoding: 'async' } })
                  : icon(APPS_ICON[app.name] || 'smartphone', { size: 18 })
              ),
              el('div', {},
                el('div', { class: 'service-card__name', text: app.name }),
                el('div', { class: 'service-card__meta', text: `${formatNumber(app.countryCount)} negara` })
              )
            ),
            el('div', { class: 'row row--between' },
              el('span', { class: 'service-card__price', text: formatRupiah(app.minPrice) }),
              el('span', { class: 'badge badge--success' }, el('span', { text: `${formatNumber(app.totalStock)} stok` }))
            ),
            el('span', { class: 'service-card__meta', text: 'Harga mulai dari' })
          );
        })
      )
    );

    // cheapest live rows
    const cheapest = [...catalog.services].sort((a, b) => a.price - b.price).slice(0, 6);
    body.appendChild(
      el('div', { class: 'table-wrap', style: { marginTop: '20px' } },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Layanan' }), el('th', { text: 'Negara' }), el('th', { text: 'Kode' }),
            el('th', { class: 'table__num', text: 'Stok' }), el('th', { class: 'table__num', text: 'Harga' }))),
          el('tbody', {}, cheapest.map((s) => el('tr', {},
            el('td', { text: s.appName }),
            el('td', {}, el('span', { text: s.countryName }), s.callingCode ? el('span', { class: 'text-xs text-dim', text: ` ${s.callingCode}` }) : null),
            el('td', { class: 'mono text-xs', text: s.countryIso || '—' }),
            el('td', { class: 'table__num', text: formatNumber(s.stock) }),
            el('td', { class: 'table__num', text: formatRupiah(s.price) })
          )))
        )
      )
    );
    body.appendChild(
      el('p', { class: 'text-xs text-dim', style: { marginTop: '10px' },
        text: 'Tabel menampilkan 6 layanan termurah saat ini. Daftar lengkap tersedia setelah Anda masuk ke dashboard.' })
    );
  };

  (async () => {
    try {
      const catalog = await api.get('/api/public/catalog');
      renderCatalog(catalog);
      const stats = {
        services: formatNumber(catalog.summary?.activeServices ?? catalog.services.length),
        countries: formatNumber(catalog.summary?.countries ?? catalog.countries.length),
        apps: formatNumber(catalog.summary?.apps ?? catalog.apps.length)
      };
      for (const [key, value] of Object.entries(stats)) {
        const node = hero.querySelector(`[data-stat="${key}"]`);
        if (node) node.textContent = value;
      }
    } catch (err) {
      const body = catalogSection.querySelector('#catalog-body');
      body.replaceChildren(
        el('div', { class: 'alert alert--warning' },
          icon('wifiOff', { size: 18 }),
          el('div', {},
            el('div', { class: 'alert__title', text: 'Data katalog sementara tidak tersedia' }),
            el('div', { text: 'Kami tidak menampilkan harga atau stok perkiraan. Silakan muat ulang halaman atau cek kembali nanti.' })
          )
        )
      );
      console.warn('catalog unavailable', err);
    }
  })();

  return {
    node: shell,
    title: 'FINZZ Store — Nomor Virtual Instan untuk Verifikasi Akun'
  };
}
