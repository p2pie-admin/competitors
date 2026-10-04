import { parseKeExchangerPage, parseKeList } from "./pages";
import { SOURCE_ID } from "./constants";
import { runPageTick } from "../../core/crawlTick";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import type { JobCtx } from "../../core/types";

const exchangerUrl = (site: string, slug: string) => `${site}/ru/obmennik/${slug}/feedbacks.html`;

/** The full exchanger list (id, slug, reserve, review counters) — also the discovery of new/gone exchangers. */
export const runListJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const site = config.KURSEXPERT_SITE;
  const res = await client.get(`${site}/ru/obmennik.html`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 90_000 });
  const rows = parseKeList(res.text ?? "");
  if (rows.length < 100) throw new Error(`list parsed to ${rows.length} rows, expected hundreds`);

  const present = new Set<string>();
  const day = new Date().toISOString().slice(0, 10);
  let slugChanged = 0;
  store.db.transaction(() => {
    for (const r of rows) {
      present.add(r.extId);
      const before = store.getExchanger(SOURCE_ID, r.extId);
      store.upsertExchangerFromApi({
        source: SOURCE_ID,
        ext_id: r.extId,
        name: r.name,
        reserve_usd: r.reserveUsd,
        directions: null,
        reviews_pos: r.positive,
        reviews_neg: r.negative,
        reviews_total: (r.positive ?? 0) + (r.neutral ?? 0) + (r.negative ?? 0),
        age_text: r.ageText,
      });
      if (before?.slug !== r.slug) slugChanged++;
      store.setSlug(SOURCE_ID, r.extId, r.slug, exchangerUrl(site, r.slug));
      store.recordDaily(SOURCE_ID, r.extId, day, { reviews_pos: r.positive, reviews_neg: r.negative, directions: null, reserve_usd: r.reserveUsd });
    }
  })();
  const gone = store.markGoneExcept(SOURCE_ID, present);
  log.info("kursexpert list imported", { rows: rows.length, gone });
  return { rows: rows.length, slugChanged, gone };
};

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID);

/** One crawl tick over the stalest linked exchanger pages (first page of reviews, ~40 newest). */
export const runPagesJob = (ctx: JobCtx): Promise<Record<string, unknown>> =>
  runPageTick(ctx, {
    source: SOURCE_ID,
    refreshHours: ctx.config.KURSEXPERT_LINKED_REFRESH_H,
    perTick: ctx.config.KURSEXPERT_PAGES_PER_TICK,
    urlFor: (ex) => exchangerUrl(ctx.config.KURSEXPERT_SITE, ex.slug!),
    parse: (html, url) => {
      const page = parseKeExchangerPage(html, url);
      return { domain: page.domain, reviews: page.reviews, recognised: !!page.title && (page.reviews.length > 0 || /отзыв/i.test(page.title)) };
    },
  });
