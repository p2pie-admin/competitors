import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runListJob, runMatchJob, runPagesJob } from "./jobs";

export const wellcrypto: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.WELLCRYPTO_SITE,
  enabled: (c) => c.WELLCRYPTO_ENABLED,
  jobs: (c) => [
    { name: "wellcrypto.list", everyMs: 24 * 3600_000, initialDelayMs: 190_000, run: runListJob },
    { name: "wellcrypto.match", everyMs: 60 * 60_000, initialDelayMs: 250_000, run: runMatchJob },
    { name: "wellcrypto.pages", everyMs: c.WELLCRYPTO_CRAWL_TICK_MIN * 60_000, initialDelayMs: 360_000, run: runPagesJob },
  ],
};
