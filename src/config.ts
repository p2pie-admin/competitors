import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  // HTTP API (internal network only; not published through the reverse proxy).
  COMPETITORS_PORT: int(5100, 1, 65535),
  // Bearer token for /admin/*. Without it the admin API is disabled.
  COMPETITORS_ADMIN_TOKEN: z.string().optional(),
  // Where SQLite lives. Mounted as a docker volume in production.
  DATA_DIR: z.string().default("./data"),
  // Identification sent to every monitoring we fetch from. Keep a real contact: owners of the
  // sources must be able to reach us and ask us to stop or slow down.
  CONTACT_EMAIL: z.string().default("support@p2pie.com"),
  CONTACT_URL: z.string().default("https://p2pie.com"),
  // Our own server (exchangers list used to match source exchangers with ours).
  OUR_SERVER_URL: z.string().default("http://server:5000"),
  // After new reviews arrive the exchanger page is regenerated through the front's on-demand ISR
  // (POST {FRONT_URL}/api/revalidate). Both must be set, otherwise pages refresh on their own TTL (1 h).
  FRONT_URL: z.string().optional(),
  REVALIDATE_SECRET: z.string().optional(),
  // Master switches.
  ENABLE_JOBS: bool(true),
  // Publishing of review TEXTS. When false the service still collects and counts, but the public
  // API returns no texts (counts and links only).
  PUBLISH_REVIEW_TEXTS: bool(true),

  // --- BestChange ---
  BESTCHANGE_ENABLED: bool(true),
  BESTCHANGE_SITE: z.string().default("https://www.bestchange.ru"),
  // Official public export (documented by BestChange for partners): plain HTTP, ~16 MB zip.
  BESTCHANGE_API_ZIP: z.string().default("http://api.bestchange.ru/info.zip"),
  BESTCHANGE_API_INTERVAL_MIN: int(60, 5),
  // Minimum pause between two page requests to the same host.
  BESTCHANGE_CRAWL_DELAY_MS: int(6000, 1000),
  // How often an exchanger page is re-read: those linked to one of ours / the rest.
  BESTCHANGE_LINKED_REFRESH_H: int(12, 1),
  BESTCHANGE_OTHER_REFRESH_H: int(0, 0), // 0 = do not crawl exchangers we do not list
  // Hard cap per crawl tick so one run never hammers the site.
  BESTCHANGE_PAGES_PER_TICK: int(6, 1, 100),
  BESTCHANGE_CRAWL_TICK_MIN: int(10, 1),

  // Review moderation / publication limits.
  MIN_REVIEW_CHARS: int(15, 1),
  MAX_PUBLIC_REVIEWS: int(30, 1, 200),
  // Reviews older than this are kept but not shown (stale social proof is misleading).
  MAX_REVIEW_AGE_DAYS: int(365, 1),
});

export type Config = z.infer<typeof schema> & { userAgent: string; dataDir: string };

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = schema.parse(env);
  const userAgent = `p2pie-competitors/1.0 (+${parsed.CONTACT_URL}; ${parsed.CONTACT_EMAIL})`;
  return { ...parsed, userAgent, dataDir: parsed.DATA_DIR };
};

export const config: Config = loadConfig();
