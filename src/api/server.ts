import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../config";
import type { Store } from "../db/store";
import type { Scheduler } from "../core/scheduler";
import type { OurExchangers } from "../core/ourExchangers";
import { registerPublicRoutes } from "./public";
import { registerAdminRoutes } from "./admin";

export const buildServer = (deps: { store: Store; config: Config; scheduler: Scheduler | null; ours: OurExchangers }): FastifyInstance => {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
    // Health checks every 30 s would drown the log; requests are logged at debug level instead.
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
    maxParamLength: 200,
  });
  app.addHook("onResponse", async (req, reply) => {
    if (req.url === "/health") return;
    req.log.debug({ method: req.method, url: req.url.split("?")[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
  });
  registerPublicRoutes(app, deps.store, deps.config);
  registerAdminRoutes(app, deps);
  return app;
};
