// ============================================================================
// SERVER SIDE HTML — generates the initial document from JavaScript.
// There are no physical .html files in this project: every page is produced
// here, carries a per-request CSP nonce, and hands the boot state to the
// client through a JSON script block. The actual UI is then rendered with the
// DOM API in public/js.
// ============================================================================
import { escapeHtml, safeJsonForHtml } from './security.js';

const CSS_FILES = ['/css/tokens.css', '/css/style.css', '/css/components.css', '/css/effects.css', '/css/skeleton.css', '/css/responsive.css', '/css/auth.css'];

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
  const appUrl = state?.config?.appUrl || 'http://localhost:3000';
  const canonicalPath = String(state?.path || '/').split(/[?#]/, 1)[0] || '/';
  let canonicalUrl = appUrl;
  let ogImageUrl = '/assets/og-finzz.png';
  try {
    canonicalUrl = new URL(canonicalPath, appUrl).href;
    ogImageUrl = new URL('/assets/og-finzz.png', appUrl).href;
  } catch {
    // A malformed test/development APP_URL should not break shell rendering.
  }
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
<meta name="theme-color" content="#06070d">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="${meta?.requiresAuth ? 'noindex, nofollow' : 'index, follow'}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:site_name" content="FINZZ Store">
<meta property="og:locale" content="id_ID">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(ogImageUrl)}">
<meta property="og:image:secure_url" content="${escapeHtml(ogImageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="FINZZ Store — nomor virtual, lebih simpel.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">
<link rel="icon" href="/assets/svg/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="icon" href="/assets/svg/favicon.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/svg/apple-touch-icon.png">
${CSS_FILES.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<script type="application/json" id="finzz-state" nonce="${nonce}">${safeJsonForHtml(bootState)}</script>
<script type="module" src="/js/main.js" nonce="${nonce}"></script>
</head>
<body>
<a class="skip-link" href="#main">Lewati ke konten utama</a>
<div id="app-root" data-page="${escapeHtml(page || 'not-found')}">
  <div class="boot-splash" role="status" aria-live="polite">
    <div class="boot-splash__logo" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="44" height="44" role="img" aria-label="FINZZ Store" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="1.5" width="45" height="45" rx="15" fill="#101522" stroke="rgba(148,163,198,.22)" stroke-width="1.2"/>
        <rect x="5.5" y="5.5" width="37" height="37" rx="12" fill="#151d30"/>
        <path d="M16 34V18a5 5 0 0 1 5-5h12.5" fill="none" stroke="#7c8cff" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M16.4 23.5h12.2" fill="none" stroke="#2ee6b6" stroke-width="4.6" stroke-linecap="round"/>
        <circle cx="33.7" cy="33.1" r="2.8" fill="#2ee6b6"/>
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
