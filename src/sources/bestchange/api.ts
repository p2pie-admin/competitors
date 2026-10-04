import { aggregateRates, parseExchangers, unpackInfoZip } from "./dat";
import { SOURCE_ID } from "./constants";
import { dayKey } from "../../core/normalize";
import type { JobCtx } from "../../core/types";

const MAX_ZIP_BYTES = 96 * 1024 * 1024;

// Refuse implausibly small snapshots: a truncated download must never mark every exchanger "gone".
const MIN_EXCHANGERS = 100;
const MIN_AGGREGATED = 50;

/**
 * Official BestChange export (info.zip): all exchangers, their reserves, number of directions
 * and review counters. Conditional GET keeps repeated polls cheap when nothing changed.
 */
export const runApiJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const etag = store.kvGet("bestchange:zip:etag");
  const lastModified = store.kvGet("bestchange:zip:last-modified");
  const res = await client.get(config.BESTCHANGE_API_ZIP, {
    decode: "binary",
    maxBytes: MAX_ZIP_BYTES,
    timeoutMs: 180_000,
    etag,
    lastModified,
    // The export is an official data feed on a dedicated host; its robots.txt (404) allows access.
    respectRobots: true,
    headers: { accept: "application/zip,*/*;q=0.5" },
  });
  if (res.notModified) return { notModified: true };
  if (!res.bytes) throw new Error("empty body");

  const files = unpackInfoZip(res.bytes);
  const exchangers = parseExchangers(files["bm_exch.dat"]!);
  const agg = aggregateRates(files["bm_rates.dat"]!);
  if (exchangers.length < MIN_EXCHANGERS || agg.size < MIN_AGGREGATED) {
    throw new Error(`suspicious snapshot: ${exchangers.length} exchangers, ${agg.size} with rates`);
  }

  const day = dayKey();
  const present = new Set<string>();
  const tx = store.db.transaction(() => {
    for (const e of exchangers) {
      const a = agg.get(e.id);
      present.add(e.id);
      store.upsertExchangerFromApi({
        source: SOURCE_ID,
        ext_id: e.id,
        name: e.name,
        reserve_usd: e.reserveUsd,
        directions: a ? a.directions : 0,
        reviews_pos: a?.reviewsPos ?? null,
        reviews_neg: a?.reviewsNeg ?? null,
      });
      store.recordDaily(SOURCE_ID, e.id, day, {
        reviews_pos: a?.reviewsPos ?? null,
        reviews_neg: a?.reviewsNeg ?? null,
        directions: a ? a.directions : 0,
        reserve_usd: e.reserveUsd,
      });
    }
    return store.markGoneExcept(SOURCE_ID, present);
  });
  const gone = tx();

  if (res.headers["etag"]) store.kvSet("bestchange:zip:etag", res.headers["etag"]);
  if (res.headers["last-modified"]) store.kvSet("bestchange:zip:last-modified", res.headers["last-modified"]);
  store.kvSet("bestchange:api:updated", String(Math.floor(Date.now() / 1000)));
  log.info("bestchange api imported", { exchangers: exchangers.length, withRates: agg.size, gone, zipBytes: res.size });
  return { exchangers: exchangers.length, withRates: agg.size, gone, zipBytes: res.size, rows: [...agg.values()].reduce((n, a) => n + a.directions, 0) };
};
