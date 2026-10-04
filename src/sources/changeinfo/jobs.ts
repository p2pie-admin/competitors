import { parseCiList, parseCiReviewPage } from "./pages";
import { SOURCE_ID } from "./constants";
import { runPageTick } from "../../core/crawlTick";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import type { JobCtx } from "../../core/types";

const reviewUrl = (site: string, slug: string) => `${site}/review/${encodeURIComponent(slug)}`;

/** The exchanger list: names, websites (so matching can use domains), reserves and comment counters. */
export const runListJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const site = config.CHANGEINFO_SITE;
  const res = await client.get(`${site}/exchangers`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 90_000 });
  const rows = parseCiList(res.text ?? "");
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
        reserve_usd: r.reserveUsd,
        directions: r.rates,
        reviews_pos: r.positive,
        reviews_neg: r.negative,
        reviews_total: (r.positive ?? 0) + (r.negative ?? 0),
      });
      store.setSlug(SOURCE_ID, r.slug, r.slug, reviewUrl(site, r.slug));
      if (r.domain) store.setDomainIfMissing(SOURCE_ID, r.slug, r.domain);
      store.recordDaily(SOURCE_ID, r.slug, day, { reviews_pos: r.positive, reviews_neg: r.negative, directions: r.rates, reserve_usd: r.reserveUsd });
    }
  })();
  const gone = store.markGoneExcept(SOURCE_ID, present);
  log.info("changeinfo list imported", { rows: rows.length, gone });
  return { rows: rows.length, gone };
};

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID);

export const runPagesJob = (ctx: JobCtx): Promise<Record<string, unknown>> =>
  runPageTick(ctx, {
    source: SOURCE_ID,
    refreshHours: ctx.config.CHANGEINFO_LINKED_REFRESH_H,
    perTick: ctx.config.CHANGEINFO_PAGES_PER_TICK,
    urlFor: (ex) => reviewUrl(ctx.config.CHANGEINFO_SITE, ex.slug!),
    parse: (html, url) => {
      const page = parseCiReviewPage(html, url);
      return { reviews: page.reviews, recognised: !!page.title && /отзыв/i.test(page.title) };
    },
  });
