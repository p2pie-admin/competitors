import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runListJob, runMatchJob, runPagesJob } from "./jobs";

export const kursexpert: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.KURSEXPERT_SITE,
  enabled: (c) => c.KURSEXPERT_ENABLED,
  jobs: (c) => [
    { name: "kursexpert.list", everyMs: 24 * 3600_000, initialDelayMs: 120_000, run: runListJob },
    { name: "kursexpert.match", everyMs: 60 * 60_000, initialDelayMs: 180_000, run: runMatchJob },
    { name: "kursexpert.pages", everyMs: c.KURSEXPERT_CRAWL_TICK_MIN * 60_000, initialDelayMs: 270_000, run: runPagesJob },
  ],
};
