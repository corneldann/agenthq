// src/router.ts

export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

export interface Router {
  /** Register a handler for method + exact path. */
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;

  /** Match an incoming request; returns null if no route matches. */
  match(req: Request): { handler: RouteHandler; params: Record<string, string> } | null;
}

type RouteEntry = { segments: string[]; handler: RouteHandler };
type MethodMap = Map<string, RouteEntry[]>;  // key = HTTP method (uppercase)

export function createRouter(): Router {
  const routes: MethodMap = new Map();

  function register(method: string, path: string, handler: RouteHandler): void {
    const segments = path.split('/').filter(Boolean);
    const entries = routes.get(method) ?? [];
    // Warn on exact duplicate (same method + same path pattern)
    const duplicate = entries.find(e =>
      e.segments.length === segments.length &&
      e.segments.every((s, i) => s === segments[i])
    );
    if (duplicate) {
      console.warn(`[router] duplicate route ${method} ${path} — previous handler overwritten`);
      entries.splice(entries.indexOf(duplicate), 1);
    }
    // Static segments first, then param segments (priority ordering)
    const isStatic = (segs: string[]) => segs.every(s => !s.startsWith(':'));
    if (isStatic(segments)) {
      entries.unshift({ segments, handler });
    } else {
      entries.push({ segments, handler });
    }
    routes.set(method, entries);
  }

  function matchPath(
    segments: string[],
    entry: RouteEntry,
  ): Record<string, string> | null {
    if (entry.segments.length !== segments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < entry.segments.length; i++) {
      const pattern = entry.segments[i];
      const actual  = segments[i];
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(actual);
      } else if (pattern !== actual) {
        return null;
      }
    }
    return params;
  }

  return {
    get:    (path, h) => register('GET',    path, h),
    post:   (path, h) => register('POST',   path, h),
    put:    (path, h) => register('PUT',    path, h),
    delete: (path, h) => register('DELETE', path, h),

    match(req: Request) {
      const url      = new URL(req.url);
      const segments = url.pathname.split('/').filter(Boolean);
      const entries  = routes.get(req.method) ?? [];
      for (const entry of entries) {
        const params = matchPath(segments, entry);
        if (params !== null) return { handler: entry.handler, params };
      }
      return null;
    },
  };
}
