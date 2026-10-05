import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { parseEmExchangerPage, parseEmList, parseEmDate } from "../src/sources/emon/pages";
import { parseWcExchangerPage, parseWcList, parseWcDate } from "../src/sources/wellcrypto/pages";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { PoliteClient } from "../src/http/client";
import { loadConfig } from "../src/config";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";
import * as em from "../src/sources/emon/jobs";
import * as wc from "../src/sources/wellcrypto/jobs";

const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("e-mon list: id, name, website domain, status, age, country, reserve, counters", () => {
  const rows = parseEmList(fx("emon-list.html"));
  assert.ok(rows.length >= 10);
  const x = rows.find((r) => r.extId === "132")!;
  assert.equal(x.name, "XeBit");
  assert.equal(x.domain, "xebit.me");
  assert.equal(x.active, false);
  assert.match(x.statusText, /Курсы не обновлены/);
  assert.equal(x.ageText, "9 лет 2 месяца");
  assert.equal(x.country, "Украина");
  assert.equal(x.reserveUsd, 54346);
  assert.equal(x.positive, 787);
  assert.equal(x.negative, 0);
  const o = rows.find((r) => r.extId === "1112")!;
  assert.equal(o.name, "Secrex");
  assert.equal(o.active, true);
  assert.equal(o.domain, "secrex.io");
});

test("e-mon page: reviews with tone, author, date; comments are not reviews; form noise stripped", () => {
  const url = "https://e-mon.cc/exchanger/269";
  const p = parseEmExchangerPage(fx("emon-exchanger-269.html"), url);
  assert.equal(p.positive, 35);
  assert.equal(p.negative, 0);
  assert.equal(p.reviews.length, 5);
  const r = p.reviews[0]!;
  assert.equal(r.extReviewId, "14296");
  assert.equal(r.author, "Алик888");
  assert.equal(r.sentiment, "positive");
  assert.equal(r.kind, "review");
  assert.equal(r.text, "отличный обенник мне очень нравиться!!!!");
  assert.equal(r.postedAt, Date.UTC(2020, 8, 24, 21, 16, 21) / 1000);
  assert.equal(r.permalink, url + "#review-14296");
  const c = p.reviews.find((x) => x.kind === "unknown")!;
  assert.ok(c, "type-comment present");
  assert.equal(c.sentiment, null);
  assert.ok(p.reviews.every((x) => !/Номер заявки/.test(x.text)));
});

test("e-mon date", () => {
  assert.equal(parseEmDate("2026-10-01 16:19:40"), Date.UTC(2026, 9, 1, 13, 19, 40) / 1000);
  assert.equal(parseEmDate("x"), null);
});

test("wellcrypto list: slug, name, status, age, country, reserve, feedback", () => {
  const rows = parseWcList(fx("wellcrypto-list.html"));
  assert.equal(rows.length, 12);
  const c = rows.find((r) => r.slug === "coincat")!;
  assert.equal(c.name, "CoinCat");
  assert.equal(c.available, true);
  assert.equal(c.statusText, "Работает");
  assert.match(c.ageText!, /7 лет и 2 месяца/);
  assert.equal(c.country, "Россия");
  assert.equal(c.feedback, 24);
  assert.ok(c.reserveUsd! > 0);
});

test("wellcrypto page: site domain, tone from the class, stable ids, template comments ignored", () => {
  const url = "https://wellcrypto.io/ru/exchangers/coincat/";
  const p = parseWcExchangerPage(fx("wellcrypto-exchanger-coincat.html"), url);
  assert.equal(p.domain, "coincat.in");
  assert.equal(p.reviews.length, 5);
  assert.ok(p.reviews.every((r) => r.sentiment === "positive" && r.kind === "review"));
  // The live page wraps a commented-out template (<!-- ...item-comment _not-confirmed... -->) around every review.
  const withComment = fx("wellcrypto-exchanger-coincat.html").replace('<div class="exch-comments__body">', '<div class="exch-comments__body"><!-- <div class="exch-comments__comment item-comment _not-confirmed"> -->');
  assert.equal(parseWcExchangerPage(withComment, url).reviews.length, 5);
  assert.ok(p.reviews.every((r) => /^\d+$/.test(r.extReviewId) && r.postedAt && r.author && r.text));
  assert.equal(new Set(p.reviews.map((r) => r.extReviewId)).size, 5);
  assert.deepEqual(parseWcExchangerPage(fx("wellcrypto-exchanger-coincat.html"), url).reviews.map((r) => r.extReviewId), p.reviews.map((r) => r.extReviewId), "ids are deterministic");
  assert.equal(JSON.stringify(p).match(/\d+\.\d+\.\d+\.\*/), null, "no IPs");
});

test("wellcrypto date", () => {
  assert.equal(parseWcDate("04 сентября 2026", "01:52"), Date.UTC(2026, 8, 3, 22, 52) / 1000);
  assert.equal(parseWcDate("21 апреля 2025", ""), Date.UTC(2025, 3, 20, 21, 0) / 1000);
  assert.equal(parseWcDate("вчера", "10:00"), null);
});

type Body = ConstructorParameters<typeof Response>[0];
const mk = (routes: Record<string, string>, ours: unknown) => {
  const config = loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  for (const s of ["emon", "wellcrypto"]) store.ensureSource(s, s, "x");
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
    for (const [suffix, body] of Object.entries(routes)) if (url.endsWith(suffix)) return new Response(body as Body, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const ctx: JobCtx = { store, config, log: logger("t"), fetch: fetchImpl, ours: new OurExchangers("http://s", (async () => new Response(JSON.stringify(ours))) as typeof fetch), client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl, sleep: async () => undefined }) };
  return { ctx, store };
};
const pad = (row: string, n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join("") + row;

test("e-mon jobs: list (website domain) -> match -> pages", async () => {
  // ObmenMonet (page fixture) is not in the public list; XeBit (132) stands in for it — the page parser does not care.
  const listRow = fx("emon-list.html").match(/<tr[^>]*>\s*<td class="clickable" data-url="\/exchanger\/132">.*?<\/tr>/s)![0];
  const list = `<html><body><table><tbody>${pad(listRow, 120, (i) => `<tr class=""><td class="clickable" data-url="/exchanger/${5000 + i}"><span class="exchanger-info"></span><span class="exchanger-name">Ex${i}</span></td><td><span class="exchanger-status exchanger-status-active">Активен</span></td><td>1 год</td><td>$1</td><td>1</td><td><a class="reviews-counter"><span class="reviews-counter-bad">-0</span><span class="reviews-counter-good">+1</span></a></td></tr>`)}</tbody></table></body></html>`;
  const { ctx, store } = mk({ "/exchangers": list, "/exchanger/132": fx("emon-exchanger-269.html") }, { "9": { id: "9", name: "XeBit", status: "active", ref_link: "https://xebit.me/?x" } });
  assert.equal((await em.runListJob(ctx)).rows, 121);
  assert.equal(store.getExchanger("emon", "132")!.domain, "xebit.me");
  assert.equal(store.getExchanger("emon", "132")!.page_fetched_at, null, "the list must not count as a page fetch");
  assert.equal((await em.runMatchJob(ctx)).linked, 1);
  const pages = await em.runPagesJob(ctx);
  assert.equal(pages.fetched, 1);
  assert.equal(pages.inserted, 4);
  assert.equal(pages.skippedClaims, 1, "the comment block is skipped");
  const rows = store.listReviews({ source: "emon", limit: 10, offset: 0 });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.sentiment === "positive"));
});

test("wellcrypto jobs: list -> match by name -> pages learns the domain", async () => {
  const listRow = fx("wellcrypto-list.html").match(/<tr class="table__exchange[^>]*data-href="\/ru\/exchangers\/coincat\/".*?<\/tr>/s)![0];
  const list = `<html><body><table><tbody>${pad(listRow, 60, (i) => `<tr class="table__exchange exchange status-available" data-href="/ru/exchangers/ex${i}/"><td class="exchange__name"><div class="exchange-details__name">Ex${i}</div></td><td class="exchange__status">Работает</td><td class="exchange__age">1 год</td><td class="exchange__reserve">$1</td><td class="exchange__quotes">1</td><td class="exchange__feedback"><a><span>+1</span></a></td></tr>`)}</tbody></table></body></html>`;
  const { ctx, store } = mk({ "/ru/exchangers/": list, "/ru/exchangers/coincat/": fx("wellcrypto-exchanger-coincat.html") }, { "5": { id: "5", name: "CoinCat", status: "active", ref_link: null } });
  assert.equal((await wc.runListJob(ctx)).rows, 61);
  assert.equal(store.getExchanger("wellcrypto", "coincat")!.reviews_pos, 24);
  assert.equal((await wc.runMatchJob(ctx)).linked, 1);
  const pages = await wc.runPagesJob(ctx);
  assert.equal(pages.fetched, 1);
  assert.equal(pages.inserted, 5);
  assert.equal(store.getExchanger("wellcrypto", "coincat")!.domain, "coincat.in");
  assert.equal((await wc.runPagesJob(ctx)).fetched, 0);
});
