import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { Store, type NewReview } from "../src/db/store";

const mk = () => {
  const store = new Store(openDb(":memory:"));
  store.ensureSource("bestchange", "BestChange", "https://www.bestchange.ru");
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "1006", name: "Сова", reserve_usd: 100, directions: 10, reviews_pos: 5, reviews_neg: 1 });
  return store;
};

const review = (o: Partial<NewReview> = {}): NewReview => ({
  source: "bestchange",
  ext_id: "1006",
  ext_review_id: "1",
  author: "A",
  country: "Россия",
  rating: 5,
  text: "Хороший обмен, всё быстро",
  text_hash: "h1",
  posted_at: 1_790_000_000,
  source_url: "https://www.bestchange.ru/sova-exchanger.html?review=1",
  reply_author: null,
  reply_text: null,
  reply_at: null,
  status: "published",
  reject_reason: null,
  ...o,
});

test("migrations create the schema and are idempotent", () => {
  const store = mk();
  assert.equal(store.db.pragma("user_version", { simple: true }), 1);
  assert.equal(store.listSources().length, 1);
});

test("exchangers: upsert, gone marking, slug", () => {
  const store = mk();
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "2", name: "B", reserve_usd: 1, directions: 1, reviews_pos: 0, reviews_neg: 0 });
  assert.equal(store.markGoneExcept("bestchange", new Set(["1006"])), 1);
  assert.equal(store.getExchanger("bestchange", "2")!.status, "gone");
  // reappearing exchangers become active again
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "2", name: "B", reserve_usd: 1, directions: 1, reviews_pos: 0, reviews_neg: 0 });
  assert.equal(store.getExchanger("bestchange", "2")!.status, "active");
  store.setSlug("bestchange", "1006", "sova", "https://www.bestchange.ru/sova-exchanger.html");
  assert.equal(store.getExchanger("bestchange", "1006")!.slug, "sova");
  store.clearSlug("bestchange", "1006");
  assert.equal(store.getExchanger("bestchange", "1006")!.slug, null);
});

test("reviews: insert, unchanged, updated, hidden is sticky", () => {
  const store = mk();
  assert.equal(store.upsertReview(review()), "inserted");
  assert.equal(store.upsertReview(review()), "unchanged");
  assert.equal(store.upsertReview(review({ text: "Изменённый текст", text_hash: "h2" })), "updated");
  const id = store.listReviews({ limit: 10, offset: 0 })[0]!.id;
  assert.equal(store.setReviewStatus(id, "hidden", "admin"), true);
  // the next crawl says "published" again: the human decision wins
  store.upsertReview(review({ text: "Изменённый текст", text_hash: "h2", status: "published" }));
  assert.equal(store.getReview(id)!.status, "hidden");
});

test("takedown deletes now and blocks re-import (one review and a whole exchanger)", () => {
  const store = mk();
  store.upsertReview(review());
  store.upsertReview(review({ ext_review_id: "2", text_hash: "h2" }));
  store.addTakedown({ source: "bestchange", ext_review_id: "1", reason: "author request" });
  assert.equal(store.listReviews({ limit: 10, offset: 0 }).length, 1);
  assert.equal(store.upsertReview(review()), "takedown");
  store.addTakedown({ source: "bestchange", ext_id: "1006", reason: "owner request" });
  assert.equal(store.listReviews({ limit: 10, offset: 0 }).length, 0);
  assert.equal(store.upsertReview(review({ ext_review_id: "3" })), "takedown");
});

test("links: only linked exchangers surface reviews; filters, age and status", () => {
  const store = mk();
  const now = Math.floor(Date.now() / 1000);
  store.upsertReview(review({ ext_review_id: "a", text_hash: "a", posted_at: now - 100, rating: 5 }));
  store.upsertReview(review({ ext_review_id: "b", text_hash: "b", posted_at: now - 200, rating: 1 }));
  store.upsertReview(review({ ext_review_id: "c", text_hash: "c", posted_at: now - 300, status: "rejected", reject_reason: "x" }));
  store.upsertReview(review({ ext_review_id: "d", text_hash: "d", posted_at: now - 999 * 86400 }));
  assert.equal(store.publishedForOur("859", { limit: 10, offset: 0, minPostedAt: 0 }).length, 0, "no link yet");
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "domain", confidence: 0.98 });
  const recent = now - 365 * 86400;
  const list = store.publishedForOur("859", { limit: 10, offset: 0, minPostedAt: recent });
  assert.deepEqual(list.map((r) => r.ext_review_id), ["a", "b"], "newest first, rejected and stale excluded");
  assert.equal(store.publishedForOur("859", { limit: 10, offset: 0, minPostedAt: recent, rating: "negative" }).length, 1);
  assert.equal(store.countPublishedForOur("859", recent), 2);
  assert.equal(store.publishedForExchanger("bestchange", "1006", { limit: 1, offset: 1, minPostedAt: recent })[0]!.ext_review_id, "b");
});

test("links: deleting an exchanger link cascades; duplicate text counter", () => {
  const store = mk();
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "manual", confidence: 1, locked: true });
  assert.equal(store.getLink("bestchange", "1006")!.locked, 1);
  store.upsertReview(review({ ext_review_id: "a", text_hash: "same" }));
  store.upsertReview(review({ ext_review_id: "b", text_hash: "same" }));
  assert.equal(store.countSameText("bestchange", "1006", "same", "c"), 2);
  assert.equal(store.countSameText("bestchange", "1006", "same", "a"), 1);
});

test("crawl candidates: linked only, never-fetched first, honours age", () => {
  const store = mk();
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "2", name: "B", reserve_usd: 1, directions: 1, reviews_pos: 0, reviews_neg: 0 });
  store.setSlug("bestchange", "1006", "sova", "u");
  store.setSlug("bestchange", "2", "b", "u");
  assert.equal(store.crawlCandidates("bestchange", 3600, false, 10).length, 0, "nothing linked");
  assert.equal(store.crawlCandidates("bestchange", 3600, true, 10).length, 2, "all mode");
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "name", confidence: 0.8 });
  assert.deepEqual(store.crawlCandidates("bestchange", 3600, false, 10).map((e) => e.ext_id), ["1006"]);
  store.touchPageFetched("bestchange", "1006");
  assert.equal(store.crawlCandidates("bestchange", 3600, false, 10).length, 0, "fresh");
});

test("job runs and stale-run cleanup", () => {
  const store = mk();
  const a = store.startRun("x");
  store.finishRun(a, true, { n: 1 });
  store.startRun("y");
  assert.equal(store.closeStaleRuns(), 1);
  assert.equal(store.lastRunOf("y")!.ok, 0);
  assert.ok(store.lastSuccessOf("x"));
});
