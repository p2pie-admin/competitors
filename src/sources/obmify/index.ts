import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runListJob, runMatchJob, runPagesJob } from "./jobs";

export const obmify: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.OBMIFY_SITE,
  enabled: (c) => c.OBMIFY_ENABLED,
  jobs: (c) => [
    { name: "obmify.list", everyMs: 24 * 3600_000, initialDelayMs: 200_000, run: runListJob },
    { name: "obmify.match", everyMs: 60 * 60_000, initialDelayMs: 260_000, run: runMatchJob },
    { name: "obmify.pages", everyMs: c.OBMIFY_CRAWL_TICK_MIN * 60_000, initialDelayMs: 390_000, run: runPagesJob },
  ],
};
