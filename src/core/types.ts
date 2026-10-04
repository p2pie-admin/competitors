import type { Config } from "../config";
import type { Store } from "../db/store";
import type { PoliteClient } from "../http/client";
import type { Logger } from "../log";
import type { OurExchangers } from "./ourExchangers";

export type JobCtx = {
  store: Store;
  client: PoliteClient;
  config: Config;
  ours: OurExchangers;
  log: Logger;
  /** Plain (non-crawling) HTTP for our own infrastructure: front revalidation. Injectable for tests. */
  fetch?: typeof fetch;
};

export type JobDef = {
  /** Unique, "<source>.<what>". */
  name: string;
  everyMs: number;
  initialDelayMs: number;
  run: (ctx: JobCtx) => Promise<Record<string, unknown>>;
};

export type SourceDef = {
  id: string;
  name: string;
  baseUrl: (c: Config) => string;
  enabled: (c: Config) => boolean;
  jobs: (c: Config) => JobDef[];
};
