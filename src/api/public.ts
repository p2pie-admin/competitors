import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import type { Store, ExternalReview, SourceExchanger } from "../db/store";
import { ratingToType } from "../core/moderation";

export const NOTICE =
  "Отзывы скопированы с указанного источника без изменений смысла и показаны со ссылкой на оригинал. " +
  "Они не являются отзывами пользователей p2pie и не учитываются в нашем рейтинге.";

const SOURCE_LABELS: Record<string, string> = { bestchange: "BestChange" };

const q = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
  type: z.enum(["positive", "neutral", "negative"]).optional(),
});

export const publicReview = (r: ExternalReview) => ({
  id: r.id,
  source: r.source,
  author: r.author,
  country: r.country,
  rating: r.rating,
  type: ratingToType(r.rating),
  text: r.text,
  postedAt: r.posted_at,
  url: r.source_url,
  reply: r.reply_text ? { author: r.reply_author, text: r.reply_text, at: r.reply_at } : null,
});

export const publicStats = (e: SourceExchanger) => ({
  positive: e.reviews_pos,
  negative: e.reviews_neg,
  reviewsTotal: e.reviews_total,
  claimsOpen: e.claims_open,
  claimsClosed: e.claims_closed,
  directions: e.directions,
  reserveUsd: e.reserve_usd,
  age: e.age_text,
  onSource: e.on_source_text,
  fetchedAt: e.page_fetched_at ?? e.last_seen,
});

export const registerPublicRoutes = (app: FastifyInstance, store: Store, config: Config): void => {
  app.get("/health", async () => ({ ok: true }));

  // Everything we hold about our exchanger from competing monitorings.
  app.get<{ Params: { ourId: string } }>("/v1/exchangers/:ourId/external", async (req, reply) => {
    const parsed = q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "bad query", details: parsed.error.flatten() });
    const { offset, type } = parsed.data;
    const limit = Math.min(parsed.data.limit ?? config.MAX_PUBLIC_REVIEWS, config.MAX_PUBLIC_REVIEWS);
    const minPostedAt = Math.floor(Date.now() / 1000) - config.MAX_REVIEW_AGE_DAYS * 86400;

    const sources = store
      .linksForOur(req.params.ourId)
      .map((link) => {
        const ex = store.getExchanger(link.source, link.ext_id);
        if (!ex || ex.status === "gone") return null;
        const available = store.countPublishedForExchanger(link.source, link.ext_id, minPostedAt);
        const reviews = config.PUBLISH_REVIEW_TEXTS
          ? store.publishedForExchanger(link.source, link.ext_id, { limit, offset, minPostedAt, rating: type }).map(publicReview)
          : [];
        return {
          source: link.source,
          name: SOURCE_LABELS[link.source] ?? link.source,
          exchangerName: ex.name,
          url: ex.url,
          matchConfidence: link.confidence,
          stats: publicStats(ex),
          reviewsAvailable: available,
          reviews,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    reply.header("cache-control", "public, max-age=120");
    return { ourExchangerId: req.params.ourId, textsEnabled: config.PUBLISH_REVIEW_TEXTS, notice: NOTICE, sources };
  });

  // Counts only, for many exchangers at once (listing pages). ?ids=1,2,3
  app.get<{ Querystring: { ids?: string } }>("/v1/summary", async (req, reply) => {
    const ids = (req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .slice(0, 300);
    const out: Record<string, Array<{ source: string; name: string; positive: number | null; negative: number | null; url: string | null }>> = {};
    for (const id of ids) {
      for (const link of store.linksForOur(id)) {
        const ex = store.getExchanger(link.source, link.ext_id);
        if (!ex || ex.status === "gone") continue;
        (out[id] ??= []).push({ source: link.source, name: SOURCE_LABELS[link.source] ?? link.source, positive: ex.reviews_pos, negative: ex.reviews_neg, url: ex.url });
      }
    }
    reply.header("cache-control", "public, max-age=300");
    return out;
  });
};
