// ============================================================================
// SERVER SIDE HTML — generates the initial document from JavaScript.
// There are no physical .html files in this project: every page is produced
// here, carries a per-request CSP nonce, and hands the boot state to the
// client through a JSON script block. The actual UI is then rendered with the
// DOM API in public/js.
// ============================================================================
import { escapeHtml, safeJsonForHtml } from './security.js';

const CSS_FILES = ['/css/tokens.css', '/css/style.css', '/css/components.css', '/css/skeleton.css', '/css/responsive.css'];

export function renderDocument({
  page,
  meta,
  nonce,
  state,
  status = 200,
  errorPage = null
}) {
  const title = meta?.title || 'FINZZ Store';
  const description = meta?.description || 'FINZZ Store — platform nomor virtual (nokos).';
  const bootState = {
    page: page || 'not-found',
    path: state?.path || '/',
    status,
    user: state?.user || null,
    config: state?.config || {},
    csrfToken: state?.csrfToken || null,
    preloaded: state?.preloaded || {},
    serverTime: new Date().toISOString()
  };

  return `<!DOCTYPE html>
<html lang="id" data-theme="dark" data-page="${escapeHtml(page || 'not-found')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0b0d12">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="${meta?.requiresAuth ? 'noindex, nofollow' : 'index, follow'}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="/assets/svg/logo.svg" type="image/svg+xml">
${CSS_FILES.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<script type="application/json" id="finzz-state" nonce="${nonce}">${safeJsonForHtml(bootState)}</script>
<script type="module" src="/js/main.js" nonce="${nonce}"></script>
</head>
<body>
<a class="skip-link" href="#main">Lewati ke konten utama</a>
<div id="app-root" data-page="${escapeHtml(page || 'not-found')}">
  <div class="boot-splash" role="status" aria-live="polite">
    <div class="boot-splash__logo" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="44" height="44" role="img" aria-label="FINZZ Store">
        <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6d8bff"/><stop offset="1" stop-color="#22d3a6"/>
        </linearGradient></defs>
        <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#bg)"/>
        <path d="M16 33V15h16v4.6H21.2v3.1h9.3v4.6h-9.3V33z" fill="#0b0d12"/>
      </svg>
    </div>
    <p class="boot-splash__text">Memuat FINZZ Store…</p>
  </div>
</div>
<noscript>
  <div class="noscript">FINZZ Store membutuhkan JavaScript untuk menampilkan antarmuka. Aktifkan JavaScript pada peramban Anda.</div>
</noscript>
${errorPage ? `<div class="server-error" role="alert">${escapeHtml(errorPage)}</div>` : ''}
</body>
</html>`;
}

export function renderNoScriptOnly(message) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>FINZZ Store</title></head><body><p>${escapeHtml(message)}</p></body></html>`;
}
