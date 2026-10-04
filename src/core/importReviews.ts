import type { JobCtx } from "./types";
import type { NewReview, SourceExchanger } from "../db/store";
import { evaluateReview, sanitizeReviewText } from "./moderation";
import { sha1 } from "./normalize";

/** A review as scraped from any source, before moderation. */
export type ScrapedReview = {
  extReviewId: string;
  /** Ordinary review of the source's main feed, a formal claim register entry (never imported) or unknown. */
  kind: "review" | "claim" | "unknown";
  author: string | null;
  country: string | null;
  /** Stars 1..5 when the source has them. */
  rating: number | null;
  /** Tone: given by the source (KursExpert) or derived from the stars (BestChange). null = unrated. */
  sentiment: "positive" | "neutral" | "negative" | null;
  postedAt: number | null;
  permalink: string | null;
  text: string;
  /** The source's own moderators flagged the review. */
  flagTexts: string[];
  reply: { author: string; at: number | null; text: string } | null;
};

export type ReviewImportStats = { seen: number; inserted: number; updated: number; unchanged: number; rejected: number; pending: number; takedown: number; skippedClaims: number };

export const emptyImportStats = (): ReviewImportStats => ({ seen: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0, pending: 0, takedown: 0, skippedClaims: 0 });

export const addStats = (into: ReviewImportStats, s: ReviewImportStats): void => {
  for (const k of Object.keys(into) as Array<keyof ReviewImportStats>) into[k] += s[k];
};

/** Turn scraped reviews into stored rows (moderation included). Pure w.r.t. the network. */
export const importReviews = (
  ctx: Pick<JobCtx, "store" | "config">,
  source: string,
  exchanger: Pick<SourceExchanger, "ext_id">,
  reviews: ScrapedReview[],
  pageUrl: string
): ReviewImportStats => {
  const { store, config } = ctx;
  const stats = emptyImportStats();
  for (const r of reviews) {
    stats.seen++;
    if (r.kind !== "review") {
      // Formal claim registers name specific parties and are disputed by nature: only their COUNT is shown.
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
      duplicatesOfText: store.countSameText(source, exchanger.ext_id, hash, r.extReviewId),
    });
    const row: NewReview = {
      source,
      ext_id: exchanger.ext_id,
      ext_review_id: r.extReviewId,
      author: r.author ? r.author.slice(0, 60) : null,
      country: r.country,
      rating: r.rating,
      text,
      text_hash: hash,
      posted_at: r.postedAt,
      source_url: r.permalink ?? `${pageUrl}#${r.extReviewId}`,
      reply_author: r.reply ? r.reply.author.slice(0, 80) : null,
      reply_text: r.reply ? sanitizeReviewText(r.reply.text) : null,
      reply_at: r.reply?.at ?? null,
      status: verdict.status,
      reject_reason: verdict.reason,
      sentiment: r.sentiment,
    };
    const res = store.upsertReview(row);
    if (res === "takedown") {
      stats.takedown++;
      continue;
    }
    stats[res]++;
    if (verdict.status === "rejected") stats.rejected++;
    else if (verdict.status === "pending") stats.pending++;
  }
  return stats;
};
