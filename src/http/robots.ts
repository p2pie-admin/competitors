import robotsParser from "robots-parser";
import { logger } from "../log";

const log = logger("robots");

type Parsed = ReturnType<typeof robotsParser>;
type Entry = { fetchedAt: number; parsed: Parsed | null; allowAll: boolean; denyAll: boolean };

export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; body: string }>;

const TTL_MS = 6 * 3600_000;
const FAIL_TTL_MS = 10 * 60_000;

/**
 * robots.txt gate following RFC 9309:
 *  - 2xx: parse and obey;
 *  - 4xx (incl. 404): no restrictions;
 *  - 5xx / network error: treat as fully disallowed for a short while (be conservative).
 * Every outgoing page request goes through `allowed()`.
 */
export class RobotsGate {
  private cache = new Map<string, Entry>();

  constructor(private readonly userAgent: string, private readonly fetcher: RobotsFetcher, private readonly now: () => number = Date.now) {}

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = u.origin;
    let entry = this.cache.get(origin);
    const ttl = entry && entry.denyAll ? FAIL_TTL_MS : TTL_MS;
    if (!entry || this.now() - entry.fetchedAt > ttl) {
      entry = await this.load(origin);
      this.cache.set(origin, entry);
    }
    if (entry.denyAll) return false;
    if (entry.allowAll || !entry.parsed) return true;
    // robots-parser returns undefined for URLs of another origin; ours always match.
    return entry.parsed.isAllowed(url, this.userAgent) !== false;
  }

  /** Crawl-delay requested by the site for our agent, in ms (0 when none). */
  async crawlDelayMs(url: string): Promise<number> {
    const entry = this.cache.get(new URL(url).origin);
    const d = entry?.parsed?.getCrawlDelay(this.userAgent);
    return d && d > 0 ? Math.round(d * 1000) : 0;
  }

  private async load(origin: string): Promise<Entry> {
    const robotsUrl = `${origin}/robots.txt`;
    const fetchedAt = this.now();
    try {
      const res = await this.fetcher(robotsUrl);
      if (res.status >= 200 && res.status < 300) {
        return { fetchedAt, parsed: robotsParser(robotsUrl, res.body), allowAll: false, denyAll: false };
      }
      if (res.status >= 400 && res.status < 500) return { fetchedAt, parsed: null, allowAll: true, denyAll: false };
      log.warn("robots.txt unavailable, treating as disallow", { robotsUrl, status: res.status });
      return { fetchedAt, parsed: null, allowAll: false, denyAll: true };
    } catch (err) {
      log.warn("robots.txt fetch failed, treating as disallow", { robotsUrl, err: String(err) });
      return { fetchedAt, parsed: null, allowAll: false, denyAll: true };
    }
  }
}
