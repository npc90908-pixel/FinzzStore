// EJS-based server-rendered document shell. Page interactions progressively
// hydrate through the existing browser modules; the HTML shell and metadata
// are rendered server-side through EJS, with all untrusted fields escaped.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { escapeHtml, safeJsonForHtml } from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(path.join(ROOT, 'views/layouts/document.ejs'), 'utf8');
const CSS_FILES = ['/css/tokens.css', '/css/style.css', '/css/components.css', '/css/effects.css', '/css/skeleton.css', '/css/responsive.css', '/css/auth.css'];

export function renderDocument({ page, meta, nonce, state, status = 200, errorPage = null }) {
  const title = meta?.title || 'FINZZ Store';
  const description = meta?.description || 'FINZZ Store — platform nomor virtual (nokos).';
  const appUrl = state?.config?.appUrl || 'http://localhost:3000';
  const canonicalPath = String(state?.path || '/').split(/[?#]/, 1)[0] || '/';
  let canonicalUrl = appUrl;
  let ogImageUrl = '/assets/og-finzz.png';
  try {
    canonicalUrl = new URL(canonicalPath, appUrl).href;
    ogImageUrl = new URL('/assets/og-finzz.png', appUrl).href;
  } catch { /* malformed development APP_URL must not break shell rendering */ }

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
  return ejs.render(TEMPLATE, {
    page: page || 'not-found', title, description, nonce,
    robots: meta?.requiresAuth ? 'noindex, nofollow' : 'index, follow',
    canonicalUrl, ogImageUrl, cssFiles: CSS_FILES,
    bootStateJson: safeJsonForHtml(bootState),
    errorPage: errorPage ? String(errorPage) : null
  }, { filename: path.join(ROOT, 'views/layouts/document.ejs'), rmWhitespace: false });
}

export function renderNoScriptOnly(message) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>FINZZ Store</title></head><body><p>${escapeHtml(message)}</p></body></html>`;
}
