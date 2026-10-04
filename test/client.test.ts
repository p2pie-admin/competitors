import { test } from "node:test";
import assert from "node:assert/strict";
import { PoliteClient } from "../src/http/client";
import { BlockedByRobotsError, CircuitOpenError, HttpError, TooLargeError } from "../src/http/errors";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const make = (handler: Handler, o: { minDelayMs?: number } = {}) => {
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: clock, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init);
  }) as typeof fetch;
  const client = new PoliteClient({
    userAgent: "test-agent/1.0 (+https://example.test; ops@example.test)",
    minDelayMs: o.minDelayMs ?? 5000,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms) };
};

const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const ROBOTS = "User-agent: *\nDisallow: /*?\nDisallow: /private/\nAllow: /private/ok\n";

test("sends the identifying User-Agent and decodes the declared charset", async () => {
  const { client, calls } = make((url) => {
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    // "Сова" in windows-1251
    return new Response(Uint8Array.from([0xd1, 0xee, 0xe2, 0xe0]), { status: 200, headers: { "content-type": "text/html; charset=windows-1251" } });
  });
  const res = await client.get("https://site.test/a.html");
  assert.equal(res.text, "Сова");
  const page = calls.find((c) => c.url.endsWith("a.html"))!;
  assert.match(page.headers["user-agent"]!, /test-agent\/1.0 \(\+https:\/\/example.test; ops@example.test\)/);
});

test("robots.txt: disallowed paths are never requested, allowed ones are", async () => {
  const { client, calls } = make((url) => (url.endsWith("/robots.txt") ? new Response(ROBOTS) : html("ok")));
  await assert.rejects(client.get("https://site.test/a.html?page=2"), BlockedByRobotsError);
  await assert.rejects(client.get("https://site.test/private/x"), BlockedByRobotsError);
  assert.equal((await client.get("https://site.test/private/ok")).text, "ok");
  assert.equal((await client.get("https://site.test/plain.html")).text, "ok");
  assert.equal(calls.filter((c) => c.url.includes("?page=2") || c.url.endsWith("/private/x")).length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/robots.txt")).length, 1, "robots.txt cached");
});

test("robots.txt 5xx means disallow (conservative); 4xx means allow", async () => {
  const down = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 503 }) : html("ok")));
  await assert.rejects(down.client.get("https://site.test/a.html"), BlockedByRobotsError);
  const missing = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : html("ok")));
  assert.equal((await missing.client.get("https://site.test/a.html")).text, "ok");
});

test("requests to one host are spaced by at least the minimum delay", async () => {
  const { client, calls, sleeps } = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : html("ok")), { minDelayMs: 5000 });
  await client.get("https://site.test/1.html");
  await client.get("https://site.test/2.html");
  await client.get("https://site.test/3.html");
  const pages = calls.filter((c) => !c.url.endsWith("robots.txt"));
  assert.ok(pages[1]!.at - pages[0]!.at >= 5000);
  assert.ok(pages[2]!.at - pages[1]!.at >= 5000);
  assert.ok(sleeps.length >= 2);
});

test("Crawl-delay from robots.txt overrides a smaller minimum", async () => {
  const { client, calls } = make((url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nCrawl-delay: 20\n") : html("ok")), { minDelayMs: 1000 });
  await client.get("https://site.test/1.html");
  await client.get("https://site.test/2.html");
  const pages = calls.filter((c) => !c.url.endsWith("robots.txt"));
  assert.ok(pages[1]!.at - pages[0]!.at >= 20_000);
});

test("conditional GET: 304 is reported, validators are sent", async () => {
  const { client, calls } = make((url, init) => {
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const h = init?.headers as Record<string, string>;
    return h["if-none-match"] === '"abc"' ? new Response(null, { status: 304 }) : html("fresh", { etag: '"abc"' });
  });
  const first = await client.get("https://site.test/f.zip");
  assert.equal(first.headers["etag"], '"abc"');
  const second = await client.get("https://site.test/f.zip", { etag: '"abc"', lastModified: "Sun, 04 Oct 2026 20:00:00 GMT" });
  assert.equal(second.notModified, true);
  assert.equal(second.text, null);
  const last = calls[calls.length - 1]!;
  assert.equal(last.headers["if-modified-since"], "Sun, 04 Oct 2026 20:00:00 GMT");
});

test("5xx is retried with backoff and then succeeds", async () => {
  let n = 0;
  const { client, sleeps } = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : ++n < 3 ? new Response("", { status: 502 }) : html("finally")));
  const res = await client.get("https://site.test/flaky.html");
  assert.equal(res.text, "finally");
  assert.equal(n, 3);
  assert.ok(sleeps.some((s) => s >= 2000));
});

test("404 is final (no retries) and 403 opens the circuit", async () => {
  let n404 = 0;
  const a = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : (n404++, new Response("", { status: 404 }))));
  await assert.rejects(a.client.get("https://site.test/gone.html"), HttpError);
  assert.equal(n404, 1);

  const b = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("", { status: 403 })));
  await assert.rejects(b.client.get("https://site.test/x.html"), HttpError);
  await assert.rejects(b.client.get("https://site.test/y.html"), CircuitOpenError);
});

test("429 with Retry-After opens the circuit for that time", async () => {
  const { client } = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("", { status: 429, headers: { "retry-after": "120" } })));
  await assert.rejects(client.get("https://site.test/a.html"));
  const until = client.circuitUntil("site.test");
  assert.ok(until && until > 0);
  await assert.rejects(client.get("https://site.test/b.html"), CircuitOpenError);
});

test("circuit breaker state can be persisted through hooks", async () => {
  const saved = new Map<string, number | null>();
  const fetchImpl = (async (u: string | URL | Request) => (String(u).endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response("", { status: 403 }))) as typeof fetch;
  const client = new PoliteClient({
    userAgent: "ua",
    minDelayMs: 0,
    fetchImpl,
    sleep: async () => undefined,
    hooks: { saveCircuit: (h, u) => void saved.set(h, u), loadCircuit: (h) => saved.get(h) ?? null },
  });
  await assert.rejects(client.get("https://site.test/a.html"));
  assert.ok(saved.get("site.test"));
  // a "restarted" client reading the same persisted state stays closed for that host
  const second = new PoliteClient({ userAgent: "ua", minDelayMs: 0, fetchImpl, hooks: { loadCircuit: (h) => saved.get(h) ?? null } });
  await assert.rejects(second.get("https://site.test/b.html"), CircuitOpenError);
});

test("response size cap", async () => {
  const big = "x".repeat(2000);
  const { client } = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : html(big)));
  await assert.rejects(client.get("https://site.test/big.html", { maxBytes: 1000 }), TooLargeError);
});

test("binary decode returns bytes", async () => {
  const { client } = make((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(Uint8Array.from([1, 2, 3]), { status: 200 })));
  const res = await client.get("https://site.test/f.bin", { decode: "binary" });
  assert.deepEqual([...res.bytes!], [1, 2, 3]);
  assert.equal(res.text, null);
});
