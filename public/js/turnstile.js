// ============================================================================
// CLOUDFLARE TURNSTILE — optional bot protection for register / login /
// forgot-password.
//
// The widget is only mounted when the server reports it enabled AND a site key
// is present in the public config. When it is off, `mount()` resolves to a
// controller whose `token()` is null and the forms behave exactly as before.
//
// The server verifies the token against siteverify with the secret key and
// fails closed: a missing or invalid token is rejected when the feature is on.
// Nothing here is a security boundary — it only produces the token.
// ============================================================================

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    script.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * @param {HTMLElement} container
 * @param {{siteKey: string, action?: string, theme?: 'auto'|'dark'|'light'}} options
 * @returns {Promise<{token: () => string|null, reset: () => void, enabled: boolean, error: string|null}>}
 */
export async function mountTurnstile(container, { siteKey, action = 'default', theme = 'dark' } = {}) {
  if (!siteKey || !container) {
    return { token: () => null, reset: () => {}, enabled: false, error: null };
  }

  let widgetId = null;
  let token = null;

  try {
    const turnstile = await loadScript();
    widgetId = turnstile.render(container, {
      sitekey: siteKey,
      action,
      theme,
      callback: (value) => { token = value; },
      'expired-callback': () => { token = null; },
      'error-callback': () => { token = null; }
    });
    return {
      enabled: true,
      error: null,
      token: () => token,
      reset: () => { token = null; if (widgetId !== null) turnstile.reset(widgetId); }
    };
  } catch (err) {
    // The likely cause is a blocked script (offline preview, strict CSP, ad
    // blocker). Surface it so the user is not left with a dead form, and let
    // the server decide — it will reject the request while the feature is on.
    return {
      enabled: true,
      error: 'Verifikasi keamanan tidak dapat dimuat. Muat ulang halaman atau nonaktifkan pemblokir iklan.',
      token: () => null,
      reset: () => {}
    };
  }
}

/** Convenience: read the flag out of the cached public settings. */
export function turnstileConfig(publicSettings) {
  // /api/public/config nests the public view under `app`; the other two paths
  // keep this tolerant of older fixtures and the boot-state config object.
  const turnstile = publicSettings?.app?.turnstile
    || publicSettings?.config?.turnstile
    || publicSettings?.turnstile
    || {};
  return {
    enabled: Boolean(turnstile.enabled),
    siteKey: turnstile.siteKey || ''
  };
}
