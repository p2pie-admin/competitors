import { parseKeExchangerPage, parseKeList } from "./pages";
import { SOURCE_ID } from "./constants";
import { BlockedByRobotsError, HttpError } from "../../http/errors";
import { addStats, emptyImportStats, importReviews } from "../../core/importReviews";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import { revalidateExchangerPages } from "../../core/revalidate";
import { sha1 } from "../../core/normalize";
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
export const runPagesJob = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, client, config, log } = ctx;
  const site = config.KURSEXPERT_SITE;
  let batch = store.crawlCandidates(SOURCE_ID, config.KURSEXPERT_LINKED_REFRESH_H * 3600, false, config.KURSEXPERT_PAGES_PER_TICK);
  const total = emptyImportStats();
  const changed = new Set<string>();
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  for (const ex of batch) {
    const url = exchangerUrl(site, ex.slug!);
    try {
      const res = await client.get(url, { maxBytes: 4 * 1024 * 1024 });
      fetched++;
      const page = parseKeExchangerPage(res.text ?? "", url);
      if (!page.title || (page.reviews.length === 0 && !/отзыв/i.test(page.title))) {
        throw new Error("page layout not recognised (no title / reviews)");
      }
      store.updateFromPage(SOURCE_ID, ex.ext_id, { domain: page.domain, page_hash: sha1(page.reviews.map((r) => r.extReviewId + r.text).join("|")) });
      const s = importReviews(ctx, SOURCE_ID, ex, page.reviews, url);
      addStats(total, s);
      if (s.inserted + s.updated > 0) {
        const link = store.getLink(SOURCE_ID, ex.ext_id);
        if (link?.our_name) changed.add(link.our_name);
      }
    } catch (err) {
      if (err instanceof BlockedByRobotsError) {
        store.touchPageFetched(SOURCE_ID, ex.ext_id);
        skipped++;
        continue;
      }
      failed++;
      log.warn("kursexpert page failed", { url, err: err instanceof Error ? err.message : String(err) });
      store.touchPageFetched(SOURCE_ID, ex.ext_id);
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) break;
      if (err instanceof Error && err.name === "CircuitOpenError") break;
    }
  }
  batch = [];
  const rv = changed.size ? await revalidateExchangerPages(config, [...changed], ctx.fetch) : { requested: 0, ok: true };
  return { fetched, failed, skipped, ...total, revalidated: rv.requested, revalidateOk: rv.ok };
};
