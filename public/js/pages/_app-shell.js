// ============================================================================
// Shared shell for authenticated pages: header + sidebar + mobile nav.
// ============================================================================
import { el } from '../ui.js';

export function appShell(layout, activeId, content) {
  const main = el('main', { class: 'main', attrs: { id: 'main' } }, content);
  const shell = el('div', { class: 'app-shell' },
    layout.header({ variant: 'app' }),
    el('div', { class: 'app-body' },
      layout.sidebar(activeId),
      main
    ),
    layout.mobileNav(activeId),
    layout.footer({ compact: true })
  );
  return { shell, main };
}
