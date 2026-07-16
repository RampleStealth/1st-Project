import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@aio/config";
import { browserSecurityHeaders } from "./security-headers.js";

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
const securityHeaders = browserSecurityHeaders(config);

function safeAssetPath(url: string) {
  try {
    const requested = normalize(decodeURIComponent(url.split("?")[0])).replace(/^([/\\])+/, "");
    const candidate = join(clientRoot, requested || "index.html");
    return candidate.startsWith(clientRoot) ? candidate : null;
  } catch { return null; }
}

createServer((request, response) => {
  const requested = safeAssetPath(request.url ?? "/");
  const asset = requested && existsSync(requested) ? requested : join(clientRoot, "index.html");
  if (!existsSync(asset)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8", ...securityHeaders });
    response.end("Web application is not built.");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(asset)] ?? "application/octet-stream",
    ...securityHeaders
  });
  createReadStream(asset).pipe(response);
}).listen(config.WEB_PORT, "0.0.0.0");
