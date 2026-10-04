import { BlockedByRobotsError, CircuitOpenError, HttpError, TooLargeError } from "./errors";
import { RobotsGate } from "./robots";
import { logger } from "../log";

const log = logger("http");

export type Decode = "utf8" | "windows-1251" | "binary";

export type FetchOptions = {
  /** Force a decoding (default: the Content-Type charset, else `fallbackDecode`, else utf-8). */
  decode?: Decode;
  fallbackDecode?: "utf8" | "windows-1251";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  retries?: number;
  respectRobots?: boolean;
  etag?: string | null;
  lastModified?: string | null;
};

export type FetchResult = {
  url: string;
  status: number;
  notModified: boolean;
  headers: Record<string, string>;
  text: string | null;
  bytes: Uint8Array | null;
  size: number;
  ms: number;
};

export interface ClientHooks {
  onFetch?: (f: { host: string; url: string; status: number | null; ms: number; bytes: number; note?: string }) => void;
  loadCircuit?: (host: string) => number | null; // epoch seconds when open until
  saveCircuit?: (host: string, untilSec: number | null) => void;
}

export type ClientOptions = {
  userAgent: string;
  /** Minimum gap between two requests starting on the same host. */
  minDelayMs: number;
  /** Default timeout for one attempt. */
  timeoutMs?: number;
  hooks?: ClientHooks;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const CIRCUIT_OPEN_SEC = 30 * 60;
const CIRCUIT_THRESHOLD = 4;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The only way this service talks to other sites. Guarantees:
 *  - identifying User-Agent with a contact;
 *  - robots.txt is obeyed (RFC 9309) unless explicitly disabled for an official data feed;
 *  - requests to one host are serialized with a minimum gap (+ jitter) and the site's Crawl-delay;
 *  - 429/503 honor Retry-After; repeated failures or blocks open a circuit breaker for 30 min;
 *  - responses are size-capped and decoded with the declared charset.
 */
export class PoliteClient {
  private readonly robots: RobotsGate;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nextAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.robots = new RobotsGate(
      opts.userAgent,
      async (url) => {
        const res = await this.doFetch(url, {
          headers: { "user-agent": opts.userAgent, accept: "text/plain,*/*;q=0.5" },
          signal: AbortSignal.timeout(15_000),
          redirect: "follow",
        });
        return { status: res.status, body: res.ok ? await res.text() : "" };
      },
      this.now
    );
  }

  /** Expose the robots decision (used by the crawl planner to skip disallowed paths cheaply). */
  isAllowed(url: string): Promise<boolean> {
    return this.robots.allowed(url);
  }

  circuitUntil(host: string): number | null {
    const mem = this.openUntil.get(host);
    const persisted = this.opts.hooks?.loadCircuit?.(host) ?? null;
    const until = Math.max(mem ?? 0, persisted ?? 0);
    return until > this.now() / 1000 ? until : null;
  }

  async get(url: string, o: FetchOptions = {}): Promise<FetchResult> {
    const host = new URL(url).host;
    const respectRobots = o.respectRobots ?? true;

    const until = this.circuitUntil(host);
    if (until) throw new CircuitOpenError(host, until);

    if (respectRobots && !(await this.robots.allowed(url))) {
      this.opts.hooks?.onFetch?.({ host, url, status: null, ms: 0, bytes: 0, note: "blocked by robots.txt" });
      throw new BlockedByRobotsError(url);
    }

    const retries = o.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.serialized(host, url, () => this.once(url, host, o));
        this.failures.set(host, 0);
        return res;
      } catch (err) {
        lastErr = err;
        if (err instanceof BlockedByRobotsError || err instanceof CircuitOpenError || err instanceof TooLargeError) throw err;
        const status = err instanceof HttpError ? err.status : null;
        // Client errors other than 408/429 are final: retrying will not change them.
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          if (status === 403) this.noteFailure(host, true);
          throw err;
        }
        this.noteFailure(host, status === 429);
        if (this.circuitUntil(host)) throw err;
        if (attempt < retries) {
          const backoff = Math.min(60_000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 500);
          log.warn("retrying", { url, attempt: attempt + 1, status, backoffMs: backoff });
          await this.sleep(backoff);
        }
      }
    }
    throw lastErr;
  }

  private noteFailure(host: string, hardBlock: boolean): void {
    const n = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, n);
    if (hardBlock || n >= CIRCUIT_THRESHOLD) {
      const until = Math.floor(this.now() / 1000) + CIRCUIT_OPEN_SEC;
      this.openUntil.set(host, until);
      this.opts.hooks?.saveCircuit?.(host, until);
      log.error("circuit opened", { host, until: new Date(until * 1000).toISOString(), failures: n, hardBlock });
    }
  }

  /** Queue per host: one request at a time, spaced by minDelay (+jitter) or the site's Crawl-delay. */
  private async serialized<T>(host: string, url: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(host, prev.then(() => mine));
    await prev;
    try {
      const crawlDelay = await this.robots.crawlDelayMs(url);
      const gap = Math.max(this.opts.minDelayMs, crawlDelay);
      const wait = (this.nextAt.get(host) ?? 0) - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.nextAt.set(host, this.now() + gap + Math.floor(Math.random() * Math.min(1500, gap * 0.25)));
      }
    } finally {
      release();
    }
  }

  private async once(url: string, host: string, o: FetchOptions): Promise<FetchResult> {
    const started = this.now();
    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
      "accept-language": "ru,en;q=0.5",
      "accept-encoding": "gzip, deflate, br",
      ...o.headers,
    };
    if (o.etag) headers["if-none-match"] = o.etag;
    if (o.lastModified) headers["if-modified-since"] = o.lastModified;

    let status: number | null = null;
    let size = 0;
    try {
      const res = await this.doFetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(o.timeoutMs ?? this.opts.timeoutMs ?? 45_000),
      });
      status = res.status;
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (outHeaders[k] = v));

      if (res.status === 304) {
        this.opts.hooks?.onFetch?.({ host, url, status, ms: this.now() - started, bytes: 0, note: "not modified" });
        return { url, status, notModified: true, headers: outHeaders, text: null, bytes: null, size: 0, ms: this.now() - started };
      }
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          const until = Math.floor(this.now() / 1000) + Math.min(ra, 3600);
          this.openUntil.set(host, until);
          this.opts.hooks?.saveCircuit?.(host, until);
        }
        throw new HttpError(url, res.status);
      }
      if (!res.ok) throw new HttpError(url, res.status);

      const max = o.maxBytes ?? DEFAULT_MAX_BYTES;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) throw new TooLargeError(url, max);
      const bytes = await readCapped(res, max, url);
      size = bytes.byteLength;

      const decode = o.decode ?? charsetOf(outHeaders["content-type"], o.fallbackDecode);
      const text = decode === "binary" ? null : new TextDecoder(decode).decode(bytes);
      const ms = this.now() - started;
      this.opts.hooks?.onFetch?.({ host, url, status, ms, bytes: size });
      return { url, status, notModified: false, headers: outHeaders, text, bytes: decode === "binary" ? bytes : null, size, ms };
    } catch (err) {
      if (!(err instanceof HttpError)) {
        this.opts.hooks?.onFetch?.({ host, url, status, ms: this.now() - started, bytes: size, note: String(err).slice(0, 200) });
      } else {
        this.opts.hooks?.onFetch?.({ host, url, status: err.status, ms: this.now() - started, bytes: 0 });
      }
      throw err;
    }
  }
}

const charsetOf = (contentType: string | undefined, fallback: "utf8" | "windows-1251" = "utf8"): "utf8" | "windows-1251" => {
  const m = /charset=([^;\s]+)/i.exec(contentType || "");
  if (!m) return fallback;
  return m[1]!.toLowerCase().includes("1251") ? "windows-1251" : "utf8";
};

const readCapped = async (res: Response, max: number, url: string): Promise<Uint8Array> => {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new TooLargeError(url, max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};
