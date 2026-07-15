import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@aio/config";

const config = loadConfig();
const clientRoot = join(fileURLToPath(new URL("../dist/client", import.meta.url)));
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

function safeAssetPath(url: string) {
  const requested = normalize(decodeURIComponent(url.split("?")[0])).replace(/^([/\\])+/, "");
  const candidate = join(clientRoot, requested || "index.html");
  return candidate.startsWith(clientRoot) ? candidate : null;
}

createServer((request, response) => {
  const requested = safeAssetPath(request.url ?? "/");
  const asset = requested && existsSync(requested) ? requested : join(clientRoot, "index.html");
  if (!existsSync(asset)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("Web application is not built.");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(asset)] ?? "application/octet-stream",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  createReadStream(asset).pipe(response);
}).listen(config.WEB_PORT, "0.0.0.0");
