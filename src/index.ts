import { config } from "./config";
import { openDb } from "./db";
import { Store } from "./db/store";
import { logger } from "./log";
import { PoliteClient } from "./http/client";
import { OurExchangers } from "./core/ourExchangers";
import { Scheduler } from "./core/scheduler";
import { SOURCES } from "./sources/registry";
import { buildServer } from "./api/server";
import { nowSec } from "./db";
import type { JobCtx } from "./core/types";

const log = logger("main");

const main = async () => {
  const db = openDb(config.dataDir);
  const store = new Store(db);
  const closed = store.closeStaleRuns();
  if (closed) log.warn("closed runs interrupted by restart", { closed });

  for (const s of SOURCES) store.ensureSource(s.id, s.name, s.baseUrl(config), s.enabled(config));

  const client = new PoliteClient({
    userAgent: config.userAgent,
    minDelayMs: config.BESTCHANGE_CRAWL_DELAY_MS,
    hooks: {
      onFetch: (f) => store.logFetch(f),
      loadCircuit: (host) => {
        const v = store.kvGet(`circuit:${host}`);
        return v ? Number(v) : null;
      },
      saveCircuit: (host, until) => (until ? store.kvSet(`circuit:${host}`, String(until)) : store.kvDelete(`circuit:${host}`)),
    },
  });
  const ours = new OurExchangers(config.OUR_SERVER_URL);
  const ctx: JobCtx = { store, client, config, ours, log: logger("job") };

  let scheduler: Scheduler | null = null;
  if (config.ENABLE_JOBS) {
    scheduler = new Scheduler(ctx);
    for (const s of SOURCES) {
      if (!s.enabled(config)) continue;
      for (const job of s.jobs(config)) scheduler.add(job);
    }
    scheduler.add({
      name: "housekeeping",
      everyMs: 24 * 3600_000,
      initialDelayMs: 600_000,
      run: async () => {
        store.pruneLogs(14);
        db.pragma("wal_checkpoint(TRUNCATE)");
        return { at: nowSec() };
      },
    });
  }

  const app = buildServer({ store, config, scheduler, ours });
  await app.listen({ port: config.COMPETITORS_PORT, host: "0.0.0.0" });
  scheduler?.start();
  log.info("competitors service started", { port: config.COMPETITORS_PORT, jobs: scheduler ? scheduler.jobs().map((j) => j.name) : "disabled", textsEnabled: config.PUBLISH_REVIEW_TEXTS });

  const shutdown = async (sig: string) => {
    log.info("shutting down", { sig });
    scheduler?.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
