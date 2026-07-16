import dotenv from "dotenv";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@aio/config";
import { createApiApp, type ApiAppDependencies } from "./app.js";
import { createProductionApiDependencies } from "./dependencies.js";

export type ApiRuntime = {
  app: FastifyInstance;
  dependencies: ApiAppDependencies;
  shutdownPromise?: Promise<void>;
};

export async function stopApi(runtime: ApiRuntime): Promise<void> {
  if (!runtime.shutdownPromise) {
    runtime.shutdownPromise = (async () => {
      try {
        await runtime.app.close();
      } finally {
        await runtime.dependencies.redis.quit();
      }
    })();
  }
  return runtime.shutdownPromise;
}

function installSignalHandlers(runtime: ApiRuntime) {
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    void stopApi(runtime).then(
      () => process.exit(0),
      (error) => {
        runtime.dependencies.logger.error({ err: error, signal }, "api shutdown failed");
        process.exit(1);
      }
    );
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export async function startApi(): Promise<ApiRuntime> {
  dotenv.config({ path: "../../.env" });
  const config = loadConfig();
  const dependencies = await createProductionApiDependencies(config);
  const app = await createApiApp(dependencies);

  try {
    await app.listen({ host: "0.0.0.0", port: config.PORT });
  } catch (error) {
    dependencies.logger.fatal({ err: error }, "api startup failed");
    process.exit(1);
  }

  const runtime: ApiRuntime = { app, dependencies };
  installSignalHandlers(runtime);
  return runtime;
}
