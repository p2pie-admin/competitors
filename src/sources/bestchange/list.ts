import { parseListPage } from "./pages";
import { SOURCE_ID } from "./constants";
import type { JobCtx } from "../../core/types";
import { registrableDomain } from "../../core/normalize";
import { readFileSync } from "fs";
import path from "path";

/** Offline seed (id, slug, website) shipped with the service: lets matching work before any crawl. */
type SeedRow = { ext_id: string; name: string; slug: string | null; domain: string | null };

export const loadSeed = (file = path.join(__dirname, "../../../seed/bestchange-links.json")): SeedRow[] => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SeedRow[];
  } catch {
    return [];
  }
};

export const applySeed = ({ store, config }: Pick<JobCtx, "store" | "config">, seed = loadSeed()): number => {
  let n = 0;
  for (const s of seed) {
    const e = store.getExchanger(SOURCE_ID, s.ext_id);
    if (!e) continue;
    if (s.slug && !e.slug) {
      store.setSlug(SOURCE_ID, s.ext_id, s.slug, `${config.BESTCHANGE_SITE}/${s.slug}-exchanger.html`);
      n++;
    }
    const d = registrableDomain(s.domain);
    if (d && !e.domain) store.setDomainIfMissing(SOURCE_ID, s.ext_id, d);
  }
  return n;
};

/** The full exchanger list page: id <-> slug for every exchanger in one request. */
export const runListJob = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, client, config } = ctx;
  const res = await client.get(`${config.BESTCHANGE_SITE}/list.html`, { fallbackDecode: "windows-1251", maxBytes: 6 * 1024 * 1024 });
  const rows = parseListPage(res.text ?? "");
  if (rows.length < 100) throw new Error(`list page parsed to ${rows.length} rows, expected hundreds`);

  let slugged = 0;
  let unknown = 0;
  store.db.transaction(() => {
    for (const r of rows) {
      const e = store.getExchanger(SOURCE_ID, r.extId);
      if (!e) {
        unknown++; // appears on the site but not (yet) in the API snapshot
        continue;
      }
      if (r.slug) {
        if (e.slug !== r.slug) slugged++;
        store.setSlug(SOURCE_ID, r.extId, r.slug, `${config.BESTCHANGE_SITE}/${r.slug}-exchanger.html`);
      }
    }
  })();
  const seeded = applySeed(ctx);
  return { rows: rows.length, slugged, unknown, seeded };
};
