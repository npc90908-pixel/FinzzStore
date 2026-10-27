// ============================================================================
// SECURITY PAGE (public) — every control listed here exists in the codebase:
// Argon2id hashing, HttpOnly sessions, CSRF, rate limiting, Postgres RLS,
// bind-parameter queries, idempotency keys and upload size caps.
// ============================================================================
import { el, IconTile } from '../ui.js';
import { icon } from '../icons.js';

const RAILS = [
  {
    icon: 'lock',
    tone: 'brand',
    title: 'Password di-hash Argon2id',
    text: 'Password tidak pernah disimpan dalam bentuk teks asli. Server menyimpan hash Argon2id dengan parameter yang sengaja ringan agar tetap bisa diverifikasi di lingkungan serverless tanpa mengorbankan ketahanan terhadap brute force.'
  },
  {
    icon: 'mail',
    tone: 'mint',
    title: 'Verifikasi email & kode sekali pakai',
    text: 'Akun baru harus diverifikasi dengan kode 6 digit yang punya masa berlaku terbatas. Salah menebak kode dihitung, dan kode langsung hangus setelah dipakai — tidak bisa diputar ulang.'
  },
  {
    icon: 'key',
    tone: 'violet',
    title: 'Sesi HttpOnly dengan token CSRF',
    text: 'Sesi disimpan pada cookie HttpOnly dan SameSite sehingga tidak bisa dibaca JavaScript di browser. Setiap perubahan data lewat metode non-GET menuntut token CSRF yang cocok dengan sesi.'
  },
  {
    icon: 'gauge',
    tone: 'warning',
    title: 'Pembatas laju & penguncian akun',
    text: 'Upaya masuk, OTP, dan endpoint sensitif dibatasi per jendela waktu menggunakan penghitung rate limit di PostgreSQL, sehingga batas berlaku sama untuk semua instance serverless. Login yang gagal beruntun mengunci akun sementara.'
  },
  {
    icon: 'database',
    tone: 'info',
    title: 'Row Level Security di PostgreSQL',
    text: 'Tabel data pengguna dilindungi kebijakan RLS dan hanya bisa diakses lewat fungsi RPC dengan batasan peran: anonim, terautentikasi, dan service. Koneksi aplikasi tidak memakai kredensial superuser.'
  },
  {
    icon: 'shield',
    tone: 'brand',
    title: 'Query berparameter & validasi ketat',
    text: 'Setiap nilai dari pengguna dikirim sebagai bind parameter ($1, $2, …), bukan digabung ke string SQL. Input divalidasi di lapisan aplikasi sebelum menyentuh database, termasuk nominal uang dan ukuran unggahan.'
  },
  {
    icon: 'wallet',
    tone: 'mint',
    title: 'Ledger dompet & kunci idempotensi',
    text: 'Saldo berubah hanya melalui entri ledger yang seimbang: debit dan kredit selalu berpasangan. Order memakai idempotency key sehingga klik ganda atau retry jaringan tidak pernah mendebet saldo dua kali.'
  },
  {
    icon: 'upload',
    tone: 'violet',
    title: 'Unggahan dibatasi dan di luar web root',
    text: 'Bukti transfer dibatasi maksimal 5 MB, tipenya diperiksa, dan disimpan di folder privat yang tidak punya URL publik. Akses hanya melalui panel admin yang setiap aksinya masuk audit log.'
  }
];

const PRACTICES = [
  { icon: 'eye', title: 'Transparansi status', text: 'Halaman status menampilkan kondisi database, supplier, dan pembayaran yang sebenarnya, termasuk ketika ada gangguan.' },
  { icon: 'refresh', title: 'Pemulihan akun terkontrol', text: 'Tautan reset password berlaku singkat, sekali pakai, dan langsung mengakhiri semua sesi lain saat digunakan.' },
  { icon: 'bell', title: 'Notifikasi peristiwa penting', text: 'Order, OTP, deposit, dan perubahan akun masuk ke kotak notifikasi sehingga setiap perubahan saldo bisa Anda lacak.' },
  { icon: 'book', title: 'Kebijakan tertulis', text: 'Ketentuan layanan dan kebijakan privasi dipublikasikan, lengkap dengan versi tanggal pembaruannya.' }
];

export default async function security(ctx) {
  const { navigate, layout } = ctx;
  const shell = el('div', { class: 'app-shell' });
  shell.appendChild(layout.header({ variant: 'public' }));
  const main = el('main', { attrs: { id: 'main' } });

  // ---------------------------------------------------------------- hero
  main.appendChild(
    el('section', { class: 'page-hero' },
      el('div', { class: 'container' },
        el('div', { class: 'page-hero__inner animate-rise' },
          el('div', { class: 'page-hero__glow' }),
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Keamanan' })),
          el('h1', { class: 'page__title', style: { marginTop: '18px' }, text: 'Keamanan dibangun ke dalam alurnya, bukan ditempel di akhir' }),
          el('p', {
            class: 'page__subtitle',
            text: 'Halaman ini merangkum kontrol yang benar-benar dipakai aplikasi. Tidak ada klaim sertifikasi atau audit yang belum pernah kami jalani — hanya mekanisme yang bisa Anda periksa perilakunya di aplikasi.'
          })
        )
      )
    )
  );

  // --------------------------------------------------------------- rails
  main.appendChild(
    el('section', { class: 'section', style: { paddingTop: '12px' } },
      el('div', { class: 'container' },
        el('div', { class: 'grid grid--2' },
          RAILS.map((rail, i) =>
            el('div', { class: `rail rail--done lift animate-rise`, style: { '--d': `${(i % 2) * 80}ms` } },
              el('span', { class: `feature-tile feature-tile--${rail.tone}` }, icon(rail.icon, { size: 20 })),
              el('div', {},
                el('h3', { text: rail.title }),
                el('p', { class: 'text-muted', text: rail.text })
              )
            )
          )
        )
      )
    )
  );

  // ----------------------------------------------------------- practices
  main.appendChild(
    el('section', { class: 'section section--alt' },
      el('div', { class: 'container' },
        el('div', { class: 'section__head section__head--center' },
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Di luar mekanisme teknis' })),
          el('h2', { class: 'section__title', style: { marginTop: '16px' }, text: 'Yang Anda bisa lakukan dan pantau sendiri' })
        ),
        el('div', { class: 'grid grid--4' },
          PRACTICES.map((item, i) =>
            el('div', { class: 'feature-card lift animate-rise', style: { '--d': `${i * 70}ms` } },
              IconTile({ name: item.icon, tone: 'brand' }),
              el('h3', { style: { fontSize: 'var(--text-md)' }, text: item.title }),
              el('p', { class: 'text-sm text-muted', text: item.text })
            )
          )
        )
      )
    )
  );

  // ------------------------------------------------------------- links CTA
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'cta-band animate-rise' },
          el('div', {},
            el('h2', { class: 'section__title', text: 'Baca detail kebijakannya' }),
            el('p', { class: 'text-muted', text: 'Ketentuan layanan dan kebijakan privasi menjelaskan bagaimana data Anda dipakai, disimpan, dan dihapus.' })
          ),
          el('div', { class: 'row row--wrap' },
            el('a', {
              class: 'btn btn--primary btn--lg',
              attrs: { href: '/privacy' },
              text: 'Kebijakan privasi',
              onClick: (e) => { e.preventDefault(); navigate('/privacy'); }
            }),
            el('a', {
              class: 'btn btn--outline btn--lg',
              attrs: { href: '/status' },
              text: 'Status layanan',
              onClick: (e) => { e.preventDefault(); navigate('/status'); }
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
    title: 'Keamanan — FINZZ Store'
  };
}
