// src/routes/ws.ts
// Route handler for WebSocket upgrade: GET /ws

import type { Router } from '../router.js';
import type { WsServer } from '../ws/server.js';

/**
 * Register the WebSocket upgrade route.
 *
 * Registers `GET /ws` which attempts to upgrade the incoming HTTP request to
 * a WebSocket connection via {@link WsServer.upgrade}.
 *
 * - If `upgrade` returns `undefined`, Bun has consumed the request and will
 *   complete the handshake internally. The route handler returns `undefined`
 *   cast to `Response` — Bun never reads this value when upgrade succeeds.
 * - If `upgrade` returns a `Response` (HTTP 400 or 503), it is forwarded
 *   directly to the client as the error reply.
 *
 * @param router   The application router to register the route on
 * @param wsServer The WsServer instance that handles the upgrade
 */
export function register(router: Router, wsServer: WsServer): void {
  router.get('/ws', (req, _params) => {
    const result = wsServer.upgrade(req);
    // When result is undefined Bun has already handled the upgrade response.
    // The cast is necessary because RouteHandler requires Response, but Bun
    // ignores the return value once the upgrade handshake is in progress.
    return result ?? (undefined as unknown as Response);
  });
}
