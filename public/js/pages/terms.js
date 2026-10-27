// ============================================================================
// TERMS OF SERVICE — static legal copy, rendered client-side.
// ============================================================================
import { el } from '../ui.js';
import { icon } from '../icons.js';

const SECTIONS = [
  {
    title: '1. Definisi layanan',
    body: [
      'FINZZ Store menyediakan nomor telepon virtual (nokos) yang digunakan untuk menerima kode verifikasi (OTP) dari layanan pihak ketiga. FINZZ Store bertindak sebagai perantara antara pengguna dan penyedia nomor virtual.',
      'Nomor bersifat sementara dan hanya berlaku sampai order selesai, dibatalkan, atau kedaluwarsa. Nomor tidak dapat diperpanjang dan tidak dapat dipindahkan ke akun lain.'
    ]
  },
  {
    title: '2. Akun pengguna',
    body: [
      'Satu pengguna bertanggung jawab penuh atas kerahasiaan password dan aktivitas yang terjadi pada akunnya. Penggunaan akun secara bersama-sama, diperjualbelikan, atau diakses otomatis tanpa izin tertulis dilarang.',
      'Pengguna wajib berusia minimal 18 tahun atau memiliki izin dari wali yang sah.'
    ]
  },
  {
    title: '3. Saldo, deposit, dan pembayaran',
    body: [
      'Saldo pada FINZZ Store bukan alat pembayaran yang sah, tidak berbunga, dan hanya dapat digunakan untuk membeli layanan di dalam platform. Saldo tidak dapat dipindahtangankan ke pengguna lain.',
      'Deposit manual akan dikreditkan setelah bukti transfer diverifikasi oleh admin. Bukti transfer palsu atau duplikat akan menyebabkan penolakan, penangguhan akun, dan pelaporan kepada pihak berwenang bila diperlukan.',
      'Harga yang ditampilkan di katalog dapat berubah sewaktu-waktu mengikuti harga supplier. Harga final selalu dikonfirmasi ulang pada saat order dibuat.'
    ]
  },
  {
    title: '4. Pengembalian dana (refund)',
    body: [
      'Refund diberikan secara otomatis ketika supplier menyatakan order gagal atau dibatalkan pada tahap yang memenuhi syarat pembatalan, sesuai kebijakan supplier.',
      'Refund tidak diberikan ketika nomor sudah menerima OTP, ketika pengguna tidak dapat menyelesaikan verifikasi pada layanan tujuan, atau ketika status akhir supplier belum pasti. Pada kondisi status belum pasti, order ditahan sampai status final diperoleh.',
      'Setiap refund dicatat pada ledger saldo dan hanya dapat terjadi satu kali untuk setiap order.'
    ]
  },
  {
    title: '5. Penggunaan yang dilarang',
    body: [
      'Pengguna dilarang menggunakan layanan untuk membuat akun palsu dalam jumlah besar, penipuan, penyalahgunaan platform pihak ketiga, pelanggaran hukum yang berlaku, atau aktivitas yang merugikan pihak lain.',
      'FINZZ Store dapat menangguhkan atau menutup akun yang melanggar ketentuan ini tanpa kewajiban mengembalikan saldo yang terkait pelanggaran.'
    ]
  },
  {
    title: '6. Ketersediaan layanan',
    body: [
      'Layanan bergantung pada ketersediaan supplier pihak ketiga. FINZZ Store tidak menjamin ketersediaan stok, waktu kedatangan OTP, atau kesinambungan layanan tanpa gangguan.',
      'Ketika supplier tidak dapat dihubungi, status data ditandai sebagai tidak tersedia dan pembelian baru dapat ditahan sampai sistem pulih.'
    ]
  },
  {
    title: '7. Batasan tanggung jawab',
    body: [
      'Tanggung jawab FINZZ Store terbatas pada nilai nominal order yang bersangkutan. FINZZ Store tidak bertanggung jawab atas kerugian tidak langsung, kehilangan keuntungan, atau kerusakan yang timbul dari penggunaan layanan di luar nilai order.'
    ]
  },
  {
    title: '8. Perubahan ketentuan',
    body: [
      'Ketentuan ini dapat diperbarui sewaktu-waktu dan versi terbaru selalu tersedia pada halaman ini. Penggunaan layanan setelah pembaruan dianggap sebagai persetujuan atas ketentuan yang berlaku.'
    ]
  }
];

export default async function terms(ctx) {
  const { layout } = ctx;
  const page = el('div', { class: 'page page--narrow animate-rise' },
    el('div', { class: 'page__head' },
      el('div', {},
        el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Dokumen legal' })),
        el('div', { class: 'row', style: { gap: '12px', marginTop: '14px' } },
          el('span', { class: 'feature-tile feature-tile--lg' }, icon('book', { size: 22 })),
          el('h1', { class: 'page__title', text: 'Syarat & Ketentuan' })),
        el('p', { class: 'page__subtitle', text: 'Ketentuan penggunaan layanan FINZZ Store. Terakhir diperbarui: Januari 2026.' })
      )
    ),
    el('article', { class: 'prose' },
      SECTIONS.map((section) =>
        el('section', { class: 'card' },
          el('div', { class: 'card__body' },
            el('h2', { text: section.title }),
            section.body.map((paragraph) => el('p', { text: paragraph }))
          )
        )
      ),
      el('p', { class: 'text-sm text-dim', text: 'Pertanyaan mengenai ketentuan ini dapat dikirim ke alamat dukungan yang tercantum di footer.' })
    )
  );

  return {
    node: el('div', { class: 'public-shell' },
      layout.header({ variant: 'public' }),
      el('main', { class: 'main', attrs: { id: 'main' } }, page),
      layout.footer({})
    ),
    title: 'Syarat & Ketentuan — FINZZ Store'
  };
}
