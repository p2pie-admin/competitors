import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { parseCiList, parseCiReviewPage, parseCiDate } from "../src/sources/changeinfo/pages";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { PoliteClient } from "../src/http/client";
import { loadConfig } from "../src/config";
import { OurExchangers } from "../src/core/ourExchangers";
import { logger } from "../src/log";
import type { JobCtx } from "../src/core/types";
import { runListJob, runMatchJob, runPagesJob } from "../src/sources/changeinfo/jobs";

const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("list: slug, name, website domain, reserve, counters", () => {
  const rows = parseCiList(fx("changeinfo-list.html"));
  assert.equal(rows.length, 12);
  const obm = rows.find((r) => r.slug === "obmenka");
  assert.ok(obm);
  assert.equal(obm.name, "Obmenka");
  assert.equal(obm.domain, "obmenka.ua", "the website behind the referral link, not the monitoring");
  assert.equal(obm.reserveUsd, 68275);
  assert.equal(obm.rates, 38);
  assert.equal(obm.positive, 348);
  assert.equal(obm.negative, 0);
  assert.equal(obm.working, true);
});

test("date dd mm yyyy hh:mm Moscow time", () => {
  assert.equal(parseCiDate("24 09 2025 03:31"), Date.UTC(2025, 8, 24, 0, 31) / 1000);
  assert.equal(parseCiDate("nonsense"), null);
});

test("review page: tone, author, country, date, permalink", () => {
  const url = "https://changeinfo.ru/review/obmenka";
  const p = parseCiReviewPage(fx("changeinfo-review-obmenka.html"), url);
  assert.equal(p.reviews.length, 8);
  const ok = p.reviews.find((r) => r.text === "Отлично работает")!;
  assert.equal(ok.sentiment, "positive");
  assert.equal(ok.kind, "review");
  assert.ok(ok.postedAt === Date.UTC(2022, 11, 10, 5, 33) / 1000);
  assert.match(ok.permalink!, /^https:\/\/changeinfo\.ru\/review\/obmenka#comment-\d+$/);
  const neg = p.reviews.find((r) => r.text.startsWith("Сервис не работает"))!;
  assert.equal(neg.sentiment, "negative");
  assert.ok(p.reviews.every((r) => /^\d+$/.test(r.extReviewId)));
});

type Body = ConstructorParameters<typeof Response>[0];
const setup = () => {
  const config = loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("changeinfo", "ChangeInfo", config.CHANGEINFO_SITE);
  const bigList = `<html><body><table><tbody>${Array.from({ length: 60 }, (_, i) => `<tr><td><span class="work" title=" Работает "></span></td><td><h4><a href="https://ex${i}.example/r?x=1">Ex${i}</a></h4></td><td data-value="1"><strong>5 $</strong></td><td><a href="/review/Ex${i}/negative" class="negative">0</a><a href="/review/Ex${i}/positive" class="positive">3</a></td></tr>`).join("")}${
    fx("changeinfo-list.html").match(/<tr>\s*<td style="--status.*?<\/tr>/s)![0]
  }</tbody></table></body></html>`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /*negative*\nDisallow: /*positive*\n");
    if (url.endsWith("/exchangers")) return new Response(bigList as Body, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.endsWith("/review/obmenka")) return new Response(fx("changeinfo-review-obmenka.html") as unknown as Body, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const ours = new OurExchangers("http://s", (async () => new Response(JSON.stringify({ "5": { id: "5", name: "Obmenka", status: "active", ref_link: "https://obmenka.ua/x" } }))) as typeof fetch);
  const ctx: JobCtx = { store, config, ours, log: logger("t"), fetch: fetchImpl, client: new PoliteClient({ userAgent: "t", minDelayMs: 0, fetchImpl, sleep: async () => undefined }) };
  return { ctx, store };
};

test("changeinfo jobs: list -> match by website domain -> pages with strict moderation", async () => {
  const { ctx, store } = setup();
  await runListJob(ctx);
  const ex = store.getExchanger("changeinfo", "obmenka")!;
  assert.equal(ex.domain, "obmenka.ua");
  assert.equal(ex.url, "https://changeinfo.ru/review/obmenka");
  assert.equal((await runMatchJob(ctx)).linked, 1);
  assert.equal(store.getLink("changeinfo", "obmenka")!.method, "domain");

  const pages = await runPagesJob(ctx);
  assert.equal(pages.fetched, 1);
  const by = new Map(store.listReviews({ source: "changeinfo", limit: 50, offset: 0 }).map((r) => [r.text.slice(0, 20), r]));
  const code = [...by.values()].find((r) => r.text.startsWith("const { createServer }"))!;
  assert.equal(code.status, "rejected", "pasted code is not a review");
  const invoice = [...by.values()].find((r) => r.text.startsWith("lnbc"))!;
  assert.equal(invoice.status, "rejected", "a Lightning invoice is not a review");
  const good = [...by.values()].filter((r) => r.status === "published");
  assert.ok(good.length >= 5, "real reviews pass, negative ones included: " + good.length);
  assert.ok(good.some((r) => r.sentiment === "negative"));
});
