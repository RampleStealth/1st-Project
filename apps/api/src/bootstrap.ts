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

type BootstrapProcess = Pick<NodeJS.Process, "once"> & { exit(code?: number): never };

export type BootstrapDependencies = {
  loadEnvironment: () => void;
  loadConfig: typeof loadConfig;
  createProductionApiDependencies: typeof createProductionApiDependencies;
  createApiApp: typeof createApiApp;
  process: BootstrapProcess;
};

const productionBootstrapDependencies: BootstrapDependencies = {
  loadEnvironment: () => { dotenv.config({ path: "../../.env" }); },
  loadConfig,
  createProductionApiDependencies,
  createApiApp,
  process
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

function installSignalHandlers(runtime: ApiRuntime, runtimeProcess: BootstrapProcess) {
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    void stopApi(runtime).then(
      () => runtimeProcess.exit(0),
      (error) => {
        runtime.dependencies.logger.error({ err: error, signal }, "api shutdown failed");
        runtimeProcess.exit(1);
      }
    );
  };

  runtimeProcess.once("SIGINT", () => shutdown("SIGINT"));
  runtimeProcess.once("SIGTERM", () => shutdown("SIGTERM"));
}

export async function startApi(overrides: Partial<BootstrapDependencies> = {}): Promise<ApiRuntime> {
  const bootstrapDependencies = { ...productionBootstrapDependencies, ...overrides };
  bootstrapDependencies.loadEnvironment();
  const config = bootstrapDependencies.loadConfig();
  const dependencies = await bootstrapDependencies.createProductionApiDependencies(config);
  let app: FastifyInstance | undefined;

  try {
    app = await bootstrapDependencies.createApiApp(dependencies);
    const runtime: ApiRuntime = { app, dependencies };
    await app.listen({ host: "0.0.0.0", port: config.PORT });
    installSignalHandlers(runtime, bootstrapDependencies.process);
    return runtime;
  } catch (error) {
    dependencies.logger.fatal({ err: error }, "api startup failed");
    if (app) {
      await stopApi({ app, dependencies });
    } else {
      await dependencies.redis.quit();
    }
    bootstrapDependencies.process.exit(1);
    throw error;
  }
}
