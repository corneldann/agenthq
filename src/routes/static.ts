// routes/static.ts
// Handlers for static content routes:
//   GET /                     — dashboard HTML
//   GET /favicon.ico          — suppress 404
//   GET /assets/:file         — JS/CSS chunks emitted by bun build (content-hashed)
//   GET /view/:id             — job output .md file served as plain text
//   GET /poll-log             — recent poll log entries (JSON)

import path from "node:path";
import type { Router } from "../router.ts";
import { OUTPUT_DIR } from "../constants.ts";
import { pollLog } from "../workers/queuePoller.ts";

const DIST_DIR = path.resolve(import.meta.dir, "../../dist");

export function register(router: Router): void {
  // GET / — dashboard
  router.get("/", (_req, _params) => {
    return new Response(
      Bun.file(path.join(DIST_DIR, "dashboard.html")),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });

  // GET /favicon.ico — suppress 404
  router.get("/favicon.ico", (_req, _params) => {
    return new Response(null, { status: 204 });
  });

  // GET /assets/:file — JS/CSS chunks emitted by bun build with --asset-naming assets/[name]-[hash].[ext]
  router.get("/assets/:file", (_req, params) => {
    const filename = params["file"] ?? "";
    const file = Bun.file(path.join(DIST_DIR, "assets", filename));
    const ct = filename.endsWith(".css") ? "text/css" : "application/javascript";
    return new Response(file, { headers: { "content-type": ct } });
  });

  // GET /view/:id — raw .md file for a job output
  router.get("/view/:id", async (_req, params) => {
    const id = params["id"] ?? "";
    const filePath = `${OUTPUT_DIR}/${id}.md`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const text = await file.text();
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // GET /poll-log — recent queue dispatch events (newest first)
  router.get("/poll-log", (_req, _params) => {
    return new Response(JSON.stringify([...pollLog].reverse()), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });
}
