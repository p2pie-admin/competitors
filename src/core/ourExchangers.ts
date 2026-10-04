import { logger } from "../log";

const log = logger("ours");

export type OurExchanger = {
  id: string;
  name: string;
  display_name?: string | null;
  status?: string | null;
  ref_link?: string | null;
  rates_link?: string | null;
};

const TTL_MS = 10 * 60_000;

/**
 * Our own exchangers, read from `server` (GET /exchangers). Cached; when the server is
 * unreachable the last good copy is served so matching never flaps because of a restart.
 */
export class OurExchangers {
  private cache: { at: number; list: OurExchanger[] } | null = null;

  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(): Promise<OurExchanger[]> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.list;
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/exchangers`, {
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      const list = normalize(body);
      if (list.length === 0) throw new Error("empty exchangers list");
      this.cache = { at: Date.now(), list };
      return list;
    } catch (err) {
      if (this.cache) {
        log.warn("server unreachable, serving stale exchangers", { err: String(err) });
        return this.cache.list;
      }
      throw err;
    }
  }

  async byId(id: string): Promise<OurExchanger | undefined> {
    return (await this.list()).find((e) => e.id === id);
  }
}

/** `server` returns an object keyed by id; accept an array too. */
export const normalize = (body: unknown): OurExchanger[] => {
  const items: unknown[] = Array.isArray(body) ? body : body && typeof body === "object" ? Object.values(body as object) : [];
  const out: OurExchanger[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (o.id == null || typeof o.name !== "string") continue;
    out.push({
      id: String(o.id),
      name: o.name,
      display_name: typeof o.display_name === "string" ? o.display_name : null,
      status: typeof o.status === "string" ? o.status : null,
      ref_link: typeof o.ref_link === "string" ? o.ref_link : null,
      rates_link: typeof o.rates_link === "string" ? o.rates_link : null,
    });
  }
  return out;
};
