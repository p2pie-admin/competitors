import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRating, monthsSince, parseAgeMonths, type RatingInput, type RatingSource } from "../src/core/rating";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { StrapiClient } from "../src/core/strapi";
import { runRatingSync } from "../src/core/ratingSync";
import { loadConfig } from "../src/config";
import { PoliteClient } from "../src/http/client";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";

const src = (o: Partial<RatingSource> = {}): RatingSource => ({ source: "bestchange", name: "BestChange", positive: 0, negative: 0, total: 0, claimsOpen: 0, ageMonths: null, ...o });
const input = (o: Partial<RatingInput> = {}): RatingInput => ({
  sources: [], native: { positive: 0, negative: 0, neutral: 0 }, cardAgeMonths: null, status: "active", check: { verdict: null, score: null }, ...o,
});

test("age parsing: monitoring wording and card dates", () => {
  assert.equal(parseAgeMonths("3 года и 8 месяцев"), 44);
  assert.equal(parseAgeMonths("1 год 8 мес"), 20);
  assert.equal(parseAgeMonths("12 лет"), 144);
  assert.equal(parseAgeMonths("9 месяцев"), 9);
  assert.equal(parseAgeMonths("21 год и 2 месяца"), 254);
  assert.equal(parseAgeMonths(null), null);
  assert.equal(parseAgeMonths("недавно"), null);
  const now = new Date("2026-10-09T00:00:00Z");
  assert.equal(monthsSince("01.04.2017", now), 114);
  assert.equal(monthsSince("2026-04-09", now), 6);
  assert.equal(monthsSince("soon", now), null);
  assert.equal(monthsSince("01.01.2030", now), null);
});

test("stars: one perfect review does not beat hundreds with a complaint", () => {
  const one = computeRating(input({ sources: [src({ positive: 1 })] }));
  const many = computeRating(input({ sources: [src({ positive: 400, negative: 1 })] }));
  assert.ok(one.stars! < 4.5, `one review: ${one.stars}`);
  assert.ok(many.stars! > 4.8, `400 reviews: ${many.stars}`);
  assert.ok(many.score > one.score + 15);
  assert.equal(computeRating(input()).stars, null, "no reviews: no stars");
  const bad = computeRating(input({ sources: [src({ positive: 20, negative: 4 })] }));
  assert.ok(bad.stars! < 3.5, `many complaints: ${bad.stars}`);
});

test("trust: evidence decides the level, lack of data is 'unknown' and not 'caution'", () => {
  const fresh = computeRating(input({ sources: [src({ source: "emon", name: "E-mon", ageMonths: 2 })] }));
  assert.equal(fresh.level, "unknown");
  assert.deepEqual(fresh.details.flags, []);

  const old = computeRating(input({
    sources: [src({ positive: 50000, ageMonths: 78 }), src({ source: "emon", name: "E-mon", positive: 300, ageMonths: 78 }), src({ source: "changeinfo", name: "ChangeInfo", positive: 20 })],
  }));
  assert.equal(old.level, "reliable");
  assert.equal(old.score, 85);
  assert.equal(old.reviewsCount, 50320);

  const mid = computeRating(input({ sources: [src({ positive: 71, ageMonths: 21 }), src({ source: "kursexpert", name: "KursExpert", positive: 3 })], cardAgeMonths: 36 }));
  assert.equal(mid.level, "verified");
  assert.equal(mid.details.ageMonths, 36);
  const checked = computeRating(input({ sources: [src({ positive: 71, ageMonths: 36 }), src({ source: "kursexpert", name: "KursExpert", positive: 3 })], check: { verdict: "green", score: 83 } }));
  assert.equal(checked.level, "reliable", "our own check adds the missing points");
});

test("trust: hard negatives give 'caution' whatever the volume", () => {
  const big = [src({ positive: 50000, ageMonths: 120 }), src({ source: "emon", name: "E-mon", positive: 300 })];
  assert.equal(computeRating(input({ sources: big, check: { verdict: "red", score: 20 } })).level, "caution");
  const block = computeRating(input({ sources: big, check: { verdict: "block", score: 0 } }));
  assert.equal(block.level, "caution");
  assert.ok(block.score <= 20);
  assert.equal(computeRating(input({ sources: [src({ positive: 5000, claimsOpen: 3, ageMonths: 120 })] })).level, "caution");
  assert.deepEqual(computeRating(input({ sources: [src({ positive: 40, negative: 8 })] })).details.flags, ["negative_share"]);
  // One open claim only costs points.
  assert.equal(computeRating(input({ sources: big.map((s, i) => (i ? s : { ...s, claimsOpen: 1 })) })).level, "reliable");
});

test("sources without a sentiment split count for volume only; native reviews are included", () => {
  const r = computeRating(input({ sources: [src({ source: "obmify", name: "Obmify", positive: null, negative: null, total: 127 })], native: { positive: 2, negative: 0, neutral: 1 } }));
  assert.equal(r.reviewsCount, 130);
  assert.equal(r.details.reviews.positive, 2);
  assert.deepEqual(r.details.reviews.sources.map((s) => [s.source, s.positive, s.total]), [["obmify", null, 127], ["p2pie", 2, 3]]);
  assert.ok(r.stars! > 4.4 && r.stars! < 4.6);
});

// --- job ---
type Rec = Record<string, unknown>;
const fakeStrapi = (exchangers: Rec[], reviews: Rec[] = []) => {
  const puts: Array<{ id: string; data: Rec }> = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    if (url.pathname === "/api/auth/local") return json({ jwt: "t" });
    if (url.pathname === "/api/exchangers" && method === "GET") return json({ data: url.searchParams.get("pagination[page]") === "1" ? exchangers.map(({ id, ...attributes }) => ({ id, attributes })) : [] });
    if (url.pathname === "/api/reviews" && method === "GET") return json(url.searchParams.get("pagination[page]") === "1" ? reviews : []);
    const m = /^\/api\/exchangers\/(\d+)$/.exec(url.pathname);
    if (m && method === "PUT") {
      const data = (JSON.parse(String(init!.body)) as { data: Rec }).data;
      puts.push({ id: m[1]!, data });
      const ex = exchangers.find((e) => String(e.id) === m[1]);
      if (ex) Object.assign(ex, data);
      return json({ id: m[1] });
    }
    return json({ error: "no route" }, 404);
  }) as typeof fetch;
  return { fetchImpl, puts };
};

test("rating.sync writes changed exchangers once, skips locked ones and unchanged values", async () => {
  const fake = fakeStrapi(
    [
      { id: 859, name: "Sova", status: "active", admin_rating: 4.1, rating_locked: false, exchanger_card: { id: 1, date_created: "01.04.2017" } },
      { id: 860, name: "Manual", status: "active", admin_rating: 3.3, rating_locked: true },
      { id: 861, name: "Nobody", status: "suspended", admin_rating: 4.4, rating_locked: null, check_verdict: "red" },
    ],
    [{ id: 1, type: "positive", exchanger: { id: 859, name: "Sova" } }, { id: 2, type: "negative", exchanger: { data: { id: 859, attributes: { name: "Sova" } } } }]
  );
  const store = new Store(openDb(":memory:"));
  store.ensureSource("bestchange", "BestChange", "x");
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "1006", name: "Сова", reserve_usd: 1, directions: 1, reviews_pos: 900, reviews_neg: 0 });
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "domain", confidence: 1 });
  const ctx: JobCtx = {
    store, config: loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv), log: logger("t"),
    strapi: new StrapiClient({ baseUrl: "http://strapi:1337", identifier: "parser", password: "pw" }, fake.fetchImpl),
    client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl: fake.fetchImpl }),
    ours: new OurExchangers("http://x", fake.fetchImpl),
  };
  const s = await runRatingSync(ctx);
  assert.deepEqual({ updated: s.updated, locked: s.locked, errors: s.errors }, { updated: 2, locked: 1, errors: 0 });
  const sova = fake.puts.find((p) => p.id === "859")!.data;
  assert.equal(sova.trust_level, "reliable");
  assert.equal(sova.reviews_count, 902);
  assert.ok((sova.admin_rating as number) > 4.5);
  assert.equal((sova.rating_details as { ageMonths: number }).ageMonths! >= 114, true);
  const nobody = fake.puts.find((p) => p.id === "861")!.data;
  assert.equal(nobody.trust_level, "caution");
  assert.equal(nobody.admin_rating, 0, "no reviews: no stars");
  const again = await runRatingSync(ctx);
  assert.deepEqual({ updated: again.updated, unchanged: again.unchanged }, { updated: 0, unchanged: 2 });
});
