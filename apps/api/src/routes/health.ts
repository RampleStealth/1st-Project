import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance<any, any, any, any>) {
  app.get("/health", async () => ({ status: "ok" }));
}
