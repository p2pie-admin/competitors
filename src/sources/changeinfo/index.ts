import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runListJob, runMatchJob, runPagesJob } from "./jobs";

export const changeinfo: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.CHANGEINFO_SITE,
  enabled: (c) => c.CHANGEINFO_ENABLED,
  jobs: (c) => [
    { name: "changeinfo.list", everyMs: 24 * 3600_000, initialDelayMs: 150_000, run: runListJob },
    { name: "changeinfo.match", everyMs: 60 * 60_000, initialDelayMs: 210_000, run: runMatchJob },
    { name: "changeinfo.pages", everyMs: c.CHANGEINFO_CRAWL_TICK_MIN * 60_000, initialDelayMs: 300_000, run: runPagesJob },
  ],
};
