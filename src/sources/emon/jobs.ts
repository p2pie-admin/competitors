import { parseEmExchangerPage, parseEmList } from "./pages";
import { SOURCE_ID } from "./constants";
import { runPageTick } from "../../core/crawlTick";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import type { JobCtx } from "../../core/types";

const pageUrl = (site: string, id: string) => `${site}/exchanger/${id}`;

export const runListJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const site = config.EMON_SITE;
  const res = await client.get(`${site}/exchangers`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 90_000 });
  const rows = parseEmList(res.text ?? "");
  if (rows.length < 100) throw new Error(`list parsed to ${rows.length} rows, expected hundreds`);

  const present = new Set<string>();
  const day = new Date().toISOString().slice(0, 10);
  store.db.transaction(() => {
    for (const r of rows) {
      present.add(r.extId);
      store.upsertExchangerFromApi({
        source: SOURCE_ID,
        ext_id: r.extId,
        name: r.name,
        reserve_usd: r.reserveUsd,
        directions: r.rates,
        reviews_pos: r.positive,
        reviews_neg: r.negative,
        reviews_total: (r.positive ?? 0) + (r.negative ?? 0),
        age_text: r.ageText,
      });
      store.setSlug(SOURCE_ID, r.extId, r.extId, pageUrl(site, r.extId));
      if (r.domain) store.setDomainIfMissing(SOURCE_ID, r.extId, r.domain);
      if (r.country) store.updateFromPage(SOURCE_ID, r.extId, { country: r.country });
      store.recordDaily(SOURCE_ID, r.extId, day, { reviews_pos: r.positive, reviews_neg: r.negative, directions: r.rates, reserve_usd: r.reserveUsd });
    }
  })();
  // The list also carries the country: updateFromPage stamped page_fetched_at, undo that so the pages job still visits them.
  store.db.prepare("UPDATE source_exchangers SET page_fetched_at = NULL WHERE source = ? AND page_hash IS NULL").run(SOURCE_ID);
  const gone = store.markGoneExcept(SOURCE_ID, present);
  log.info("e-mon list imported", { rows: rows.length, gone });
  return { rows: rows.length, gone };
};

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID);

export const runPagesJob = (ctx: JobCtx): Promise<Record<string, unknown>> =>
  runPageTick(ctx, {
    source: SOURCE_ID,
    refreshHours: ctx.config.EMON_LINKED_REFRESH_H,
    perTick: ctx.config.EMON_PAGES_PER_TICK,
    urlFor: (ex) => pageUrl(ctx.config.EMON_SITE, ex.ext_id),
    parse: (html, url) => {
      const page = parseEmExchangerPage(html, url);
      return { reviews: page.reviews, recognised: !!page.title && /отзыв/i.test(page.title) };
    },
  });
