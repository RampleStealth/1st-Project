import dotenv from "dotenv";
import { loadConfig } from "@aio/config";
import { createApiApp } from "./app.js";
import { createProductionApiDependencies } from "./dependencies.js";

dotenv.config({ path: "../../.env" });
const config = loadConfig();
const dependencies = await createProductionApiDependencies(config);
const app = await createApiApp(dependencies);

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { dependencies.logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
