#!/usr/bin/env node
/**
 * Minimal static server for a plugin market index. Loopback only, no auth:
 * it exists so the index has an http(s) URL, which is what DSH requires.
 *
 *   node scripts/serve.mjs [directory] [port]
 *
 * Then use http://127.0.0.1:<port>/index.json as the index source.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8788);

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8"
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.json";
  const target = resolve(join(root, normalize(pathname)));
  if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }
  readFile(target).then((body) => {
    response.writeHead(200, {
      "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(body);
  }).catch(() => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found: " + pathname);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("serving " + root);
  console.log("index source: http://127.0.0.1:" + port + "/index.json");
});
