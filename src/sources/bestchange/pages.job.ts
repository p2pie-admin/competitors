import { parseExchangerPage, type ParsedReview } from "./pages";
import { SOURCE_ID } from "./constants";
import { BlockedByRobotsError, HttpError } from "../../http/errors";
import { evaluateReview, sanitizeReviewText } from "../../core/moderation";
import { sha1 } from "../../core/normalize";
import { revalidateExchangerPages } from "../../core/revalidate";
import type { JobCtx } from "../../core/types";
import type { NewReview, SourceExchanger } from "../../db/store";

export type ReviewImportStats = { seen: number; inserted: number; updated: number; unchanged: number; rejected: number; pending: number; takedown: number; skippedClaims: number };

export const emptyImportStats = (): ReviewImportStats => ({ seen: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0, pending: 0, takedown: 0, skippedClaims: 0 });

/** Turn parsed page reviews into stored rows (moderation included). Pure w.r.t. network. */
export const importReviews = (
  ctx: Pick<JobCtx, "store" | "config">,
  exchanger: SourceExchanger,
  reviews: ParsedReview[],
  pageUrl: string
): ReviewImportStats => {
  const { store, config } = ctx;
  const stats = emptyImportStats();
  for (const r of reviews) {
    stats.seen++;
    if (r.kind !== "review") {
      // Financial claims name specific parties and are disputed by nature: we show their COUNT only.
      stats.skippedClaims++;
      continue;
    }
    if (!r.postedAt) continue;
    const text = sanitizeReviewText(r.text);
    const hash = sha1(text.toLowerCase());
    const verdict = evaluateReview({
      text,
      rating: r.rating,
      flaggedBySource: r.flagTexts.length > 0,
      sourceFlagText: r.flagTexts.join("; "),
      minChars: config.MIN_REVIEW_CHARS,
      duplicatesOfText: store.countSameText(SOURCE_ID, exchanger.ext_id, hash, r.extReviewId),
    });
    const row: NewReview = {
      source: SOURCE_ID,
      ext_id: exchanger.ext_id,
      ext_review_id: r.extReviewId,
      author: r.author ? r.author.slice(0, 60) : null,
      country: r.country,
      rating: r.rating,
      text,
      text_hash: hash,
      posted_at: r.postedAt,
      source_url: r.permalink ?? `${pageUrl}?review=${r.extReviewId}`,
      reply_author: r.reply ? r.reply.author.slice(0, 80) : null,
      reply_text: r.reply ? sanitizeReviewText(r.reply.text) : null,
      reply_at: r.reply?.at ?? null,
      status: verdict.status,
      reject_reason: verdict.reason,
    };
    const res = store.upsertReview(row);
    if (res === "takedown") stats.takedown++;
    else stats[res]++;
    if (res !== "takedown") {
      if (verdict.status === "rejected") stats.rejected++;
      else if (verdict.status === "pending") stats.pending++;
    }
  }
  return stats;
};

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
      const s = importReviews(ctx, store.getExchanger(SOURCE_ID, ex.ext_id)!, page.reviews, url);
      for (const k of Object.keys(total) as Array<keyof ReviewImportStats>) total[k] += s[k];
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
