// ============================================================================
// WALLET — balance, manual and AstraPay deposit flows, history.
// ============================================================================
import { el, Button, Badge, Card, Table, Skeleton, EmptyState, Alert, toast, FileUpload, Input, Textarea, runWithLoading, fieldError, Pagination, PageHeader } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError } from '../api.js';
import { formatRupiah, formatDate, depositStatusMeta, timeAgo } from '../store.js';

export default async function walletPage(ctx) {
  const { api, store, navigate, layout } = ctx;
  const state = { page: 1, depositPage: 1, wallet: null, policy: null };

  const balanceCard = el('div', { class: 'card card--highlight' }, el('div', { class: 'card__body' }, new Skeleton({ lines: 3 })));
  const policyArea = el('div', { class: 'stack' });
  const depositHistoryArea = el('div', {}, new Skeleton({ lines: 4 }));
  const txArea = el('div', {}, new Skeleton({ lines: 6 }));

  const content = el('div', { class: 'page animate-rise' },
    PageHeader({
      eyebrow: 'Dompet',
      iconName: 'wallet',
      tone: 'mint',
      title: 'Saldo & deposit',
      subtitle: 'Semua perubahan saldo tercatat pada ledger. Deposit manual direview admin; AstraPay diverifikasi server sebelum dikreditkan.',
      actions: Button({ variant: 'outline', iconName: 'refresh', children: 'Muat ulang', onClick: () => load() })
    }),
    el('div', { class: 'grid grid--sidebar' },
      el('div', { class: 'stack' }, balanceCard, txArea),
      el('div', { class: 'stack' }, policyArea)
    ),
    el('section', { class: 'stack' }, el('h2', { class: 'section__title', text: 'Riwayat deposit' }), depositHistoryArea)
  );

  const { shell } = appShell(layout, 'wallet', content);

  const renderBalance = (wallet) => {
    balanceCard.replaceChildren(
      el('div', { class: 'card__body stack' },
        el('div', { class: 'row row--between' },
          el('div', {},
            el('span', { class: 'section-label', text: 'Saldo tersedia' }),
            el('div', { style: { fontSize: '2.1rem', fontWeight: '700', letterSpacing: '-0.02em' }, class: 'mono', text: formatRupiah(wallet.balance) })
          ),
          el('span', { class: 'stat__icon', style: { width: '46px', height: '46px' } }, icon('wallet', { size: 22 }))
        ),
        el('div', { class: 'row row--between row--wrap' },
          el('span', { class: 'text-xs text-dim', text: `Diperbarui ${timeAgo(wallet.updatedAt)} · ${wallet.currency}` }),
          el('div', { class: 'pill-row' },
            el('span', { class: 'badge badge--neutral' }, el('span', { text: `${wallet.activeOrders.length} order aktif` })),
            wallet.pendingDepositCount > 0 ? el('span', { class: 'badge badge--warning' }, el('span', { text: `${wallet.pendingDepositCount} deposit manual menunggu` })) : null,
            wallet.pendingGatewayCount > 0 ? el('span', { class: 'badge badge--info' }, el('span', { text: `${wallet.pendingGatewayCount} invoice AstraPay` })) : null
          )
        ),
        wallet.paymentGateway?.enabled === false
          ? el('div', { class: 'text-xs text-dim' }, icon('info', { size: 13 }), el('span', { text: ` ${wallet.paymentGateway.message}` }))
          : null
      )
    );
  };

  const renderPolicyAndForm = (wallet) => {
    const policy = wallet.depositPolicy;
    const upload = FileUpload({ onChange: (file) => { state.proof = file; } });
    const form = el('form', { class: 'stack', attrs: { novalidate: true } });
    const errorArea = el('div');
    const submit = Button({ variant: 'primary', block: true, iconName: 'upload', type: 'submit', children: 'Ajukan deposit' });

    const amountInput = Input({
      label: 'Nominal transfer',
      name: 'amount',
      type: 'number',
      inputMode: 'numeric',
      min: policy.minAmount,
      max: policy.maxAmount,
      placeholder: String(policy.minAmount),
      hint: `Minimal ${formatRupiah(policy.minAmount)} · maksimal ${formatRupiah(policy.maxAmount)}`
    });
    const noteInput = Textarea({ label: 'Catatan (opsional)', name: 'note', rows: 2, maxlength: 500, placeholder: 'Nama pengirim atau berita transfer' });

    form.append(
      el('div', { class: 'section-label', text: 'Ajukan deposit' }),
      policy.bankAccounts.length
        ? el('div', { class: 'stack', style: { gap: '8px' } },
            policy.bankAccounts.filter((a) => a.bank_name || a.account_number).map((acc) =>
              el('div', { class: 'copy-field', style: { justifyContent: 'space-between' } },
                el('span', { class: 'stack', style: { gap: '2px' } },
                  el('span', { class: 'text-xs text-dim', text: acc.bank_name || 'Bank' }),
                  el('span', { class: 'mono', text: acc.account_number || '—' }),
                  acc.account_holder ? el('span', { class: 'text-xs text-dim', text: `a.n. ${acc.account_holder}` }) : null
                ),
                Button({ variant: 'ghost', size: 'sm', iconName: 'copy', title: 'Salin nomor rekening', onClick: async () => {
                  try { await navigator.clipboard.writeText(acc.account_number || ''); toast({ type: 'success', title: 'Nomor rekening disalin' }); }
                  catch { toast({ type: 'error', title: 'Gagal menyalin' }); }
                } })
              )
            )
          )
        : Alert({ tone: 'warning', title: 'Rekening belum diatur', children: 'Administrator belum mengisi rekening tujuan. Hubungi dukungan sebelum melakukan transfer.' }),
      // Native append() stringifies a bare null into a visible "null" text node.
      ...(policy.instructions ? [el('p', { class: 'text-sm text-muted', text: policy.instructions })] : []),
      amountInput,
      upload.zone,
      upload.preview,
      noteInput,
      errorArea,
      submit
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorArea.replaceChildren();
      const amount = Number(form.elements.amount.value);
      if (!Number.isFinite(amount) || amount < policy.minAmount) {
        return fieldError(form, 'amount', `Nominal minimal ${formatRupiah(policy.minAmount)}.`);
      }
      if (amount > policy.maxAmount) return fieldError(form, 'amount', `Nominal maksimal ${formatRupiah(policy.maxAmount)}.`);
      if (!state.proof?.dataUrl) {
        errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Bukti transfer belum diunggah', children: 'Unggah bukti transfer dalam format PNG, JPG, WEBP, atau PDF.' }));
        return;
      }

      await runWithLoading(submit, async () => {
        try {
          await api.post('/api/deposits', {
            amount,
            proof: state.proof.dataUrl,
            note: form.elements.note.value.trim() || undefined
          });
          toast({ type: 'success', title: 'Deposit diajukan', message: 'Tunggu verifikasi admin maksimal 1x24 jam.' });
          form.reset();
          upload.reset();
          state.proof = null;
          await load();
        } catch (err) {
          errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal mengajukan deposit', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
        }
      }, { loadingLabel: 'Mengirim…' });
    });

    const cards = [Card({ title: 'Deposit manual', subtitle: 'Bukti transfer diverifikasi admin' }, form)];
    const pendingGateways = (wallet.pendingDeposits || []).filter((deposit) =>
      deposit.method === 'gateway' && deposit.status === 'pending'
    );
    if (wallet.paymentGateway?.enabled || pendingGateways.length) {
      const gatewayMax = policy.gatewayMaxAmount || policy.maxAmount;
      let gatewayForm = null;
      if (wallet.paymentGateway?.enabled) {
        gatewayForm = el('form', { class: 'stack', attrs: { novalidate: true } });
        const gatewayError = el('div');
        const gatewayAmountInput = Input({
          label: 'Nominal saldo yang ingin masuk',
          name: 'gateway_amount',
          type: 'number',
          inputMode: 'numeric',
          min: policy.minAmount,
          max: gatewayMax,
          placeholder: String(policy.minAmount),
          hint: `Minimal ${formatRupiah(policy.minAmount)} · maksimal ${formatRupiah(gatewayMax)}`
        });
        const gatewaySubmit = Button({ variant: 'primary', block: true, type: 'submit', children: 'Buat invoice AstraPay' });
        gatewayForm.append(gatewayAmountInput, gatewayError, gatewaySubmit);
        gatewayForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          gatewayError.replaceChildren();
          const amount = Number(gatewayForm.elements.gateway_amount.value);
          if (!Number.isSafeInteger(amount) || amount < policy.minAmount) {
            return fieldError(gatewayForm, 'gateway_amount', `Nominal minimal ${formatRupiah(policy.minAmount)}.`);
          }
          if (amount > gatewayMax) return fieldError(gatewayForm, 'gateway_amount', `Nominal maksimal ${formatRupiah(gatewayMax)}.`);
          await runWithLoading(gatewaySubmit, async () => {
            try {
              await api.post('/api/deposits/gateway', { amount });
              toast({ type: 'success', title: 'Invoice AstraPay dibuat', message: 'Buka halaman pembayaran; saldo masuk setelah server memverifikasi pembayaran.' });
              gatewayForm.reset();
              await load();
            } catch (err) {
              gatewayError.replaceChildren(Alert({ tone: 'danger', title: 'Gagal membuat invoice', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
            }
          }, { loadingLabel: 'Menghubungi AstraPay…' });
        });
      }

      const invoices = pendingGateways.map((pendingGateway) => pendingGateway.payment?.checkoutUrl
          ? el('div', { class: 'stack' },
              Alert({ tone: 'info', title: 'Invoice AstraPay menunggu pembayaran', children: 'Selesaikan pembayaran sebelum invoice kedaluwarsa. Nominal saldo tidak termasuk kode unik pembayaran.' }),
              el('div', { class: 'row row--between row--wrap' },
                el('span', { class: 'text-sm', text: 'Saldo yang akan masuk' }),
                el('span', { class: 'mono', text: formatRupiah(pendingGateway.amount) })
              ),
              el('div', { class: 'row row--between row--wrap' },
                el('span', { class: 'text-sm', text: 'Total yang harus dibayar' }),
                el('span', { class: 'mono', text: formatRupiah(pendingGateway.payment.payAmount) })
              ),
              el('a', {
                class: 'btn btn--outline btn--block',
                attrs: { href: pendingGateway.payment.checkoutUrl, target: '_blank', rel: 'noopener noreferrer' },
                text: 'Buka halaman QRIS AstraPay'
              }),
              el('p', { class: 'text-xs text-dim', text: 'Saldo hanya dikreditkan setelah signature webhook dan status final AstraPay diverifikasi di server. Muat ulang halaman untuk melihat hasilnya.' })
            )
          : Alert({ tone: 'warning', title: 'Invoice sedang dikonfirmasi', children: 'Belum ada tautan pembayaran yang dapat ditampilkan. Jangan transfer ke tujuan lain untuk invoice ini; status akan ditutup otomatis jika tidak berhasil dibuat.' })
      );

      cards.push(Card({
        title: 'Deposit otomatis · AstraPay',
        subtitle: wallet.paymentGateway?.enabled ? 'QRIS dinamis dan payment link' : 'Selesaikan invoice yang masih aktif',
        children: [gatewayForm, invoices]
      }));
    }
    cards.push(Card({ title: 'Kebijakan refund' },
      el('p', { class: 'text-sm text-muted', text: wallet.refundPolicy || 'Refund otomatis bila nomor tidak menerima OTP dan supplier menutup order.' })
    ));
    policyArea.replaceChildren(...cards);

    if (wallet.pendingDepositCount > 0) {
      policyArea.insertBefore(
        Alert({ tone: 'info', title: 'Deposit sedang direview', children: `${wallet.pendingDepositCount} deposit menunggu verifikasi admin.` }),
        policyArea.firstChild
      );
    }
  };

  const renderTransactions = (wallet) => {
    txArea.replaceChildren(
      Card({ title: 'Riwayat transaksi', subtitle: 'Ledger tidak dapat diubah', flush: true },
        Table({
          compact: true,
          columns: [
            { label: 'Waktu', render: (t) => el('span', { class: 'text-xs text-dim', text: formatDate(t.createdAt) }) },
            { label: 'Jenis', render: (t) => el('div', {}, el('div', { text: t.label }), t.description ? el('div', { class: 'text-xs text-dim', text: t.description }) : null) },
            { label: 'Arah', render: (t) => Badge({ tone: t.direction === 'credit' ? 'success' : 'neutral', children: t.direction === 'credit' ? 'Masuk' : 'Keluar' }) },
            { label: 'Nominal', align: 'right', render: (t) => el('span', { class: 'mono', style: { color: t.direction === 'credit' ? 'var(--success)' : 'var(--text)' }, text: `${t.direction === 'credit' ? '+' : '−'}${formatRupiah(t.amount)}` }) },
            { label: 'Saldo', align: 'right', render: (t) => el('span', { class: 'mono text-xs', text: formatRupiah(t.balanceAfter) }) }
          ],
          rows: wallet.transactions,
          empty: EmptyState({ title: 'Belum ada transaksi', description: 'Transaksi muncul setelah Anda mengajukan deposit atau membeli nomor.', iconName: 'receipt' })
        }),
        el('div', {}, Pagination({ page: wallet.pagination.page, pages: wallet.pagination.pages, onChange: (p) => { state.page = p; load(); } }))
      )
    );
  };

  const renderDeposits = async () => {
    try {
      const data = await api.get(`/api/deposits?page=${state.depositPage}`);
      depositHistoryArea.replaceChildren(
        Table({
          compact: true,
          columns: [
            { label: 'Diajukan', render: (d) => el('span', { class: 'text-xs text-dim', text: formatDate(d.createdAt) }) },
            { label: 'Nominal', align: 'right', render: (d) => el('span', { class: 'mono', text: formatRupiah(d.amount) }) },
            { label: 'Metode', render: (d) => d.method === 'gateway' ? 'AstraPay QRIS' : 'Manual' },
            { label: 'Status', render: (d) => Badge({ tone: depositStatusMeta(d.status, d.method).tone, children: depositStatusMeta(d.status, d.method).label }) },
            { label: 'Pembayaran', render: (d) => d.payment?.checkoutUrl
              ? el('a', { class: 'btn btn--outline btn--sm', attrs: { href: d.payment.checkoutUrl, target: '_blank', rel: 'noopener noreferrer' }, text: `Bayar ${formatRupiah(d.payment.payAmount)}` })
              : d.method === 'gateway' && d.status === 'pending' ? 'Invoice dikonfirmasi' : '—' },
            { label: 'Catatan admin', render: (d) => el('span', { class: 'text-xs text-dim', text: d.adminNote || '—' }) }
          ],
          rows: data.deposits,
          empty: EmptyState({ title: 'Belum ada deposit', description: 'Ajukan deposit pertama Anda melalui formulir di atas.', iconName: 'inbox' })
        }),
        el('div', {}, Pagination({ page: data.pagination.page, pages: data.pagination.pages, onChange: (p) => { state.depositPage = p; renderDeposits(); } }))
      );
    } catch (err) {
      depositHistoryArea.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat deposit', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
    }
  };

  async function load() {
    try {
      const wallet = await api.get(`/api/wallet?page=${state.page}`);
      state.wallet = wallet;
      store.set({ balance: wallet.balance });
      renderBalance(wallet);
      renderPolicyAndForm(wallet);
      renderTransactions(wallet);
      await renderDeposits();
    } catch (err) {
      toast({ type: 'error', title: 'Gagal memuat saldo', message: err instanceof ApiError ? err.message : 'Coba muat ulang.' });
    }
  }

  await load();

  return { node: shell, title: 'Saldo & Deposit — FINZZ Store' };
}
