// ============================================================================
// PRIVACY POLICY — static copy describing what is actually stored.
// ============================================================================
import { el } from '../ui.js';
import { icon } from '../icons.js';

const SECTIONS = [
  {
    title: 'Data yang kami simpan',
    items: [
      'Identitas akun: email, username, nama lengkap, dan nomor telepon (opsional). Password disimpan hanya sebagai hash Argon2id di database FINZZ Store sendiri — tidak pernah dalam bentuk teks biasa, dan tidak pernah dikirim ke pihak ketiga.',
      'Data transaksi: order, nomor virtual yang ditugaskan, kode OTP, harga, status, dan riwayat perubahan status.',
      'Data saldo: mutasi saldo, deposit manual beserta bukti transfer, dan catatan refund.',
      'Data teknis: hash sesi login, alamat IP, user agent, dan waktu akses yang diperlukan untuk keamanan akun.'
    ]
  },
  {
    title: 'Dasar dan tujuan pemrosesan',
    items: [
      'Menjalankan layanan yang Anda pesan (pembelian nomor dan pengiriman OTP).',
      'Menjaga keamanan akun, mendeteksi penyalahgunaan, dan memenuhi kewajiban pencatatan keuangan.',
      'Memberikan dukungan ketika terjadi kendala pada order atau deposit.'
    ]
  },
  {
    title: 'Kode OTP',
    items: [
      'Kode OTP hanya dapat diakses oleh pemilik order. Kode disimpan untuk keperluan riwayat dan dukungan, dan ditampilkan ulang hanya kepada pemilik akun yang sah.',
      'Staf tidak akan pernah meminta kode OTP Anda melalui saluran apa pun.'
    ]
  },
  {
    title: 'Berbagi data dengan pihak ketiga',
    items: [
      'Data yang diperlukan untuk membuat order (identitas layanan dan negara) dikirimkan kepada penyedia nomor virtual untuk memproses pembelian. Tidak ada data lain yang dibagikan.',
      'Data tidak dijual kepada pihak ketiga dan tidak digunakan untuk iklan bertarget.'
    ]
  },
  {
    title: 'Penyimpanan dan keamanan',
    items: [
      'Data disimpan pada database PostgreSQL terkelola dengan Row Level Security aktif, sehingga setiap pengguna hanya dapat membaca data miliknya sendiri.',
      'Seluruh perubahan saldo dilakukan melalui fungsi database atomik yang mencatat setiap mutasi pada ledger.',
      'Kredensial layanan pihak ketiga hanya disimpan pada variabel lingkungan server dan tidak pernah dikirim ke peramban.'
    ]
  },
  {
    title: 'Hak Anda',
    items: [
      'Anda dapat memperbarui data profil dan password kapan saja melalui halaman profil.',
      'Permintaan penghapusan akun dapat diajukan melalui kanal dukungan. Data yang wajib disimpan untuk alasan pembukuan akan dipertahankan sesuai ketentuan yang berlaku.'
    ]
  }
];

export default async function privacy(ctx) {
  const { layout } = ctx;
  const page = el('div', { class: 'page page--narrow animate-rise' },
    el('div', { class: 'page__head' },
      el('div', {},
        el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Dokumen legal' })),
        el('div', { class: 'row', style: { gap: '12px', marginTop: '14px' } },
          el('span', { class: 'feature-tile feature-tile--mint feature-tile--lg' }, icon('shield', { size: 22 })),
          el('h1', { class: 'page__title', text: 'Kebijakan Privasi' })),
        el('p', { class: 'page__subtitle', text: 'Ringkasan data yang diproses FINZZ Store dan cara kami melindunginya.' })
      )
    ),
    el('article', { class: 'prose' },
      SECTIONS.map((section) =>
        el('section', { class: 'card' },
          el('div', { class: 'card__body' },
            el('h2', { text: section.title }),
            el('ul', {}, section.items.map((item) => el('li', { text: item })))
          )
        )
      )
    )
  );

  return {
    node: el('div', { class: 'public-shell' },
      layout.header({ variant: 'public' }),
      el('main', { class: 'main', attrs: { id: 'main' } }, page),
      layout.footer({})
    ),
    title: 'Kebijakan Privasi — FINZZ Store'
  };
}
