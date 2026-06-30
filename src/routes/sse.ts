// src/routes/sse.ts
// Route handler for GET /events — Server-Sent Events stream.
//
// Requirements: 5.9, 5.11, 8.5, 8.7, 8.8
//
// sseClients is imported from the broadcaster — NOT declared here (Req 5.11).
// On connect  : client controller is added  to sseClients (Req 8.7).
// On disconnect: client controller is removed from sseClients (Req 8.8).

import type { Router } from '../router.ts';
import type { SSEController } from '../types.ts';
import { sseClients } from '../workers/ssebroadcaster.ts';

export function register(router: Router): void {
  router.get('/events', (_req, _params) => {
    let controllerRef: SSEController | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const client: SSEController = {
          enqueue(data: string) {
            try {
              controller.enqueue(new TextEncoder().encode(data));
            } catch {
              client.closed = true;
            }
          },
          closed: false,
        };

        controllerRef = client;
        sseClients.add(client); // Req 8.7 — size incremented by exactly 1

        // Send initial comment to establish the connection
        try {
          controller.enqueue(new TextEncoder().encode(': connected\n\n'));
        } catch {
          client.closed = true;
        }
      },

      cancel() {
        // Req 8.8 — remove on disconnect / abort; size decremented by exactly 1
        if (controllerRef) {
          controllerRef.closed = true;
          sseClients.delete(controllerRef);
          controllerRef = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    });
  });
}
