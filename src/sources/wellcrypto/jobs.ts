import { parseWcExchangerPage, parseWcList } from "./pages";
import { SOURCE_ID } from "./constants";
import { runPageTick } from "../../core/crawlTick";
import { runMatchJob as runGenericMatch } from "../../core/matchJob";
import type { JobCtx } from "../../core/types";

const pageUrl = (site: string, slug: string) => `${site}/ru/exchangers/${slug}/`;

export const runListJob = async ({ store, client, config, log }: JobCtx): Promise<Record<string, unknown>> => {
  const site = config.WELLCRYPTO_SITE;
  const res = await client.get(`${site}/ru/exchangers/`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 90_000 });
  const rows = parseWcList(res.text ?? "");
  if (rows.length < 50) throw new Error(`list parsed to ${rows.length} rows, expected hundreds`);

  const present = new Set<string>();
  const day = new Date().toISOString().slice(0, 10);
  store.db.transaction(() => {
    for (const r of rows) {
      present.add(r.slug);
      const pos = r.feedback != null && r.feedback >= 0 ? r.feedback : null;
      const neg = r.feedback != null && r.feedback < 0 ? -r.feedback : null;
      store.upsertExchangerFromApi({
        source: SOURCE_ID,
        ext_id: r.slug,
        name: r.name,
        reserve_usd: r.reserveUsd,
        directions: r.rates,
        reviews_pos: pos,
        reviews_neg: neg,
        reviews_total: r.feedback != null ? Math.abs(r.feedback) : null,
        age_text: r.ageText,
      });
      store.setSlug(SOURCE_ID, r.slug, r.slug, pageUrl(site, r.slug));
      store.recordDaily(SOURCE_ID, r.slug, day, { reviews_pos: pos, reviews_neg: neg, directions: r.rates, reserve_usd: r.reserveUsd });
    }
  })();
  const gone = store.markGoneExcept(SOURCE_ID, present);
  log.info("wellcrypto list imported", { rows: rows.length, gone });
  return { rows: rows.length, gone };
};

export const runMatchJob = (ctx: JobCtx): Promise<Record<string, unknown>> => runGenericMatch(ctx, SOURCE_ID);

export const runPagesJob = (ctx: JobCtx): Promise<Record<string, unknown>> =>
  runPageTick(ctx, {
    source: SOURCE_ID,
    refreshHours: ctx.config.WELLCRYPTO_LINKED_REFRESH_H,
    perTick: ctx.config.WELLCRYPTO_PAGES_PER_TICK,
    urlFor: (ex) => pageUrl(ctx.config.WELLCRYPTO_SITE, ex.slug!),
    parse: (html, url) => {
      const page = parseWcExchangerPage(html, url);
      return { domain: page.domain, reviews: page.reviews, recognised: !!page.title && /обменник/i.test(page.title) };
    },
  });
