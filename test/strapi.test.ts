import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { Store, type NewReview } from "../src/db/store";
import { StrapiClient } from "../src/core/strapi";
import { runStrapiSync, toStrapiReview, contentHash } from "../src/core/strapiSync";
import { loadConfig } from "../src/config";
import { PoliteClient } from "../src/http/client";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";

type Rec = Record<string, unknown>;

// An in-memory imitation of the parts of Strapi 4 (+ transformer plugin) that the client uses.
const fakeStrapi = (opts: { flatten?: boolean; failAfter?: number } = {}) => {
  const reviews = new Map<string, Rec>();
  const replies = new Map<string, Rec>();
  let seq = 100;
  let calls = 0;
  const log: string[] = [];
  const wrap = (o: Rec) => (opts.flatten === false ? { data: { id: o.id, attributes: o } } : o);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    log.push(`${method} ${url.pathname}`);
    calls++;
    if (opts.failAfter != null && calls > opts.failAfter) return new Response("boom", { status: 500 });
    if (url.pathname === "/api/auth/local") {
      return body.identifier === "parser" && body.password === "pw" ? json({ jwt: "token-1" }) : json({ error: "bad" }, 400);
    }
    if (auth !== "Bearer token-1") return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/api/reviews" && method === "POST") {
      const d = body.data as Rec;
      if ([...reviews.values()].some((r) => r.fingerprint === d.fingerprint)) return json({ error: { message: "This attribute must be unique" } }, 400);
      const id = String(++seq);
      reviews.set(id, { id, ...d });
      return json(wrap({ id, ...d }));
    }
    if (url.pathname === "/api/reviews" && method === "GET") {
      const fp = url.searchParams.get("filters[fingerprint][$eq]");
      const hit = [...reviews.values()].filter((r) => r.fingerprint === fp);
      return json(opts.flatten === false ? { data: hit.map((h) => ({ id: h.id, attributes: h })) } : hit);
    }
    const m = /^\/api\/(reviews|review-replies)\/(\d+)$/.exec(url.pathname);
    if (m) {
      const store = m[1] === "reviews" ? reviews : replies;
      const rec = store.get(m[2]!);
      if (!rec) return json({ error: "not found" }, 404);
      if (method === "PUT") store.set(m[2]!, { ...rec, ...(body.data as Rec) });
      if (method === "DELETE") {
        store.delete(m[2]!);
        // like real Strapi: deleting a review does NOT delete its replies
      }
      return json(wrap({ id: m[2], ...(store.get(m[2]!) ?? {}) }));
    }
    if (url.pathname === "/api/review-replies" && method === "POST") {
      const id = String(++seq);
      replies.set(id, { id, ...(body.data as Rec) });
      return json(wrap({ id, ...(body.data as Rec) }));
    }
    return json({ error: "no route" }, 404);
  }) as typeof fetch;
  return { fetchImpl, reviews, replies, log };
};

const NOW = Math.floor(Date.now() / 1000);
const review = (n: string, o: Partial<NewReview> = {}): NewReview => ({
  source: "bestchange", ext_id: "1006", ext_review_id: n, author: "Андрей", country: "Россия", rating: 5, sentiment: "positive",
  text: `Отзыв ${n}: всё прошло быстро и без проблем`, text_hash: "h" + n, posted_at: NOW - Number(n) * 3600,
  source_url: `https://www.bestchange.ru/sova-exchanger.html?review=${n}`, reply_author: null, reply_text: null, reply_at: null,
  status: "published", reject_reason: null, ...o,
});

const setup = (env: Record<string, string> = {}, fake = fakeStrapi()) => {
  const config = loadConfig({ LOG_LEVEL: "error", ...env } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("bestchange", "BestChange", "x");
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "1006", name: "Сова", reserve_usd: 1, directions: 1, reviews_pos: 1, reviews_neg: 0 });
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "domain", confidence: 1 });
  const strapi = new StrapiClient({ baseUrl: "http://strapi:1337", identifier: "parser", password: "pw" }, fake.fetchImpl);
  const ctx: JobCtx = {
    store, config, strapi, log: logger("t"),
    client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl: fake.fetchImpl }),
    ours: new OurExchangers("http://x", fake.fetchImpl),
  };
  return { ctx, store, fake };
};

test("review mapping: native format plus provenance, deterministic fingerprint", () => {
  const { store } = setup();
  store.upsertReview(review("1", { reply_author: "Администратор Сова", reply_text: "Спасибо!", reply_at: NOW }));
  const r = store.listReviews({ limit: 1, offset: 0 })[0]!;
  const m = toStrapiReview(r, "859");
  assert.deepEqual({ ...m, external_date: "x" }, {
    exchanger: "859", text: r.text, type: "positive", name: "Андрей", location: "Россия", fingerprint: "ext:bestchange:1", isApproved: true,
    source: "BestChange", external_link: "https://www.bestchange.ru/sova-exchanger.html?review=1", external_id: "bestchange:1", external_date: "x",
  });
  assert.equal(m.external_date, new Date(r.posted_at * 1000).toISOString());
  assert.notEqual(contentHash(r, "859"), contentHash(r, "860"), "moving to another exchanger changes the hash");
});

test("sync creates reviews (+ replies), logs in once, and is idempotent", async () => {
  const { ctx, store, fake } = setup();
  store.upsertReview(review("1", { reply_author: "Администратор Сова", reply_text: "Спасибо!", reply_at: NOW }));
  store.upsertReview(review("2", { rating: 1, sentiment: "negative" }));
  store.upsertReview(review("3", { rating: null, sentiment: null }));            // unrated: not synced
  store.upsertReview(review("4", { status: "rejected", reject_reason: "contains-link" })); // rejected: not synced
  store.upsertReview(review("5", { posted_at: NOW - 400 * 86400 }));              // too old
  const s = await runStrapiSync(ctx);
  assert.equal(s.created, 2);
  assert.equal(fake.reviews.size, 2);
  assert.equal(fake.replies.size, 1);
  const created = [...fake.reviews.values()];
  assert.ok(created.every((r) => r.exchanger === "859" && r.isApproved === true && r.source === "BestChange"));
  assert.equal(fake.log.filter((l) => l === "POST /api/auth/local").length, 1);
  const again = await runStrapiSync(ctx);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
  assert.equal(fake.reviews.size, 2);
});

test("sync works with the unflattened Strapi response shape too", async () => {
  const { ctx, store, fake } = setup({}, fakeStrapi({ flatten: false }));
  store.upsertReview(review("1"));
  assert.equal((await runStrapiSync(ctx)).created, 1);
  assert.equal(fake.reviews.size, 1);
});

test("sync updates changed content and replaces the reply", async () => {
  const { ctx, store, fake } = setup();
  store.upsertReview(review("1", { reply_author: "A", reply_text: "Первый ответ", reply_at: NOW }));
  await runStrapiSync(ctx);
  store.upsertReview(review("1", { text: "Отзыв 1 (исправлен автором)", text_hash: "h1b", reply_author: "A", reply_text: "Второй ответ", reply_at: NOW }));
  const s = await runStrapiSync(ctx);
  assert.equal(s.updated, 1);
  const rv = [...fake.reviews.values()][0]!;
  assert.equal(rv.text, "Отзыв 1 (исправлен автором)");
  assert.deepEqual([...fake.replies.values()].map((r) => r.text), ["Второй ответ"]);
});

test("sync removes what stops being eligible: hidden, unlinked, takedown, kill switch", async () => {
  const { ctx, store, fake } = setup();
  for (const n of ["1", "2", "3", "4"]) store.upsertReview(review(n));
  await runStrapiSync(ctx);
  assert.equal(fake.reviews.size, 4);
  const rows = store.listReviews({ limit: 10, offset: 0 });
  const by = (n: string) => rows.find((r) => r.ext_review_id === n)!;

  store.setReviewStatus(by("1").id, "hidden", "admin");                // human decision
  store.addTakedown({ source: "bestchange", ext_review_id: "2", reason: "author request" }); // tombstone
  const repliesBefore = fake.replies.size;
  const s1 = await runStrapiSync(ctx);
  assert.equal(s1.tombstones, 1);
  assert.equal(s1.removed, 1);
  assert.equal(fake.reviews.size, 2);

  store.deleteLink("bestchange", "1006");                              // link no longer holds
  assert.equal((await runStrapiSync(ctx)).removed, 2);
  assert.equal(fake.reviews.size, 0);

  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "manual", confidence: 1, locked: true });
  await runStrapiSync(ctx);
  assert.equal(fake.reviews.size, 2, "re-linking brings them back");
  const killed = setup({ PUBLISH_REVIEW_TEXTS: "false" }, fake);
  // same store is not shared; emulate by flipping the config on the existing ctx
  (ctx.config as { PUBLISH_REVIEW_TEXTS: boolean }).PUBLISH_REVIEW_TEXTS = false;
  void killed;
  const s2 = await runStrapiSync(ctx);
  assert.equal(s2.removed, 2);
  assert.equal(fake.reviews.size, 0, "kill switch empties Strapi");
});

test("a review deleted in Strapi by hand is not resurrected", async () => {
  const { ctx, store, fake } = setup();
  store.upsertReview(review("1"));
  await runStrapiSync(ctx);
  const [id] = [...fake.reviews.keys()];
  fake.reviews.delete(id!);
  store.upsertReview(review("1", { text: "Отзыв 1: правка текста источником", text_hash: "h1c" })); // forces an update attempt
  const s = await runStrapiSync(ctx);
  assert.equal(s.goneInStrapi, 1);
  assert.equal(store.listReviews({ limit: 1, offset: 0 })[0]!.status, "hidden");
  assert.equal((await runStrapiSync(ctx)).created, 0);
});

test("crash recovery: an existing copy with the same fingerprint is adopted, not duplicated", async () => {
  const { ctx, store, fake } = setup();
  store.upsertReview(review("1"));
  fake.reviews.set("7", { id: "7", fingerprint: "ext:bestchange:1", text: "old" });
  const s = await runStrapiSync(ctx);
  assert.equal(s.adopted, 1);
  assert.equal(fake.reviews.size, 1);
  assert.equal(store.listReviews({ limit: 1, offset: 0 })[0]!.strapi_id, "7");
});

test("sync stops after repeated Strapi failures and keeps the rest for the next run", async () => {
  const { ctx, store } = setup({}, fakeStrapi({ failAfter: 1 }));
  for (const n of ["1", "2", "3", "4", "5", "6"]) store.upsertReview(review(n));
  const s = await runStrapiSync(ctx);
  assert.ok((s.errors as number) <= 3, "gave up after three consecutive errors, got " + s.errors);
  assert.equal(s.created, 0);
});

test("sync is a no-op without Strapi credentials", async () => {
  const { ctx } = setup();
  const s = await runStrapiSync({ ...ctx, strapi: undefined });
  assert.equal(s.skipped, true);
});

test("client re-logs in once when the token is rejected", async () => {
  let logins = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/auth/local") return (logins++, new Response(JSON.stringify({ jwt: logins === 1 ? "old" : "new" })));
    const auth = (init?.headers as Record<string, string>).authorization;
    return auth === "Bearer new" ? new Response(JSON.stringify({ id: 5 })) : new Response("{}", { status: 401 });
  }) as typeof fetch;
  const c = new StrapiClient({ baseUrl: "http://s", identifier: "a", password: "b" }, fetchImpl);
  assert.equal(await c.createReply("1", "x"), "5");
  assert.equal(logins, 2);
});

test("takedown also deletes the reply copy (Strapi does not cascade)", async () => {
  const { ctx, store, fake } = setup();
  store.upsertReview(review("1", { reply_author: "A", reply_text: "Ответ", reply_at: NOW }));
  await runStrapiSync(ctx);
  assert.equal(fake.replies.size, 1);
  store.addTakedown({ source: "bestchange", ext_review_id: "1", reason: "owner request" });
  assert.equal(store.tombstones(10)[0]!.reply_id !== null, true);
  const s = await runStrapiSync(ctx);
  assert.equal(s.tombstones, 1);
  assert.equal(fake.reviews.size, 0);
  assert.equal(fake.replies.size, 0);
});

test("sync nudges the front to regenerate the pages of exchangers it changed", async () => {
  const hits: string[] = [];
  const base = fakeStrapi();
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/api/revalidate") ? (hits.push(String(init?.body)), new Response("{}")) : base.fetchImpl(input, init)) as typeof fetch;
  const { ctx, store } = setup({ FRONT_URL: "http://front:3000", REVALIDATE_SECRET: "s" }, { ...base, fetchImpl: wrapped });
  const withFetch = { ...ctx, fetch: wrapped };
  store.upsertReview(review("1"));
  const s = await runStrapiSync(withFetch);
  assert.equal(s.created, 1);
  assert.equal(s.revalidated, 1);
  assert.deepEqual(JSON.parse(hits[0]!).paths, ["/exchangers/sova"]);
  assert.equal((await runStrapiSync(withFetch)).revalidated, 0, "nothing changed, nothing to regenerate");
});

test("only the newest N reviews per exchanger and source are kept in Strapi; the rest are removed", async () => {
  const { ctx, store, fake } = setup({ MAX_PUBLIC_REVIEWS: "3" });
  for (const n of ["1", "2", "3", "4", "5"]) store.upsertReview(review(n)); // posted_at falls with n: 1 is the newest
  await runStrapiSync(ctx);
  assert.deepEqual([...fake.reviews.values()].map((r) => r.external_id).sort(), ["bestchange:1", "bestchange:2", "bestchange:3"]);
  // a newer review pushes the oldest of the three out
  store.upsertReview(review("0", { posted_at: NOW }));
  const s = await runStrapiSync(ctx);
  assert.equal(s.created, 1);
  assert.equal(s.removed, 1);
  assert.deepEqual([...fake.reviews.values()].map((r) => r.external_id).sort(), ["bestchange:0", "bestchange:1", "bestchange:2"]);
});
