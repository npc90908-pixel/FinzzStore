// ============================================================================
// ICONS — custom inline SVG paths (no emoji, no external icon font).
// Each entry is the inner markup of a 24x24 stroke icon.
// ============================================================================

const PATHS = {
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  receipt: '<path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.3"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c.6-3.6 3.6-5.6 7.2-5.6s6.6 2 7.2 5.6"/>',
  shield: '<path d="M12 3.4 20 6v6c0 4.4-3.2 7.6-8 8.6-4.8-1-8-4.2-8-8.6V6z"/><path d="m8.8 12 2.3 2.3 4.1-4.4"/>',
  login: '<path d="M14 3.5h3.5A2.5 2.5 0 0 1 20 6v12a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 8l4 4-4 4"/><path d="M14 12H3.5"/>',
  logout: '<path d="M15 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H15"/><path d="M18.5 8.5 22 12l-3.5 3.5M22 12H10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4.5M12 17.4v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V9h-4.5"/>',
  activity: '<path d="M3 12h3.5l2.5-7 4 14 2.5-7H21"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5z"/>',
  arrowRight: '<path d="M4 12h15M13.5 6l6 6-6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7M9 7h8v8"/>',
  download: '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M4.5 18.5h15"/>',
  upload: '<path d="M12 15V3.8M7.5 8.2 12 3.8l4.5 4.4"/><path d="M4.5 18.5h15"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.4"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.4"/><path d="m3.8 7 8.2 6 8.2-6"/>',
  key: '<circle cx="8.5" cy="15.5" r="3.6"/><path d="m11.2 12.8 8.3-8.3M16 8l2.4 2.4M18.4 5.6 20.8 8"/>',
  filter: '<path d="M3.5 6h17l-6.6 7.6v5.9L10 21v-7.4z"/>',
  sparkles: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"/><path d="M18.5 16.5 19.3 19l2.2.8-2.2.8-.8 2.4-.8-2.4-2.2-.8 2.2-.8z"/>',
  smartphone: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10.8 18.4h2.4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.6 12h16.8M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.4-3.6-8.5S9.6 5.9 12 3.5z"/>',
  zap: '<path d="M13.2 3 5 13.6h5.4L10 21l8.3-10.8h-5.5z"/>',
  trendingUp: '<path d="M3.5 16.5 9 11l3.6 3.6L20.5 7"/><path d="M15 7h5.5v5.5"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.5-3.1 2.9-5 5.5-5s5 1.9 5.5 5"/><path d="M16 6.2a3 3 0 0 1 0 5.6M17.2 14.4c2 .5 3.3 2.2 3.6 4.6"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.2A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.7H3a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z"/>',
  eye: '<path d="M2.8 12S6 6.5 12 6.5 21.2 12 21.2 12 18 17.5 12 17.5 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2A1.6 1.6 0 0 0 8.9 20.8h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
  pause: '<rect x="7" y="5" width="3.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.2"/>',
  play: '<path d="M8 5.2v13.6L19 12z"/>',
  loader: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/>',
  link: '<path d="M10.5 13.5 13.5 10.5"/><path d="M8.2 15.8 6.6 17.4a3.6 3.6 0 1 1-5.1-5.1l1.6-1.6"/><path d="M15.8 8.2l1.6-1.6a3.6 3.6 0 1 1 5.1 5.1l-1.6 1.6"/>',
  inbox: '<path d="M3.5 12.5 6.2 5h11.6l2.7 7.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z"/><path d="M3.5 12.5h5l1 2.5h5l1-2.5h5"/>',
  layers: '<path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1z"/><path d="m4.6 12.4 7.4 4 7.4-4M4.6 16.4l7.4 4 7.4-4"/>',
  smartphoneCheck: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6"/><path d="m9.8 11.5 1.8 1.8 3.2-3.6"/>',
  externalLink: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M17 14v4.5A1.5 1.5 0 0 1 15.5 20h-9A1.5 1.5 0 0 1 5 18.5v-9A1.5 1.5 0 0 1 6.5 8H11"/>',
  dot: '<circle cx="12" cy="12" r="3.6"/>',
  wifiOff: '<path d="m3 3 18 18"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M5 12a10 10 0 0 1 3-2M19 12a10 10 0 0 0-4.5-2.4"/><circle cx="12" cy="19" r="1"/>',
  headset: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.6"/><rect x="17" y="13" width="4" height="6" rx="1.6"/><path d="M20 19a4 4 0 0 1-4 3h-3"/>',
  send: '<path d="M21 3 10 14"/><path d="M21 3 14 21l-4-7-7-4z"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2 0-3s-2.2-.8-3 0z"/><path d="M9 15l-3-3c1-5 4-8.5 9-9 .5 5-2.5 8-6 12z"/><circle cx="14.5" cy="9.5" r="1.6"/>',
  fingerprint: '<path d="M12 4a8 8 0 0 0-8 8v3"/><path d="M20 12a8 8 0 0 0-2.5-5.8"/><path d="M8 12a4 4 0 0 1 8 0v2.5"/><path d="M12 12v4a8 8 0 0 0 1 4"/><path d="M8 16v-2"/><path d="M16 16.5V20"/>',
  book: '<path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v16H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 4.5V20"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M9 11.5h6M9 14.5h4"/>',
  pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  banknote: '<rect x="3" y="6" width="18" height="12" rx="2.4"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 14l4-4"/>',
  server: '<rect x="3.5" y="4.5" width="17" height="6.5" rx="2"/><rect x="3.5" y="13" width="17" height="6.5" rx="2"/><path d="M7.5 7.8h.01M7.5 16.3h.01"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  heart: '<path d="M12 20s-7-4.6-9.2-9A4.8 4.8 0 0 1 12 6.4 4.8 4.8 0 0 1 21.2 11C19 15.4 12 20 12 20z"/>',
  qr: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><path d="M13.5 13.5h3v3M20 16.5V20h-3.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.4 2.4 0 1 1 3.3 2.2c-.7.3-.9.8-.9 1.5"/><circle cx="12" cy="16.6" r="0.4" fill="currentColor"/>'
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG icon element. Never injects user-provided markup. */
export function icon(name, { size = 18, strokeWidth = 1.7, className = '', label = null } = {}) {
  const markup = PATHS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', label ? 'false' : 'true');
  if (label) {
    svg.setAttribute('role', 'img');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = label;
    svg.appendChild(title);
  }
  if (className) svg.setAttribute('class', className);
  if (markup) svg.innerHTML = markup; // static, developer-authored paths only
  return svg;
}

export const BRAND_MARK_SVG = `<svg viewBox="0 0 48 48" width="34" height="34" role="img" aria-label="FINZZ Store">
  <defs><linearGradient id="fz-brand" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c8cff"/><stop offset="1" stop-color="#2ee6b6"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#fz-brand)"/>
  <path d="M16 33V15h16v4.6H21.2v3.1h9.3v4.6h-9.3V33z" fill="#06070d"/>
  <circle cx="34.5" cy="31.5" r="2.4" fill="#06070d" opacity="0.75"/>
</svg>`;

export const iconNames = Object.keys(PATHS);
