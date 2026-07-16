import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const target = process.argv[2];
const entries = { api: ["apps/api/src/server.ts", "runtime/api/server.js"], worker: ["apps/worker/src/worker.ts", "runtime/worker/worker.js"], web: ["apps/web/src/server.ts", "runtime/web/server-dist/server.js"] };
if (!(target in entries)) throw new Error("Choose api, worker, or web runtime artifact.");
const [entryPoint, output] = entries[target];
await mkdir(dirname(resolve(output)), { recursive: true });
await build({ entryPoints: [resolve(entryPoint)], outfile: resolve(output), bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: false, legalComments: "none", plugins: [{ name: "external-runtime-packages", setup(build) { build.onResolve({ filter: /^[^./].*/ }, (args) => args.kind === "entry-point" || isAbsolute(args.path) || args.path.startsWith("@aio/") ? undefined : { path: args.path, external: true }); }}] });
