import { parseObExchangerPage, parseObList } from "./pages";
import { SOURCE_ID } from "./constants";
import { runPageTick } from "../../core/crawlTick";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import type { JobCtx } from "../../core/types";

// Russian version of the exchanger page (review texts are in whatever language the author used).
const pageUrl = (site: string, slug: string) => `${site}/ru/${slug}-exchange`;

export const runListJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const site = config.OBMIFY_SITE;
  const res = await client.get(`${site}/exchanges`, { maxBytes: 12 * 1024 * 1024, timeoutMs: 90_000 });
  const rows = parseObList(res.text ?? "");
  if (rows.length < 50) throw new Error(`list parsed to ${rows.length} rows, expected hundreds`);

  const present = new Set<string>();
  const day = new Date().toISOString().slice(0, 10);
  store.db.transaction(() => {
    for (const r of rows) {
      present.add(r.slug);
      store.upsertExchangerFromApi({
        source: SOURCE_ID,
        ext_id: r.slug,
        name: r.name,
        reserve_usd: null,
        directions: r.directions,
        reviews_pos: null,
        reviews_neg: null,
        reviews_total: r.reviewsCount,
      });
      store.setSlug(SOURCE_ID, r.slug, r.slug, pageUrl(site, r.slug));
      store.recordDaily(SOURCE_ID, r.slug, day, { reviews_pos: r.reviewsCount, reviews_neg: null, directions: r.directions, reserve_usd: null });
    }
  })();
  const gone = store.markGoneExcept(SOURCE_ID, present);
  log.info("obmify list imported", { rows: rows.length, gone });
  return { rows: rows.length, gone };
};

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID);

export const runPagesJob = (ctx: JobCtx): Promise<Record<string, unknown>> =>
  runPageTick(ctx, {
    source: SOURCE_ID,
    refreshHours: ctx.config.OBMIFY_LINKED_REFRESH_H,
    perTick: ctx.config.OBMIFY_PAGES_PER_TICK,
    urlFor: (ex) => pageUrl(ctx.config.OBMIFY_SITE, ex.slug!),
    parse: (html, url) => {
      const page = parseObExchangerPage(html, url);
      return { domain: page.domain, reviews: page.reviews, recognised: !!page.title && (page.reviews.length > 0 || page.reviewCount != null) };
    },
  });
