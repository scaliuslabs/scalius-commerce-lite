// The media origin of the fidelity stack: a small static server over the
// generated pool, standing in for the R2-backed media route. The Platform
// document's mediaUrl points here, so every image and video the pages load
// comes from it. Browsers abort image downloads all the time (navigation,
// lazy loading), and a burst of aborted responses crashes local
// `wrangler dev` 4.128 (reproduced: ~240 rounds of 40 aborted image fetches);
// this keeps that traffic off the Workers under test. Byte sizes, formats and
// cache headers match what R2 serves.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";

const TYPES = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", mp4: "video/mp4" };

/** `media/pool/p000.jpg/320.webp` -> <pool>/p000.jpg/320.webp; `media/pool/p000.jpg` -> <pool>/p000.jpg.orig. */
export function poolFile(poolDir, urlPath) {
  const m = /^\/media\/(pool|legacy)\/([A-Za-z0-9._-]+)(?:\/(\d{2,4})\.webp)?$/.exec(urlPath);
  if (!m) return null;
  const [, , key, width] = m;
  const file = width ? join(poolDir, key, `${width}.webp`) : /\.mp4$/.test(key) ? join(poolDir, key) : join(poolDir, `${key}.orig`);
  const safe = normalize(file);
  return safe.startsWith(normalize(poolDir)) && existsSync(safe) ? { file: safe, type: TYPES[(width ? "webp" : key.split(".").pop()).toLowerCase()] ?? "application/octet-stream" } : null;
}

export function startMediaServer(poolDir, port) {
  const server = createServer((req, res) => {
    const hit = req.method === "GET" || req.method === "HEAD" ? poolFile(poolDir, decodeURIComponent(new URL(req.url, "http://x").pathname)) : null;
    if (!hit) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const size = statSync(hit.file).size;
    const headers = { "content-type": hit.type, "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    } else res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(hit.file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "localhost" }, () => resolve({
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}
