import type { JobCtx } from "./types";
import type { ExternalReview } from "../db/store";
import { StrapiError, type StrapiReviewInput } from "./strapi";
import { sha1 } from "./normalize";
import { sourceLabel } from "../sources/meta";
import { revalidateExchangerPages } from "./revalidate";

const toIso = (sec: number) => new Date(sec * 1000).toISOString();

/** Review in the shape of our native Strapi review (+ the provenance fields). */
export const toStrapiReview = (r: ExternalReview, ourExchangerId: string): StrapiReviewInput => ({
  exchanger: ourExchangerId,
  text: r.text,
  type: r.sentiment as "positive" | "neutral" | "negative",
  name: r.author,
  location: r.country,
  // Unique key: lets a retry after a crash adopt the existing copy instead of creating a duplicate.
  fingerprint: `ext:${r.source}:${r.ext_review_id}`,
  isApproved: true,
  source: sourceLabel(r.source),
  external_link: r.source_url,
  external_id: `${r.source}:${r.ext_review_id}`,
  external_date: toIso(r.posted_at),
  review_date: toIso(r.posted_at),
});

/**
 * Everything that, when changed, must be pushed to Strapi again: "<review part>.<reply part>", so a changed review
 * does not recreate an unchanged reply (and vice versa).
 */
export const contentHash = (r: ExternalReview, ourExchangerId: string): string =>
  `${sha1(JSON.stringify(toStrapiReview(r, ourExchangerId)))}.${sha1(JSON.stringify([r.reply_text ?? null, r.reply_author ?? null]))}`;

/**
 * Keeps Strapi's `review` collection in line with our external_reviews table:
 *   1. takedown tombstones -> delete in Strapi
 *   2. no longer eligible (hidden/rejected/unlinked/stale, or the kill switch) -> delete in Strapi
 *   3. changed content -> update
 *   4. new eligible reviews -> create (+ the exchanger's reply as a review-reply)
 * Bounded by STRAPI_SYNC_BATCH operations per run; stops early after repeated Strapi failures.
 */
export const runStrapiSync = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, config, strapi, log } = ctx;
  if (!strapi || !config.STRAPI_SYNC_ENABLED) return { skipped: true, reason: strapi ? "disabled" : "no Strapi credentials" };

  const touched = new Set<string>(); // our exchanger names whose pages must be regenerated
  const stats = { revalidated: 0, tombstones: 0, removed: 0, updated: 0, created: 0, adopted: 0, errors: 0, goneInStrapi: 0 };
  let budget = config.STRAPI_SYNC_BATCH;
  let consecutiveErrors = 0;
  const minPostedAt = Math.floor(Date.now() / 1000) - config.MAX_REVIEW_AGE_DAYS * 86400;
  const killSwitch = !config.PUBLISH_REVIEW_TEXTS;
  const cap = config.MAX_PUBLIC_REVIEWS; // newest N per exchanger and source

  const guard = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      consecutiveErrors = 0;
      return true;
    } catch (err) {
      stats.errors++;
      consecutiveErrors++;
      log.warn(`strapi sync: ${what} failed`, { err: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      budget--;
    }
  };
  const tooManyErrors = () => consecutiveErrors >= 3;

  // 1. takedowns
  for (const t of store.tombstones(Math.max(budget, 1))) {
    if (budget <= 0 || tooManyErrors()) break;
    const done = await guard("tombstone", async () => {
      if (t.reply_id) await strapi.deleteReply(t.reply_id);
      await strapi.deleteReview(t.strapi_id);
      store.ackTombstone(t.strapi_id);
    });
    if (done) stats.tombstones++;
  }

  // 2. removals
  for (const r of store.syncToRemove(minPostedAt, cap, killSwitch, Math.max(budget, 1))) {
    if (budget <= 0 || tooManyErrors()) break;
    const ok = await guard("remove", async () => {
      if (r.strapi_reply_id) await strapi.deleteReply(r.strapi_reply_id);
      await strapi.deleteReview(r.strapi_id!);
      store.clearSynced(r.id);
      if (r.our_name) touched.add(r.our_name);
    });
    if (ok) stats.removed++;
  }

  // 3. updates
  if (!killSwitch) {
    for (const r of store.syncPublished(minPostedAt, cap)) {
      if (budget <= 0 || tooManyErrors()) break;
      const hash = contentHash(r, r.our_exchanger_id);
      if (hash === r.synced_hash) continue;
      const ok = await guard("update", async () => {
        try {
          await strapi.updateReview(r.strapi_id!, toStrapiReview(r, r.our_exchanger_id));
        } catch (err) {
          if (err instanceof StrapiError && err.status === 404) {
            // Someone deleted it in Strapi on purpose: respect that, do not resurrect it.
            store.setReviewStatus(r.id, "hidden", "deleted in Strapi");
            store.clearSynced(r.id);
            stats.goneInStrapi++;
            return;
          }
          throw err;
        }
        let replyId = r.strapi_reply_id;
        const [, oldReplyPart] = (r.synced_hash ?? "").split(".");
        if (oldReplyPart !== hash.split(".")[1]) {
          if (r.strapi_reply_id) await strapi.deleteReply(r.strapi_reply_id);
          replyId = r.reply_text ? await strapi.createReply(r.strapi_id!, r.reply_text) : null;
        }
        store.markSynced(r.id, r.strapi_id!, replyId, hash);
        if (r.our_name) touched.add(r.our_name);
      });
      if (ok) stats.updated++;
    }
  }

  // 4. creates
  if (!killSwitch) {
    for (const r of store.syncToCreate(minPostedAt, cap, Math.max(budget, 1))) {
      if (budget <= 0 || tooManyErrors()) break;
      const ok = await guard("create", async () => {
        const data = toStrapiReview(r, r.our_exchanger_id);
        const before = await strapi.findReviewByFingerprint(data.fingerprint);
        const id = before ?? (await strapi.createReview(data));
        if (before) stats.adopted++;
        const replyId = r.reply_text ? await strapi.createReply(id, r.reply_text) : null;
        store.markSynced(r.id, id, replyId, contentHash(r, r.our_exchanger_id));
        if (r.our_name) touched.add(r.our_name);
      });
      if (ok) stats.created++;
    }
  }
  // Pages are static (ISR): regenerate the exchangers whose reviews just changed.
  const names = [...touched];
  for (let i = 0; i < names.length; i += 50) {
    stats.revalidated += (await revalidateExchangerPages(config, names.slice(i, i + 50), ctx.fetch)).requested;
  }
  return stats;
};
