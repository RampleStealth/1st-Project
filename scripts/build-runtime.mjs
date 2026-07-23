import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const entries = {
  api: ["apps/api/src/server.ts", "apps/api/runtime/server.js"],
  worker: ["apps/worker/src/worker.ts", "apps/worker/runtime/worker.js"],
  web: ["apps/web/src/server.ts", "apps/web/runtime/server.js"],
  operations: ["scripts/operations.ts", "apps/worker/runtime/operations.js"],
  "db-migrate": ["packages/database/src/migrate.ts", "packages/database/runtime/migrate.js"],
  "db-status": ["packages/database/src/migration-status.ts", "packages/database/runtime/migration-status.js"],
  "db-verify": ["packages/database/src/migration-verify.ts", "packages/database/runtime/migration-verify.js"]
};
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0 ? requestedTargets : Object.keys(entries);

for (const target of targets) {
  if (!(target in entries)) {
    throw new Error(`Unknown runtime target: ${target}`);
  }
  const [entryPoint, output] = entries[target];
  await mkdir(dirname(resolve(output)), { recursive: true });
  await build({
    entryPoints: [resolve(entryPoint)],
    outfile: resolve(output),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    plugins: [{
      name: "external-runtime-packages",
      setup(build) {
        build.onResolve(
          { filter: /^[^./].*/ },
          (args) => args.kind === "entry-point" || isAbsolute(args.path) || args.path.startsWith("@aio/")
            ? undefined
            : { path: args.path, external: true }
        );
      }
    }]
  });
}
