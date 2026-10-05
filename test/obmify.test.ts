import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { parseObExchangerPage, parseObList } from "../src/sources/obmify/pages";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { PoliteClient } from "../src/http/client";
import { loadConfig } from "../src/config";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";
import { runListJob, runMatchJob, runPagesJob } from "../src/sources/obmify/jobs";

const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("obmify list: slug, name, reviews count, rating, directions, status", () => {
  const rows = parseObList(fx("obmify-list.html"));
  assert.equal(rows.length, 12);
  const p = rows.find((r) => r.slug === "payex24")!;
  assert.equal(p.name, "Payex24");
  assert.equal(p.reviewsCount, 2376);
  assert.equal(p.rating, 5);
  assert.equal(p.active, true);
  assert.match(p.statusText, /Актив/);
  assert.equal(p.label, "Gold Депозит");
  assert.ok(rows.every((r) => /^[a-z0-9-]+$/.test(r.slug) && r.name));
});

test("obmify page: JSON-LD reviews with stars -> tone, author, ISO date, site domain, stable ids", () => {
  const url = "https://obmify.com/ru/payex24-exchange";
  const p = parseObExchangerPage(fx("obmify-exchanger-payex24.html"), url);
  assert.equal(p.domain, "payex24.com");
  assert.equal(p.reviewCount, 2375);
  assert.ok(p.ratingValue! > 4.9);
  assert.equal(p.reviews.length, 6);
  const first = p.reviews[0]!;
  assert.equal(first.author, "Denys");
  assert.equal(first.rating, 5);
  assert.equal(first.sentiment, "positive");
  assert.equal(first.postedAt, Math.floor(Date.parse("2026-10-05T12:54:13.707Z") / 1000));
  assert.equal(first.permalink, url);
  assert.deepEqual(p.reviews.map((r) => r.sentiment), ["positive", "negative", "neutral", "positive", "negative", "positive"]);
  assert.equal(new Set(p.reviews.map((r) => r.extReviewId)).size, 6);
  assert.deepEqual(parseObExchangerPage(fx("obmify-exchanger-payex24.html"), url).reviews.map((r) => r.extReviewId), p.reviews.map((r) => r.extReviewId));
  assert.deepEqual(parseObExchangerPage("<html><head><title>x</title></head></html>", url).reviews, []);
});

type Body = ConstructorParameters<typeof Response>[0];
test("obmify jobs: list -> match by name -> pages (domain learned from JSON-LD)", async () => {
  const config = loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("obmify", "Obmify", "x");
  const row = fx("obmify-list.html").match(/<div class="Table__row"[^>]*>.*?(?=<div class="Table__row"|<\/div>\s*<\/body>)/s)![0];
  assert.ok(row.includes("payex24"), "first fixture row is Payex24");
  const filler = Array.from({ length: 60 }, (_, i) => `<div class="Table__row"><div class="Table__column Table__column--exchange"><a href="/ex${i}-exchange" class="Table__exchange-info"><div class="Table__exchange-info-name">Ex${i}</div></a></div><div class="Table__column Table__column--reviews-count">1 відгук</div><div class="Table__column Table__column--status"><div class="Status">Активний</div></div></div>`).join("");
  const list = `<html><body><div class="Table">${row}${filler}</div></body></html>`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /api/\n");
    if (url.endsWith("/exchanges")) return new Response(list as Body, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.endsWith("/ru/payex24-exchange")) return new Response(fx("obmify-exchanger-payex24.html") as unknown as Body, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const ctx: JobCtx = { store, config, log: logger("t"), fetch: fetchImpl, ours: new OurExchangers("http://s", (async () => new Response(JSON.stringify({ "3": { id: "3", name: "Payex24", status: "active", ref_link: null } }))) as typeof fetch), client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl, sleep: async () => undefined }) };
  assert.equal((await runListJob(ctx)).rows, 61);
  assert.equal(store.getExchanger("obmify", "payex24")!.reviews_total, 2376);
  assert.equal((await runMatchJob(ctx)).linked, 1);
  const pages = await runPagesJob(ctx);
  assert.equal(pages.fetched, 1);
  assert.equal(pages.inserted, 6);
  const rows = store.listReviews({ source: "obmify", limit: 10, offset: 0 });
  assert.equal(rows.filter((r) => r.sentiment === "negative").length, 2, "negative reviews are kept");
  assert.equal(store.getExchanger("obmify", "payex24")!.domain, "payex24.com");
  assert.equal((await runPagesJob(ctx)).fetched, 0);
});
