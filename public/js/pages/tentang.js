// ============================================================================
// ABOUT PAGE (public) — story, principles and product flow.
// Static, honest content: no invented uptime or success-rate numbers.
// ============================================================================
import { el, IconTile } from '../ui.js';
import { icon } from '../icons.js';

const PRINCIPLES = [
  {
    icon: 'shield',
    tone: 'brand',
    title: 'Privasi lebih dulu',
    text: 'Nomor pribadi Anda tidak dibagikan ke layanan yang ingin Anda daftarkan. Verifikasi berjalan lewat nomor virtual yang diterbitkan supplier.'
  },
  {
    icon: 'database',
    tone: 'mint',
    title: 'Data apa adanya',
    text: 'Harga, stok, dan status layanan diambil dari katalog supplier. Jika data tidak terbaca, halaman menuliskan "belum tersedia", bukan angka karangan.'
  },
  {
    icon: 'wallet',
    tone: 'violet',
    title: 'Saldo tercatat rapi',
    text: 'Setiap pemotongan, deposit, dan refund masuk ke ledger yang tidak bisa diubah diam-diam. Saldo tidak pernah berubah tanpa jejak transaksi.'
  },
  {
    icon: 'refresh',
    tone: 'info',
    title: 'Refund yang jujur',
    text: 'Order yang tidak pernah menerima OTP berakhir otomatis dan dananya dikembalikan ke dompet Anda, maksimal satu kali per order.'
  },
  {
    icon: 'lock',
    tone: 'warning',
    title: 'Akun terlindungi',
    text: 'Password di-hash Argon2id, sesi memakai cookie HttpOnly, dan setiap perubahan sensitif dilindungi token CSRF serta pembatas laju.'
  },
  {
    icon: 'activity',
    tone: 'brand',
    title: 'Status transparan',
    text: 'Halaman status menampilkan kondisi database, supplier, dan pembayaran yang sebenarnya — termasuk ketika sebuah layanan sedang bermasalah.'
  }
];

const FLOW = [
  { title: 'Buat akun', text: 'Daftar dengan email, verifikasi lewat kode 6 digit, lalu atur password yang kuat.' },
  { title: 'Isi saldo', text: 'Ajukan deposit dan unggah bukti transfer. Saldo masuk setelah diverifikasi admin.' },
  { title: 'Pilih layanan', text: 'Bandingkan harga dan stok WhatsApp, Telegram, dan layanan lain per negara.' },
  { title: 'Terima OTP', text: 'Nomor terbit instan, kode verifikasi muncul di halaman order dan masuk notifikasi.' }
];

export default async function about(ctx) {
  const { navigate, layout } = ctx;
  const shell = el('div', { class: 'app-shell' });
  shell.appendChild(layout.header({ variant: 'public' }));

  const main = el('main', { attrs: { id: 'main' } });

  // -------------------------------------------------------------- hero
  main.appendChild(
    el('section', { class: 'page-hero' },
      el('div', { class: 'container' },
        el('div', { class: 'page-hero__inner animate-rise' },
          el('div', { class: 'page-hero__glow' }),
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Tentang FINZZ Store' })),
          el('h1', { class: 'page__title', style: { marginTop: '18px' }, text: 'Verifikasi akun tanpa membagikan nomor pribadi' }),
          el('p', {
            class: 'page__subtitle',
            text: 'FINZZ Store adalah platform nomor virtual (nokos) yang menyatukan katalog layanan, penerbitan nomor, pengiriman OTP, dan dompet saldo dalam satu dashboard yang sederhana.'
          }),
          el('div', { class: 'hero__cta' },
            el('a', {
              class: 'btn btn--primary btn--lg',
              attrs: { href: '/register' },
              text: 'Mulai sekarang',
              onClick: (e) => { e.preventDefault(); navigate('/register'); }
            }, icon('arrowRight', { size: 17 })),
            el('a', {
              class: 'btn btn--outline btn--lg',
              attrs: { href: '/bantuan' },
              text: 'Pusat bantuan',
              onClick: (e) => { e.preventDefault(); navigate('/bantuan'); }
            })
          )
        )
      )
    )
  );

  // ----------------------------------------------------------- mission bento
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'section__head section__head--center animate-rise' },
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Yang kami percaya' })),
          el('h2', { class: 'section__title', style: { marginTop: '16px' }, text: 'Enam prinsip di setiap fitur' }),
          el('p', { class: 'section__lead', text: 'Kami lebih memilih menjelaskan keterbatasan secara jujur daripada menjanjikan metrik yang tidak bisa kami buktikan.' })
        ),
        el('div', { class: 'grid grid--3' },
          PRINCIPLES.map((item, i) =>
            el('div', { class: 'feature-card lift animate-rise', style: { '--d': `${i * 70}ms` } },
              IconTile({ name: item.icon, tone: item.tone, large: true }),
              el('h3', { text: item.title }),
              el('p', { class: 'text-muted', text: item.text })
            )
          )
        )
      )
    )
  );

  // --------------------------------------------------------------- flow
  main.appendChild(
    el('section', { class: 'section section--alt' },
      el('div', { class: 'container' },
        el('div', { class: 'section__head animate-rise' },
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Alur produk' })),
          el('h2', { class: 'section__title', style: { marginTop: '16px' }, text: 'Dari daftar sampai OTP diterima' }),
          el('p', { class: 'section__lead', text: 'Semua langkah berjalan di browser, tanpa aplikasi tambahan.' })
        ),
        el('div', { class: 'step-list' },
          FLOW.map((step, i) =>
            el('div', { class: 'step animate-rise', style: { '--d': `${i * 80}ms` } },
              el('h4', { text: step.title }),
              el('p', { text: step.text })
            )
          )
        )
      )
    )
  );

  // ------------------------------------------------------------ difference
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'bento' },
          el('div', { class: 'feature-card lift bento__span-3 animate-rise' },
            IconTile({ name: 'smartphone', tone: 'brand', large: true }),
            el('h3', { text: 'Fokus pada satu pekerjaan' }),
            el('p', { class: 'text-muted', text: 'Kami tidak mencoba menjadi segala macam aplikasi. FINZZ Store dirancang khusus untuk satu alur: menemukan nomor virtual, menerbitkannya, dan mengantarkan OTP dengan andal.' }),
            el('a', { class: 'feature-card__link', attrs: { href: '/services' }, text: 'Lihat katalog layanan', onClick: (e) => { e.preventDefault(); navigate('/services'); } }, icon('arrowRight', { size: 15 }))
          ),
          el('div', { class: 'feature-card lift bento__span-3 animate-rise', style: { '--d': '90ms' } },
            IconTile({ name: 'server', tone: 'mint', large: true }),
            el('h3', { text: 'Arsitektur yang terbuka untuk diaudit' }),
            el('p', { class: 'text-muted', text: 'Tanpa framework berat: Node.js murni, PostgreSQL dengan Row Level Security, dan antarmuka DOM API. Kontrak database diuji pada PostgreSQL sungguhan sebelum deploy.' }),
            el('a', { class: 'feature-card__link', attrs: { href: '/keamanan' }, text: 'Baca praktik keamanan', onClick: (e) => { e.preventDefault(); navigate('/keamanan'); } }, icon('arrowRight', { size: 15 }))
          )
        )
      )
    )
  );

  // ------------------------------------------------------------------- CTA
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'cta-band animate-rise' },
          el('div', {},
            el('h2', { class: 'section__title', text: 'Mau lihat sendiri cara kerjanya?' }),
            el('p', { class: 'text-muted', text: 'Jelajahi katalog tanpa akun. Registrasi hanya diperlukan saat Anda siap membeli nomor.' })
          ),
          el('div', { class: 'row row--wrap' },
            el('a', {
              class: 'btn btn--primary btn--lg',
              attrs: { href: '/services' },
              text: 'Jelajahi layanan',
              onClick: (e) => { e.preventDefault(); navigate('/services'); }
            }),
            el('a', {
              class: 'btn btn--outline btn--lg',
              attrs: { href: '/kontak' },
              text: 'Hubungi kami',
              onClick: (e) => { e.preventDefault(); navigate('/kontak'); }
            })
          )
        )
      )
    )
  );

  shell.appendChild(main);
  shell.appendChild(layout.footer());

  return {
    node: shell,
    title: 'Tentang — FINZZ Store'
  };
}
