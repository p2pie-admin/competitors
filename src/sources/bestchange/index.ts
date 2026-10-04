import type { SourceDef } from "../../core/types";
import { SOURCE_ID, SOURCE_NAME } from "./constants";
import { runApiJob } from "./api";
import { runListJob } from "./list";
import { runMatchJob } from "./match";
import { runPagesJob } from "./pages.job";

export const bestchange: SourceDef = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  baseUrl: (c) => c.BESTCHANGE_SITE,
  enabled: (c) => c.BESTCHANGE_ENABLED,
  jobs: (c) => [
    { name: "bestchange.api", everyMs: c.BESTCHANGE_API_INTERVAL_MIN * 60_000, initialDelayMs: 5_000, run: runApiJob },
    { name: "bestchange.list", everyMs: 24 * 3600_000, initialDelayMs: 90_000, run: runListJob },
    { name: "bestchange.match", everyMs: 60 * 60_000, initialDelayMs: 150_000, run: runMatchJob },
    { name: "bestchange.pages", everyMs: c.BESTCHANGE_CRAWL_TICK_MIN * 60_000, initialDelayMs: 240_000, run: runPagesJob },
  ],
};
