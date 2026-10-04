import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import type { Store } from "../db/store";
import type { Scheduler } from "../core/scheduler";
import type { OurExchangers } from "../core/ourExchangers";
import { adminGuard } from "./auth";
import { revalidateExchangerPages } from "../core/revalidate";

const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

export const registerAdminRoutes = (app: FastifyInstance, deps: { store: Store; config: Config; scheduler: Scheduler | null; ours: OurExchangers }): void => {
  const { store, config, scheduler, ours } = deps;
  app.register(async (admin) => {
    admin.addHook("preHandler", adminGuard(config.COMPETITORS_ADMIN_TOKEN));

    // Overall state: jobs, last runs, counters, circuit breakers.
    admin.get("/status", async () => {
      const now = Math.floor(Date.now() / 1000);
      const counts = store.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM source_exchangers WHERE status = 'active') AS exchangers,
             (SELECT COUNT(*) FROM exchanger_links) AS links,
             (SELECT COUNT(*) FROM external_reviews) AS reviews,
             (SELECT COUNT(*) FROM takedowns) AS takedowns`
        )
        .get();
      const circuits = store.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'circuit:%'").all() as Array<{ key: string; value: string }>;
      return {
        now,
        textsEnabled: config.PUBLISH_REVIEW_TEXTS,
        counts,
        reviewsByStatus: store.reviewStats(),
        jobs: scheduler ? scheduler.jobs() : [],
        lastRuns: store.lastRuns(20).map((r) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null })),
        circuits: circuits.map((c) => ({ host: c.key.slice(8), until: Number(c.value) })).filter((c) => c.until > now),
        bestchangeApiUpdatedAt: Number(store.kvGet("bestchange:api:updated")) || null,
      };
    });

    admin.get<{ Querystring: Record<string, string> }>("/exchangers", async (req) => {
      const { limit, offset } = page.parse(req.query);
      const source = req.query.source || "bestchange";
      const needle = (req.query.q || "").toLowerCase();
      const linkedOnly = req.query.linked === "1";
      let list = store.listExchangers(source, { status: "active" });
      if (needle) list = list.filter((e) => e.name.toLowerCase().includes(needle) || (e.domain || "").includes(needle) || (e.slug || "").includes(needle));
      const links = new Map(store.listLinks(source).map((l) => [l.ext_id, l]));
      if (linkedOnly) list = list.filter((e) => links.has(e.ext_id));
      return { total: list.length, items: list.slice(offset, offset + limit).map((e) => ({ ...e, link: links.get(e.ext_id) ?? null })) };
    });

    // Our exchangers that have no source link yet, plus the conflicts the matcher refused to guess.
    admin.get("/unmatched", async () => {
      const linked = new Set(store.listLinks().map((l) => l.our_exchanger_id));
      const list = (await ours.list()).filter((e) => e.status === "active" && !linked.has(e.id));
      const conflicts = JSON.parse(store.kvGet("bestchange:match:conflicts") || "[]") as Array<{ ext_id: string; reason: string; candidates: string[] }>;
      const names = new Map(store.listExchangers("bestchange").map((e) => [e.ext_id, e]));
      return {
        ourWithoutLink: list.map((e) => ({ id: e.id, name: e.name, display_name: e.display_name, ref_link: e.ref_link })),
        conflicts: conflicts.map((c) => ({ ...c, name: names.get(c.ext_id)?.name ?? null, domain: names.get(c.ext_id)?.domain ?? null })),
      };
    });

    admin.get("/links", async (req) => ({ items: store.listLinks((req.query as { source?: string }).source) }));

    // Manual link (locked: automatic matching never touches it).
    admin.put<{ Body: { source?: string; ext_id?: string; our_exchanger_id?: string } }>("/links", async (req, reply) => {
      const b = z.object({ source: z.string().min(1), ext_id: z.string().min(1), our_exchanger_id: z.string().min(1) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: "source, ext_id, our_exchanger_id required" });
      if (!store.getExchanger(b.data.source, b.data.ext_id)) return reply.code(404).send({ error: "unknown source exchanger" });
      const our = await ours.byId(b.data.our_exchanger_id);
      if (!our) return reply.code(404).send({ error: "unknown our exchanger" });
      store.upsertLink({ source: b.data.source, ext_id: b.data.ext_id, our_exchanger_id: our.id, our_name: our.name, method: "manual", confidence: 1, locked: true });
      return { ok: true };
    });

    admin.delete<{ Params: { source: string; extId: string } }>("/links/:source/:extId", async (req) => {
      store.deleteLink(req.params.source, req.params.extId);
      return { ok: true };
    });

    admin.get<{ Querystring: Record<string, string> }>("/reviews", async (req) => {
      const { limit, offset } = page.parse(req.query);
      const status = z.enum(["published", "pending", "hidden", "rejected"]).optional().parse(req.query.status);
      return { items: store.listReviews({ source: req.query.source, extId: req.query.ext_id, status, limit, offset }) };
    });

    admin.post<{ Params: { id: string }; Body: { reason?: string } }>("/reviews/:id/hide", async (req, reply) => {
      const ok = store.setReviewStatus(Number(req.params.id), "hidden", req.body?.reason ?? "hidden by admin");
      return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    admin.post<{ Params: { id: string } }>("/reviews/:id/publish", async (req, reply) => {
      const r = store.getReview(Number(req.params.id));
      if (!r) return reply.code(404).send({ error: "not found" });
      // A human override: published even if the automatic filter said no (still subject to takedowns).
      store.setReviewStatus(r.id, "published", "approved by admin");
      return { ok: true };
    });

    // Permanent removal: a single review (source id) or all reviews of a source exchanger.
    admin.post<{ Body: { source?: string; ext_review_id?: string; ext_id?: string; reason?: string } }>("/takedowns", async (req, reply) => {
      const b = z
        .object({ source: z.string().min(1), ext_review_id: z.string().optional(), ext_id: z.string().optional(), reason: z.string().max(500).optional() })
        .refine((v) => v.ext_review_id || v.ext_id, "ext_review_id or ext_id required")
        .safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: "ext_review_id or ext_id required" });
      return { ok: true, id: store.addTakedown(b.data) };
    });
    admin.get("/takedowns", async () => ({ items: store.listTakedowns() }));

    admin.post<{ Params: { name: string } }>("/jobs/:name/run", async (req, reply) => {
      if (!scheduler) return reply.code(503).send({ error: "jobs disabled" });
      try {
        return { ok: true, stats: await scheduler.runNow(req.params.name) };
      } catch (err) {
        return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Ask the front to regenerate the pages of every linked exchanger (e.g. right after a front deploy).
    admin.post("/revalidate-all", async (_req, reply) => {
      if (!config.FRONT_URL || !config.REVALIDATE_SECRET) return reply.code(503).send({ error: "FRONT_URL / REVALIDATE_SECRET not configured" });
      const names = [...new Set(store.listLinks().map((l) => l.our_name).filter((n): n is string => !!n))];
      const out = { requested: 0, ok: true, batches: 0 };
      for (let i = 0; i < names.length; i += 50) {
        const r = await revalidateExchangerPages(config, names.slice(i, i + 50));
        out.requested += r.requested;
        out.ok = out.ok && r.ok;
        out.batches++;
      }
      return out;
    });

    admin.get("/fetches", async () => ({ items: store.recentFetches(100) }));
    admin.get<{ Params: { source: string; extId: string }; Querystring: { days?: string } }>("/history/:source/:extId", async (req) => ({
      items: store.dailyHistory(req.params.source, req.params.extId, Math.min(400, Number(req.query.days) || 60)),
    }));
  }, { prefix: "/admin" });
};
