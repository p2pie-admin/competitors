import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { zipSync } from "fflate";
import { openDb } from "../src/db";
import { Store } from "../src/db/store";
import { PoliteClient } from "../src/http/client";
import { loadConfig } from "../src/config";
import { OurExchangers } from "../src/core/ourExchangers";
import { Scheduler } from "../src/core/scheduler";
import type { JobCtx } from "../src/core/types";
import { logger } from "../src/log";
import { runApiJob } from "../src/sources/bestchange/api";
import { runListJob, applySeed } from "../src/sources/bestchange/list";
import { runMatchJob } from "../src/sources/bestchange/match";
import { runPagesJob } from "../src/sources/bestchange/pages.job";

type ResponseBody = ConstructorParameters<typeof Response>[0];
const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n));
const enc = (s: string) => new TextEncoder().encode(s);
// "Сова" in windows-1251
const SOVA_1251 = Uint8Array.from([0xd1, 0xee, 0xe2, 0xe0]);

const zipFixture = (): Uint8Array => {
  let exch = "";
  let rates = "";
  const parts: number[] = [];
  const push = (arr: Uint8Array) => parts.push(...arr);
  // 120 plausible exchangers: id 1000..1119; 1006 is "Сова"
  const exchBytes: number[] = [];
  for (let i = 0; i < 120; i++) {
    const id = 1000 + i;
    const line = i === 6 ? [...enc(`${id};`), ...SOVA_1251, ...enc(";;0;124272375\n")] : [...enc(`${id};Ex${id};;0;${1000 + i}\n`)];
    exchBytes.push(...line);
    for (let d = 0; d < 3; d++) rates += `10;23;${id};1;1;5;${i === 6 ? "0.88673" : "1.50"};1;1;2;0\n`;
  }
  void exch; void push; void parts;
  return zipSync({ "bm_exch.dat": Uint8Array.from(exchBytes), "bm_rates.dat": enc(rates) });
};

type Route = (url: string, init?: RequestInit) => Response | undefined;

const setup = (routes: Route[], env: Record<string, string> = {}, ourList: unknown = []) => {
  const config = loadConfig({ LOG_LEVEL: "error", BESTCHANGE_PAGES_PER_TICK: "5", ...env } as NodeJS.ProcessEnv);
  const store = new Store(openDb(":memory:"));
  store.ensureSource("bestchange", "BestChange", config.BESTCHANGE_SITE);
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /*?\n");
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new PoliteClient({ userAgent: "t/1", minDelayMs: 0, fetchImpl, sleep: async () => undefined });
  const ours = new OurExchangers("http://server", (async () => new Response(JSON.stringify(ourList))) as typeof fetch);
  const ctx: JobCtx = { store, client, config, ours, log: logger("test"), fetch: fetchImpl };
  return { ctx, store, seen, config };
};

const zipRoute: Route = (url) => (url.endsWith("info.zip") ? new Response(zipFixture() as unknown as ResponseBody, { status: 200, headers: { etag: '"z1"', "last-modified": "Sun, 04 Oct 2026 20:00:00 GMT" } }) : undefined);
const listRoute: Route = (url) =>
  url.endsWith("/list.html")
    ? new Response(
        // 120 rows so the sanity threshold passes; row i has slug "ex<id>"; 1006 -> sova
        `<html><body><table><tbody>${Array.from({ length: 120 }, (_, i) => {
          const id = 1000 + i;
          const slug = i === 6 ? "sova" : `ex${id}`;
          return `<tr onclick="ccl(${id})"><td class="bj"><div class="ca">${i === 6 ? "Сова" : "Ex" + id}</div></td><td class="bj bp">Работает</td><td class="ar arp">$1 000</td><td class="ar arp">3</td><td class="rw"><a href="/${slug}-exchanger.html">12</a></td></tr>`;
        }).join("")}</tbody></table></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      )
    : undefined;
const sovaPage: Route = (url) => (url.endsWith("/sova-exchanger.html") ? new Response(fx("bestchange-exchanger-sova.html") as unknown as ResponseBody, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : undefined);

test("api job: imports exchangers, daily snapshot, conditional GET, refuses a tiny snapshot", async () => {
  const { ctx, store } = setup([zipRoute]);
  const stats = await runApiJob(ctx);
  assert.equal(stats.exchangers, 120);
  assert.equal(stats.rows, 360);
  const sova = store.getExchanger("bestchange", "1006")!;
  assert.equal(sova.name, "Сова");
  assert.equal(sova.directions, 3);
  assert.equal(sova.reviews_pos, 88673);
  assert.equal(sova.reserve_usd, 124272375);
  assert.equal(store.dailyHistory("bestchange", "1006", 5).length, 1);
  assert.equal(store.kvGet("bestchange:zip:etag"), '"z1"');

  // a second poll with a 304 changes nothing
  const again = setup([(u, init) => (u.endsWith("info.zip") ? ((init?.headers as Record<string, string>)["if-none-match"] ? new Response(null, { status: 304 }) : undefined) : undefined)]);
  again.store.kvSet("bestchange:zip:etag", '"z1"');
  assert.deepEqual(await runApiJob(again.ctx), { notModified: true });

  const tiny = setup([(u) => (u.endsWith("info.zip") ? new Response(zipSync({ "bm_exch.dat": enc("1;A;;0;1\n"), "bm_rates.dat": enc("1;2;1;1;1;1;0.1;1;1;1;0\n") }) as unknown as ResponseBody) : undefined)]);
  await assert.rejects(runApiJob(tiny.ctx), /suspicious snapshot/);
});

test("api job: exchangers missing from a good snapshot become 'gone'", async () => {
  const { ctx, store } = setup([zipRoute]);
  store.upsertExchangerFromApi({ source: "bestchange", ext_id: "9999", name: "Vanished", reserve_usd: 1, directions: 1, reviews_pos: 0, reviews_neg: 0 });
  const stats = await runApiJob(ctx);
  assert.equal(stats.gone, 1);
  assert.equal(store.getExchanger("bestchange", "9999")!.status, "gone");
});

test("list job gives id <-> slug; seed fills what the list lacks", async () => {
  const { ctx, store } = setup([zipRoute, listRoute]);
  await runApiJob(ctx);
  const stats = await runListJob(ctx);
  assert.equal(stats.rows, 120);
  assert.equal(store.getExchanger("bestchange", "1006")!.slug, "sova");
  assert.equal(store.getExchanger("bestchange", "1006")!.url, "https://www.bestchange.ru/sova-exchanger.html");

  const e = setup([zipRoute]);
  await runApiJob(e.ctx);
  assert.equal(applySeed(e.ctx, [{ ext_id: "1006", name: "Сова", slug: "sova", domain: "www.sova.gg" }]), 1);
  assert.equal(e.store.getExchanger("bestchange", "1006")!.domain, "sova.gg");
});

test("list job refuses a page that parses to almost nothing", async () => {
  const { ctx } = setup([(u) => (u.endsWith("/list.html") ? new Response("<html><body>maintenance</body></html>") : undefined)]);
  await assert.rejects(runListJob(ctx), /expected hundreds/);
});

const ours = { "859": { id: "859", name: "Sova", status: "active", ref_link: "https://sova.gg/?r=1" }, "860": { id: "860", name: "Draft one", status: "draft", ref_link: "https://draft.example" } };

test("match job: links by domain/name, ignores drafts, keeps manual links, drops stale ones", async () => {
  const { ctx, store } = setup([zipRoute, listRoute], {}, ours);
  await runApiJob(ctx);
  await runListJob(ctx);
  store.setDomainIfMissing("bestchange", "1006", "sova.gg");
  const stats = await runMatchJob(ctx);
  assert.equal(stats.linked, 1);
  assert.equal(store.getLink("bestchange", "1006")!.our_exchanger_id, "859");
  assert.equal(store.getLink("bestchange", "1006")!.method, "domain");

  // a human link survives automatic re-matching, even to a different exchanger
  store.upsertLink({ source: "bestchange", ext_id: "1001", our_exchanger_id: "860", our_name: "Draft one", method: "manual", confidence: 1, locked: true });
  await runMatchJob(ctx);
  assert.ok(store.getLink("bestchange", "1001"));

  // an automatic link whose basis disappeared is removed
  store.upsertLink({ source: "bestchange", ext_id: "1002", our_exchanger_id: "859", our_name: "Sova", method: "name", confidence: 0.8 });
  const s2 = await runMatchJob(ctx);
  assert.equal(s2.removed, 1);
  assert.equal(store.getLink("bestchange", "1002"), undefined);
});

test("pages job: crawls only linked exchangers, imports reviews with moderation, never requests query URLs", async () => {
  const { ctx, store, seen } = setup([zipRoute, listRoute, sovaPage], {}, ours);
  await runApiJob(ctx);
  await runListJob(ctx);
  store.setDomainIfMissing("bestchange", "1006", "sova.gg");
  await runMatchJob(ctx);

  const stats = await runPagesJob(ctx);
  assert.equal(stats.candidates, 1);
  assert.equal(stats.fetched, 1);
  assert.equal(stats.inserted, 7, "6 ordinary reviews + the source-flagged one (stored, but held back)");
  assert.equal(stats.pending, 1);
  const reviews = store.listReviews({ source: "bestchange", extId: "1006", limit: 50, offset: 0 });
  const byId = new Map(reviews.map((r) => [r.ext_review_id, r]));
  assert.equal(byId.get("4054789")!.status, "published");
  assert.equal(byId.get("4054789")!.rating, 5);
  assert.match(byId.get("4054789")!.reply_text ?? "", /Благодарим/);
  assert.equal(byId.get("4053541")!.status, "pending", "flagged by the source's moderators -> held back");
  assert.equal(store.getExchanger("bestchange", "1006")!.reviews_total, 89463);
  assert.equal(store.getExchanger("bestchange", "1006")!.claims_closed, 650);
  assert.ok(seen.every((u) => !u.includes("?")), "no query URLs were requested: " + seen.filter((u) => u.includes("?")).join(","));

  // an immediate second tick has nothing to do (fresh), a later one re-reads without duplicating
  assert.equal((await runPagesJob(ctx)).candidates, 0);
  store.db.prepare("UPDATE source_exchangers SET page_fetched_at = 1").run();
  const second = await runPagesJob(ctx);
  assert.equal(second.inserted, 0);
  assert.equal(second.unchanged, 7);
  assert.equal(store.listReviews({ source: "bestchange", limit: 50, offset: 0 }).length, 7);
});

test("pages job: a slug that belongs to another exchanger id is dropped, nothing imported", async () => {
  const { ctx, store } = setup([zipRoute, listRoute, sovaPage], {}, ours);
  await runApiJob(ctx);
  await runListJob(ctx);
  // pretend slug "sova" got attached to exchanger 1001
  store.setSlug("bestchange", "1001", "sova", "https://www.bestchange.ru/sova-exchanger.html");
  store.upsertLink({ source: "bestchange", ext_id: "1001", our_exchanger_id: "859", our_name: "Sova", method: "manual", confidence: 1, locked: true });
  const stats = await runPagesJob(ctx);
  assert.equal(stats.failed, 1);
  assert.equal(store.listReviews({ limit: 10, offset: 0 }).length, 0);
  assert.equal(store.getExchanger("bestchange", "1001")!.slug, null);
});

test("pages job: robots-disallowed pages are skipped quietly and a 403 stops the tick", async () => {
  const blocked = setup([zipRoute, listRoute, (u) => (u.endsWith("sova-exchanger.html") ? new Response("", { status: 403 }) : undefined)], {}, ours);
  await runApiJob(blocked.ctx);
  await runListJob(blocked.ctx);
  blocked.store.setDomainIfMissing("bestchange", "1006", "sova.gg");
  await runMatchJob(blocked.ctx);
  const s = await runPagesJob(blocked.ctx);
  assert.equal(s.failed, 1);
  assert.equal(s.fetched, 0);
});

test("scheduler: runs jobs one at a time, records runs, survives failures", async () => {
  const { ctx, store } = setup([]);
  const sch = new Scheduler(ctx);
  const order: string[] = [];
  sch.add({ name: "a", everyMs: 3600_000, initialDelayMs: 3600_000, run: async () => (order.push("a-start"), await new Promise((r) => setTimeout(r, 30)), order.push("a-end"), { n: 1 }) });
  sch.add({ name: "b", everyMs: 3600_000, initialDelayMs: 3600_000, run: async () => { order.push("b"); throw new Error("boom"); } });
  const [ra, rb] = await Promise.allSettled([sch.runNow("a"), sch.runNow("b")]);
  assert.equal(ra.status, "fulfilled");
  assert.equal(rb.status, "rejected");
  assert.deepEqual(order, ["a-start", "a-end", "b"], "no overlap");
  assert.equal(store.lastRunOf("a")!.ok, 1);
  assert.equal(store.lastRunOf("b")!.ok, 0);
  assert.match(store.lastRunOf("b")!.error ?? "", /boom/);
  assert.equal(sch.jobs().find((j) => j.name === "b")!.failures, 1);
  await assert.rejects(sch.runNow("nope"), /unknown job/);
  sch.stop();
});

test("revalidate: slug matches the front, skipped when not configured, request shape", async () => {
  const { exchangerSlug, revalidateExchangerPages } = await import("../src/core/revalidate");
  assert.equal(exchangerSlug("Crypto-Box"), "crypto-box");
  assert.equal(exchangerSlug("  Bitok 777 "), "bitok_777");
  assert.equal(exchangerSlug("Сова"), "", "non-latin names have no slug");
  assert.deepEqual(await revalidateExchangerPages({ FRONT_URL: undefined, REVALIDATE_SECRET: undefined }, ["A"]), { requested: 0, ok: true });
  const calls: Array<{ url: string; body: string; secret: string }> = [];
  const fakeFetch = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), body: String(init?.body), secret: (init?.headers as Record<string, string>)["x-revalidate-secret"]! });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const r = await revalidateExchangerPages({ FRONT_URL: "http://front:3000/", REVALIDATE_SECRET: "s" }, ["Sova", "sova", "Crypto-Box"], fakeFetch);
  assert.deepEqual(r, { requested: 2, ok: true });
  assert.equal(calls[0]!.url, "http://front:3000/api/revalidate");
  assert.deepEqual(JSON.parse(calls[0]!.body).paths, ["/exchangers/sova", "/exchangers/crypto-box"]);
  assert.equal(calls[0]!.secret, "s");
});

test("pages job asks the front to revalidate exchangers with new reviews", async () => {
  const hits: string[] = [];
  const front: Route = (url, init) => (url.endsWith("/api/revalidate") ? (hits.push(String(init?.body)), new Response("{}", { status: 200 })) : undefined);
  const { ctx, store } = setup([zipRoute, listRoute, sovaPage, front], { FRONT_URL: "http://front:3000", REVALIDATE_SECRET: "s" }, ours);
  await runApiJob(ctx);
  await runListJob(ctx);
  store.setDomainIfMissing("bestchange", "1006", "sova.gg");
  await runMatchJob(ctx);
  const stats = await runPagesJob(ctx);
  assert.equal(stats.revalidated, 1);
  assert.deepEqual(JSON.parse(hits[0]!).paths, ["/exchangers/sova"]);
});

test("a stored review that a later crawl shows to be a claim is retired", async () => {
  const { importReviews } = await import("../src/core/importReviews");
  const { ctx, store } = setup([]);
  const base = { author: "A", country: null, rating: null, sentiment: null, postedAt: 1_790_000_000, permalink: "u", flagTexts: [], reply: null, text: "Не выплатили заявку уже третий день, прошу разобраться" };
  importReviews(ctx, "bestchange", { ext_id: "1006" }, [{ ...base, extReviewId: "5", kind: "review" }], "https://x");
  assert.equal(store.listReviews({ limit: 5, offset: 0 })[0]!.status, "published");
  const s = importReviews(ctx, "bestchange", { ext_id: "1006" }, [{ ...base, extReviewId: "5", kind: "claim" }], "https://x");
  assert.equal(s.skippedClaims, 1);
  const row = store.listReviews({ limit: 5, offset: 0 })[0]!;
  assert.equal(row.status, "rejected");
  assert.equal(row.reject_reason, "claim");
});
