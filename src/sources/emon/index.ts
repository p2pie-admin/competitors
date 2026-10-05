import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runListJob, runMatchJob, runPagesJob } from "./jobs";

export const emon: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.EMON_SITE,
  enabled: (c) => c.EMON_ENABLED,
  jobs: (c) => [
    { name: "emon.list", everyMs: 24 * 3600_000, initialDelayMs: 170_000, run: runListJob },
    { name: "emon.match", everyMs: 60 * 60_000, initialDelayMs: 230_000, run: runMatchJob },
    { name: "emon.pages", everyMs: c.EMON_CRAWL_TICK_MIN * 60_000, initialDelayMs: 330_000, run: runPagesJob },
  ],
};
