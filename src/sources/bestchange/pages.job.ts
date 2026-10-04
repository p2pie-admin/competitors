import { parseExchangerPage, type ParsedReview } from "./pages";
import { SOURCE_ID } from "./constants";
import { BlockedByRobotsError, HttpError } from "../../http/errors";
import { ratingToType } from "../../core/moderation";
import { addStats, emptyImportStats, importReviews, type ReviewImportStats, type ScrapedReview } from "../../core/importReviews";
import { sha1 } from "../../core/normalize";
import { revalidateExchangerPages } from "../../core/revalidate";
import type { JobCtx } from "../../core/types";

/** BestChange markup -> neutral shape; sentiment comes from the stars. */
const toScraped = (r: ParsedReview, pageUrl: string): ScrapedReview => ({
  extReviewId: r.extReviewId,
  kind: r.kind,
  author: r.author,
  country: r.country,
  rating: r.rating,
  sentiment: ratingToType(r.rating),
  postedAt: r.postedAt,
  permalink: r.permalink ?? `${pageUrl}?review=${r.extReviewId}`,
  text: r.text,
  flagTexts: r.flagTexts,
  reply: r.reply,
});

/**
 * One crawl tick: read the stalest few exchanger pages we care about. Only the plain page URL
 * (latest reviews + counters) is fetched; query URLs (?filter=, ?page=) are disallowed by the
 * site's robots.txt and are never requested.
 */
export const runPagesJob = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, client, config, log } = ctx;
  const linkedAgeSec = config.BESTCHANGE_LINKED_REFRESH_H * 3600;
  let batch = store.crawlCandidates(SOURCE_ID, linkedAgeSec, false, config.BESTCHANGE_PAGES_PER_TICK);
  if (batch.length < config.BESTCHANGE_PAGES_PER_TICK && config.BESTCHANGE_OTHER_REFRESH_H > 0) {
    const more = store.crawlCandidates(SOURCE_ID, config.BESTCHANGE_OTHER_REFRESH_H * 3600, true, config.BESTCHANGE_PAGES_PER_TICK - batch.length);
    const have = new Set(batch.map((b) => b.ext_id));
    batch = batch.concat(more.filter((m) => !have.has(m.ext_id)));
  }

  const total = emptyImportStats();
  const changedOurNames = new Set<string>();
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  for (const ex of batch) {
    const url = `${config.BESTCHANGE_SITE}/${ex.slug}-exchanger.html`;
    try {
      const res = await client.get(url, { fallbackDecode: "windows-1251", maxBytes: 4 * 1024 * 1024 });
      fetched++;
      const page = parseExchangerPage(res.text ?? "");
      if (page.extId && page.extId !== ex.ext_id) {
        // The slug points at a different exchanger (renamed/reused): never attribute reviews to the wrong one.
        log.warn("slug/id mismatch, dropping slug", { slug: ex.slug, expected: ex.ext_id, got: page.extId });
        store.clearSlug(SOURCE_ID, ex.ext_id);
        failed++;
        continue;
      }
      if (!page.extId && page.reviews.length === 0 && page.reviewsTotal == null) {
        throw new Error("page layout not recognised (no id, counters or reviews)");
      }
      store.updateFromPage(SOURCE_ID, ex.ext_id, {
        domain: page.domain,
        country: page.country,
        claims_open: page.claimsOpen,
        claims_closed: page.claimsClosed,
        reviews_total: page.reviewsTotal,
        aml: page.aml,
        age_text: page.ageText,
        on_source_text: page.onSourceText,
        directions: page.directions,
        reserve_usd: page.reserveUsd,
        page_hash: sha1(page.reviews.map((r) => r.extReviewId + r.text).join("|")),
      });
      const s = importReviews(ctx, SOURCE_ID, ex, page.reviews.map((r) => toScraped(r, url)), url);
      addStats(total, s);
      if (s.inserted + s.updated > 0) {
        const link = store.getLink(SOURCE_ID, ex.ext_id);
        if (link?.our_name) changedOurNames.add(link.our_name);
      }
    } catch (err) {
      if (err instanceof BlockedByRobotsError) {
        // Not allowed for crawlers (e.g. a few exchanger pages are excluded): remember and move on.
        store.touchPageFetched(SOURCE_ID, ex.ext_id);
        skipped++;
        continue;
      }
      failed++;
      log.warn("exchanger page failed", { url, err: err instanceof Error ? err.message : String(err) });
      // Mark as attempted so one broken page does not starve the queue; it is retried after the normal interval.
      store.touchPageFetched(SOURCE_ID, ex.ext_id);
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) break;
      if (err instanceof Error && err.name === "CircuitOpenError") break;
    }
  }
  // Pages are static (ISR): nudge the front so new reviews show up now, not at the next hourly refresh.
  const rv = changedOurNames.size ? await revalidateExchangerPages(config, [...changedOurNames], ctx.fetch) : { requested: 0, ok: true };
  return { candidates: batch.length, fetched, failed, skipped, ...total, revalidated: rv.requested, revalidateOk: rv.ok };
};
