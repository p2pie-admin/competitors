import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { parseKeExchangerPage, parseKeList, parseKeDate, domainFromKeTitle } from "../src/sources/kursexpert/pages";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { PoliteClient } from "../src/http/client";
import { loadConfig } from "../src/config";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";
import { runListJob, runMatchJob, runPagesJob } from "../src/sources/kursexpert/jobs";

const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("list: id, slug, name, reserve, counters, reputation", () => {
  const rows = parseKeList(fx("kursexpert-list.html"));
  assert.equal(rows.length, 12);
  const c2c = rows.find((r) => r.slug === "cash2cash-me");
  assert.ok(c2c);
  assert.equal(c2c.extId, "1530");
  assert.equal(c2c.name, "Cash2Cash");
  assert.equal(c2c.active, true);
  assert.equal(c2c.reserveUsd, 5118413);
  assert.equal(c2c.positive, 91);
  assert.equal(c2c.negative, 0);
  assert.equal(c2c.reputation, 100);
  assert.match(c2c.ageText ?? "", /2 года 11 мес/);
  assert.ok(!/\d{6,}/.test(c2c.ageText ?? ""), "hidden sort key stripped from the age");
  for (const r of rows) {
    assert.match(r.extId, /^\d+$/);
    assert.match(r.slug, /^[a-z0-9-]+$/);
  }
});

test("date: Moscow time to unix seconds", () => {
  assert.equal(parseKeDate("29 сентября 2026, 01:08"), Date.UTC(2026, 8, 28, 22, 8) / 1000);
  assert.equal(parseKeDate("13 июня 2024, 14:28"), Date.UTC(2024, 5, 13, 11, 28) / 1000);
  assert.equal(parseKeDate("вчера"), null);
});

test("title domain", () => {
  assert.equal(domainFromKeTitle("swap-po.com отзывы, претензии, описание"), "swap-po.com");
  assert.equal(domainFromKeTitle("Cash2Cash отзывы"), null);
  assert.equal(domainFromKeTitle(null), null);
});

test("exchanger page: reviews with tone, author, country, date, permalink; no IPs", () => {
  const url = "https://kurs.expert/ru/obmennik/swap-po-com/feedbacks.html";
  const p = parseKeExchangerPage(fx("kursexpert-exchanger-swappo.html"), url);
  assert.equal(p.domain, "swap-po.com");
  assert.equal(p.reviews.length, 5);
  const r = p.reviews[0]!;
  assert.equal(r.extReviewId, "181404");
  assert.equal(r.author, "Артём");
  assert.equal(r.country, "Германия");
  assert.equal(r.sentiment, "positive");
  assert.equal(r.rating, null);
  assert.equal(r.kind, "review");
  assert.equal(r.text, "Шикарный обменный сервис. Клиентоориентированный. Рекомендую");
  assert.equal(r.postedAt, Date.UTC(2026, 8, 28, 22, 8) / 1000);
  assert.equal(r.permalink, url + "#181404");
  assert.equal(JSON.stringify(p).match(/\d+\.\d+\.\d+\.\*/), null);
});

test("exchanger page: negative reviews are kept (balance), user-to-user answers are not reviews", () => {
  const p = parseKeExchangerPage(fx("kursexpert-exchanger-changecoins.html"), "https://kurs.expert/ru/obmennik/changecoins-io/feedbacks.html");
  const tones = p.reviews.map((r) => r.sentiment);
  assert.deepEqual(tones, ["positive", "positive", "positive", "negative"], "the 'answer' comment is not imported");
  const neg = p.reviews.find((r) => r.sentiment === "negative")!;
  assert.equal(neg.extReviewId, "119281");
  assert.match(neg.text, /Никому не советую/);
  assert.ok(neg.text.includes("\n"), "<br> becomes a newline");
});

test("garbage page", () => {
  assert.deepEqual(parseKeExchangerPage("<html><body>x</body></html>", "u").reviews, []);
  assert.deepEqual(parseKeList("<html></html>"), []);
});

// ---- jobs end to end (no network) ----
const listHtml = (n: number) =>
  `<html><body><table><tbody>${Array.from({ length: n }, (_, i) => {
    const id = 2000 + i;
    const slug = i === 0 ? "swap-po-com" : `ex-${id}-com`;
    return `<tr class="eLine" link="/click/${id}/-3" elink="/ru/obmennik/${slug}/feedbacks.html#reputation" zone="green"><td class="eExch"><a class="mainlink">${i === 0 ? "Swappo" : "Ex" + id}</a></td><td class="eAge"><span class="n">1</span>3 года</td><td class="eSummaryReserve">$1 000</td><td class="eStatus">Активен</td><td class="eReviews"><span class="positiveFeedbacks">5</span>/<span class="neutralFeedbacks">1</span>/<span class="negativeFeedbacks">0</span></td><td class="eRep" rep="90"></td></tr>`;
  }).join("")}</tbody></table></body></html>`;

type ResponseBody = ConstructorParameters<typeof Response>[0];
const setup = (env: Record<string, string> = {}) => {
  const config = loadConfig({ LOG_LEVEL: "error", ...env } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("kursexpert", "KursExpert", config.KURSEXPERT_SITE);
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
    if (url.endsWith("/ru/obmennik.html")) return new Response(listHtml(120) as ResponseBody, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.endsWith("/swap-po-com/feedbacks.html")) return new Response(fx("kursexpert-exchanger-swappo.html") as unknown as ResponseBody, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const ours = new OurExchangers("http://s", (async () => new Response(JSON.stringify({ "77": { id: "77", name: "Swappo", status: "active", ref_link: "https://swap-po.com/?r=1" } }))) as typeof fetch);
  const ctx: JobCtx = { store, config, ours, log: logger("t"), fetch: fetchImpl, client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl, sleep: async () => undefined }) };
  return { ctx, store, seen };
};

test("kursexpert jobs: list -> match -> pages imports reviews of linked exchangers only", async () => {
  const { ctx, store, seen } = setup();
  const list = await runListJob(ctx);
  assert.equal(list.rows, 120);
  const ex = store.getExchanger("kursexpert", "2000")!;
  assert.equal(ex.name, "Swappo");
  assert.equal(ex.slug, "swap-po-com");
  assert.equal(ex.reviews_pos, 5);
  assert.equal(ex.reviews_total, 6);
  assert.equal(ex.url, "https://kurs.expert/ru/obmennik/swap-po-com/feedbacks.html");

  const match = await runMatchJob(ctx);
  assert.equal(match.linked, 1);
  assert.equal(store.getLink("kursexpert", "2000")!.our_exchanger_id, "77");

  const pages = await runPagesJob(ctx);
  assert.equal(pages.fetched, 1);
  assert.equal(pages.inserted, 5);
  const reviews = store.listReviews({ source: "kursexpert", limit: 20, offset: 0 });
  assert.equal(reviews.length, 5);
  assert.ok(reviews.every((r) => r.sentiment === "positive" && r.status === "published" && r.source_url.includes("#")));
  assert.equal(store.getExchanger("kursexpert", "2000")!.domain, "swap-po.com");
  assert.equal(seen.filter((u) => u.includes("/feedbacks.html")).length, 1, "only the linked exchanger was crawled");

  assert.equal((await runPagesJob(ctx)).fetched, 0, "fresh pages are not re-read");
});

test("kursexpert list refuses a page with almost no rows", async () => {
  const { ctx } = setup();
  const bad = { ...ctx, client: new PoliteClient({ userAgent: "t", minDelayMs: 0, sleep: async () => undefined, fetchImpl: (async (u: string | URL | Request) => (String(u).endsWith("robots.txt") ? new Response("") : new Response("<html>maintenance</html>"))) as typeof fetch }) };
  await assert.rejects(runListJob(bad), /expected hundreds/);
});
