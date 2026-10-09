import type { JobCtx } from "./types";
import { computeRating, monthsSince, parseAgeMonths, type CheckVerdict, type RatingSource } from "./rating";
import { sourceLabel } from "../sources/meta";
import { revalidateExchangerPages } from "./revalidate";

const VERDICTS = new Set(["green", "yellow", "red", "block"]);

/**
 * Recomputes stars + trust level of every exchanger we list and writes the changed ones to Strapi
 * (`admin_rating`, `trust_level`, `trust_score`, `reviews_count`, `rating_details`).
 * Inputs: review counters and ages from the linked monitorings (this service), our users' reviews,
 * the exchanger card age, the p2pie status and our own check verdict (all from Strapi).
 * `rating_locked` exchangers are left exactly as a human typed them.
 */
export const runRatingSync = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, config, strapi, log } = ctx;
  if (!strapi || !config.RATING_SYNC_ENABLED) return { skipped: true, reason: strapi ? "disabled" : "no Strapi credentials" };

  const [exchangers, native] = [await strapi.listExchangersForRating(), await strapi.nativeReviewCounts()];
  const stats = { exchangers: exchangers.length, updated: 0, unchanged: 0, locked: 0, errors: 0, revalidated: 0 };
  const touched: string[] = [];
  const changed: string[] = []; // sample for the job log
  let budget = config.RATING_SYNC_BATCH;
  let consecutiveErrors = 0;

  for (const ex of exchangers) {
    if (ex.rating_locked) {
      stats.locked++;
      continue;
    }
    const sources: RatingSource[] = [];
    for (const link of store.linksForOur(ex.id)) {
      const e = store.getExchanger(link.source, link.ext_id);
      if (!e || e.status === "gone") continue;
      // A source without its own counters (Obmify): judge by the reviews we collected from it.
      const own = e.reviews_pos == null && e.reviews_neg == null ? store.sentimentCounts(link.source, link.ext_id) : null;
      const collected = own && own.positive + own.negative > 0 ? own : null;
      sources.push({
        source: link.source,
        name: sourceLabel(link.source),
        positive: collected ? collected.positive : e.reviews_pos,
        negative: collected ? collected.negative : e.reviews_neg,
        total: e.reviews_total,
        claimsOpen: e.claims_open,
        ageMonths: parseAgeMonths(e.age_text),
      });
    }
    const r = computeRating({
      sources,
      native: native.get(ex.id) ?? { positive: 0, negative: 0, neutral: 0 },
      cardAgeMonths: monthsSince(ex.date_created),
      status: ex.status,
      check: { verdict: ex.check_verdict && VERDICTS.has(ex.check_verdict) ? (ex.check_verdict as CheckVerdict) : null, score: ex.check_score },
    });

    // No reviews at all: no stars (0 hides them on the site) rather than an invented number.
    const stars = r.stars ?? 0;
    const same =
      Math.abs((ex.admin_rating ?? 0) - stars) < 0.005 &&
      ex.trust_level === r.level &&
      ex.trust_score === r.score &&
      ex.reviews_count === r.reviewsCount &&
      JSON.stringify(ex.rating_details) === JSON.stringify(r.details);
    if (same) {
      stats.unchanged++;
      continue;
    }
    if (budget <= 0 || consecutiveErrors >= 3) continue;
    budget--;
    try {
      await strapi.updateExchanger(ex.id, {
        admin_rating: stars,
        trust_level: r.level,
        trust_score: r.score,
        reviews_count: r.reviewsCount,
        rating_details: r.details,
        rating_updated_at: new Date().toISOString(),
      });
      consecutiveErrors = 0;
      stats.updated++;
      if (changed.length < 10) changed.push(ex.name);
      // Only a visible change is worth regenerating the page for.
      if (ex.trust_level !== r.level || Math.abs((ex.admin_rating ?? 0) - stars) >= 0.05) touched.push(ex.name);
    } catch (err) {
      stats.errors++;
      consecutiveErrors++;
      log.warn("rating sync: update failed", { id: ex.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  for (let i = 0; i < touched.length; i += 50) {
    stats.revalidated += (await revalidateExchangerPages(config, touched.slice(i, i + 50), ctx.fetch)).requested;
  }
  return { ...stats, changed: changed.join(",") };
};
