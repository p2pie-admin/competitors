import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { buildServer } from "../src/api/server";
import { OurExchangers } from "../src/core/ourExchangers";
import { loadConfig } from "../src/config";

const setup = (env: Record<string, string> = {}) => {
  const config = loadConfig({ COMPETITORS_ADMIN_TOKEN: "secret-token", LOG_LEVEL: "error", ...env } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("bestchange", "BestChange", "https://www.bestchange.ru");
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "1006", name: "Сова", reserve_usd: 124272375, directions: 2336, reviews_pos: 88673, reviews_neg: 0 });
  store.setSlug("bestchange", "1006", "sova", "https://www.bestchange.ru/sova-exchanger.html");
  store.updateFromPage("bestchange", "1006", { domain: "sova.gg", reviews_total: 89463, claims_closed: 650, claims_open: 0, age_text: "6 лет и 6 месяцев" });
  store.upsertLink({ source: "bestchange", ext_id: "1006", our_exchanger_id: "859", our_name: "Sova", method: "domain", confidence: 0.98 });
  const now = Math.floor(Date.now() / 1000);
  const mkReview = (n: string, o: Record<string, unknown> = {}) =>
    store.upsertReview({
      source: "bestchange", ext_id: "1006", ext_review_id: n, author: "Андрей", country: "Россия", rating: 5, text: `Отзыв номер ${n}, всё хорошо`, text_hash: "h" + n,
      posted_at: now - Number(n) * 60, source_url: `https://www.bestchange.ru/sova-exchanger.html?review=${n}`, reply_author: "Администратор Сова", reply_text: "Спасибо!", reply_at: now,
      status: "published", reject_reason: null, ...o,
    } as never);
  mkReview("1");
  mkReview("2", { rating: 1, reply_text: null, reply_author: null, reply_at: null });
  mkReview("3", { status: "rejected", reject_reason: "contains-link" });
  const ours = new OurExchangers("http://unused", (async () => new Response(JSON.stringify({ "859": { id: "859", name: "Sova" }, "7": { id: "7", name: "Other" } }))) as typeof fetch);
  const app = buildServer({ store, config, scheduler: null, ours });
  return { app, store, config };
};

test("public: reviews with source, stats and notice; rejected ones never leak", async () => {
  const { app } = setup();
  const res = await app.inject("/v1/exchangers/859/external");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.notice, /не являются отзывами пользователей p2pie/);
  assert.equal(body.sources.length, 1);
  const s = body.sources[0];
  assert.equal(s.source, "bestchange");
  assert.equal(s.name, "BestChange");
  assert.equal(s.url, "https://www.bestchange.ru/sova-exchanger.html");
  assert.equal(s.stats.positive, 88673);
  assert.equal(s.stats.claimsClosed, 650);
  assert.deepEqual(s.reviews.map((r: { text: string }) => r.text), ["Отзыв номер 1, всё хорошо", "Отзыв номер 2, всё хорошо"]);
  assert.equal(s.reviews[0].type, "positive");
  assert.equal(s.reviews[1].type, "negative");
  assert.equal(s.reviews[0].reply.author, "Администратор Сова");
  assert.equal(s.reviews[1].reply, null);
  assert.match(s.reviews[0].url, /\?review=1$/);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /contains-link|ip|fingerprint|text_hash/i);
  assert.match(res.headers["cache-control"] as string, /max-age/);
});

test("public: paging, type filter, unknown exchanger, bad query", async () => {
  const { app } = setup();
  assert.equal((await app.inject("/v1/exchangers/859/external?limit=1&offset=1")).json().sources[0].reviews[0].text, "Отзыв номер 2, всё хорошо");
  assert.equal((await app.inject("/v1/exchangers/859/external?type=negative")).json().sources[0].reviews.length, 1);
  assert.deepEqual((await app.inject("/v1/exchangers/404/external")).json().sources, []);
  assert.equal((await app.inject("/v1/exchangers/859/external?limit=abc")).statusCode, 400);
  assert.equal((await app.inject("/v1/exchangers/859/external?type=weird")).statusCode, 400);
});

test("public: texts switch keeps counts but hides texts", async () => {
  const { app } = setup({ PUBLISH_REVIEW_TEXTS: "false" });
  const body = (await app.inject("/v1/exchangers/859/external")).json();
  assert.equal(body.textsEnabled, false);
  assert.equal(body.sources[0].reviews.length, 0);
  assert.equal(body.sources[0].reviewsAvailable, 2);
  assert.equal(body.sources[0].stats.positive, 88673);
});

test("public: gone exchangers disappear; summary endpoint", async () => {
  const { app, store } = setup();
  const sum = (await app.inject("/v1/summary?ids=859,7,x")).json();
  assert.equal(sum["859"][0].positive, 88673);
  assert.equal(sum["7"], undefined);
  store.markGoneExcept("bestchange", new Set());
  assert.deepEqual((await app.inject("/v1/exchangers/859/external")).json().sources, []);
});

test("admin: needs the bearer token; disabled without a configured token", async () => {
  const { app } = setup();
  assert.equal((await app.inject("/admin/status")).statusCode, 401);
  assert.equal((await app.inject({ url: "/admin/status", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  const ok = await app.inject({ url: "/admin/status", headers: { authorization: "Bearer secret-token" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().counts.reviews, 3);
  const off = setup({ COMPETITORS_ADMIN_TOKEN: "" });
  assert.equal((await off.app.inject({ url: "/admin/status", headers: { authorization: "Bearer " } })).statusCode, 503);
});

const H = { authorization: "Bearer secret-token" };

test("admin: hide a review, takedown a review, manual link", async () => {
  const { app, store } = setup();
  const list = (await app.inject({ url: "/admin/reviews?status=published", headers: H })).json().items;
  assert.equal(list.length, 2);
  assert.equal((await app.inject({ method: "POST", url: `/admin/reviews/${list[0].id}/hide`, headers: H, payload: { reason: "spam" } })).statusCode, 200);
  assert.equal((await app.inject("/v1/exchangers/859/external")).json().sources[0].reviews.length, 1);

  const td = await app.inject({ method: "POST", url: "/admin/takedowns", headers: H, payload: { source: "bestchange", ext_review_id: "2", reason: "author request" } });
  assert.equal(td.statusCode, 200);
  assert.equal((await app.inject("/v1/exchangers/859/external")).json().sources[0].reviews.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/admin/takedowns", headers: H, payload: { source: "bestchange" } })).statusCode, 400);

  const link = await app.inject({ method: "PUT", url: "/admin/links", headers: H, payload: { source: "bestchange", ext_id: "1006", our_exchanger_id: "7" } });
  assert.equal(link.statusCode, 200);
  assert.equal(store.getLink("bestchange", "1006")!.our_exchanger_id, "7");
  assert.equal(store.getLink("bestchange", "1006")!.locked, 1);
  assert.equal((await app.inject({ method: "PUT", url: "/admin/links", headers: H, payload: { source: "bestchange", ext_id: "1006", our_exchanger_id: "nope" } })).statusCode, 404);
});

test("admin: exchanger search and job trigger without scheduler", async () => {
  const { app } = setup();
  const found = (await app.inject({ url: "/admin/exchangers?q=sova&linked=1", headers: H })).json();
  assert.equal(found.total, 1);
  assert.equal(found.items[0].link.our_exchanger_id, "859");
  assert.equal((await app.inject({ method: "POST", url: "/admin/jobs/bestchange.api/run", headers: H })).statusCode, 503);
});

test("admin: unmatched lists our active exchangers without a link and stored conflicts", async () => {
  const { app, store } = setup();
  store.kvSet("bestchange:match:conflicts", JSON.stringify([{ ext_id: "1006", reason: "x", candidates: ["859"] }]));
  const body = (await app.inject({ url: "/admin/unmatched", headers: H })).json();
  // setup() serves exchangers 859 (linked) and 7 (no status => not "active" => not listed)
  assert.deepEqual(body.ourWithoutLink, []);
  assert.equal(body.conflicts[0].name, "Сова");
});

test("admin: revalidate-all needs front configuration", async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: "POST", url: "/admin/revalidate-all", headers: H })).statusCode, 503);
});
