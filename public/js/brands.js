// ============================================================================
// BRAND ASSETS — mapping supplier app id -> local SVG.
//
// Rules encoded here, because they are easy to break later:
//   · a logo is only shown when the app actually exists in the live catalogue;
//   · no emoji, no invented logo: unknown apps fall back to a wordmark;
//   · files are local (public/assets/brands), never a third-party CDN;
//   · the CSS animates a *copy* of the list — it never implies extra inventory.
//
// Licences and provenance: public/assets/brands/LICENSE.md
// ============================================================================

const BASE = '/assets/brands';

/** supplier app id (TeleKos `id`) -> { slug, label } */
export const BRAND_BY_APP = Object.freeze({
  wa: { slug: 'whatsapp', label: 'WhatsApp' },
  tg: { slug: 'telegram', label: 'Telegram' },
  ig: { slug: 'instagram', label: 'Instagram' },
  fb: { slug: 'facebook', label: 'Facebook' },
  tw: { slug: 'x', label: 'X' },
  ds: { slug: 'discord', label: 'Discord' },
  lf: { slug: 'tiktok', label: 'TikTok' },
  go: { slug: 'google', label: 'Google' },
  ccu: { slug: 'google', label: 'Google Chat' },
  gf: { slug: 'google', label: 'Google Voice' },
  nf: { slug: 'netflix', label: 'Netflix' },
  alj: { slug: 'spotify', label: 'Spotify' },
  // Deliberately no asset: the owner of the trademark asked Simple Icons to
  // remove it, so the UI shows a wordmark instead of a look-alike.
  ts: { slug: null, label: 'PayPal' },
  ub: { slug: null, label: 'Uber' }
});

export const brandFor = (appId) => BRAND_BY_APP[appId] || null;

/**
 * Build the marquee entries from the live catalogue.
 * @param {Array<{id:string,name:string}>} apps  apps[] from /api/public/catalog
 */
export function marqueeBrands(apps = []) {
  const seen = new Set();
  const out = [];
  for (const app of apps) {
    const id = app?.id ?? app?.appId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = brandFor(id);
    out.push({
      id,
      label: known?.label || app.name || id,
      // `null` means "no licensed asset": the renderer draws the label.
      src: known?.slug ? `${BASE}/${known.slug}.svg` : null
    });
  }
  return out;
}

/** Deterministic split so both rows are stable between renders. */
export function splitRows(items, rows = 2) {
  const buckets = Array.from({ length: rows }, () => []);
  items.forEach((item, index) => buckets[index % rows].push(item));
  return buckets;
}
