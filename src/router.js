// ============================================================================
// ROUTER — small pattern matcher built on node:http primitives.
// Supports `:param` segments, per-method registration and 405 reporting.
// ============================================================================

export function createRouter() {
  const routes = [];

  const compile = (pattern) => {
    const paramNames = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${regexSource}/?$`), paramNames };
  };

  const add = (method, pattern, handler, meta = {}) => {
    routes.push({ method, pattern, handler, meta, ...compile(pattern) });
  };

  const router = {
    get: (pattern, handler, meta) => add('GET', pattern, handler, meta),
    post: (pattern, handler, meta) => add('POST', pattern, handler, meta),
    patch: (pattern, handler, meta) => add('PATCH', pattern, handler, meta),
    put: (pattern, handler, meta) => add('PUT', pattern, handler, meta),
    delete: (pattern, handler, meta) => add('DELETE', pattern, handler, meta),

    match(method, pathname) {
      const pathMatches = [];
      for (const route of routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        pathMatches.push(route);
        if (route.method !== method) continue;
        const params = {};
        route.paramNames.forEach((name, i) => {
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch {
            params[name] = m[i + 1];
          }
        });
        return { route, params };
      }
      if (pathMatches.length) {
        return { methodNotAllowed: [...new Set(pathMatches.map((r) => r.method))] };
      }
      return null;
    },

    list() {
      return routes.map((r) => ({ method: r.method, pattern: r.pattern, meta: r.meta }));
    }
  };

  return router;
}
