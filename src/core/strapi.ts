import { logger } from "../log";

const log = logger("strapi");

export type StrapiConfig = { baseUrl: string; identifier: string; password: string };

export class StrapiError extends Error {
  constructor(readonly status: number, readonly body: string, what: string) {
    super(`Strapi ${what} failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = "StrapiError";
  }
}

export type StrapiReviewInput = {
  exchanger: string;
  text: string;
  type: "positive" | "neutral" | "negative";
  name: string | null;
  location: string | null;
  fingerprint: string;
  isApproved: boolean;
  source: string;
  external_link: string;
  external_id: string;
  external_date: string;
};

/**
 * Minimal Strapi 4 REST client for the `review` / `review-reply` collections.
 * Logs in with a Strapi user (users-permissions) and re-logs in once when the token is rejected.
 * The `transformer` plugin flattens responses (`{id,...}` instead of `{data:{id,attributes}}`), both shapes are read.
 */
export class StrapiClient {
  private jwt: string | null = null;

  constructor(private readonly cfg: StrapiConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async login(): Promise<void> {
    const res = await this.fetchImpl(this.url("/api/auth/local"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: this.cfg.identifier, password: this.cfg.password }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new StrapiError(res.status, text, "login");
    const jwt = (JSON.parse(text) as { jwt?: string }).jwt;
    if (!jwt) throw new Error("Strapi login returned no jwt");
    this.jwt = jwt;
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    if (!this.jwt) await this.login();
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.jwt}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && !retried) {
      this.jwt = null;
      return this.call(method, path, body, true);
    }
    const text = await res.text();
    if (!res.ok) throw new StrapiError(res.status, text, `${method} ${path}`);
    return text ? JSON.parse(text) : null;
  }

  /** Reads an id out of `{id}` / `{data:{id}}` / `{data:[{id}]}`. */
  static idOf(payload: unknown): string | null {
    const p = payload as { id?: unknown; data?: unknown } | null;
    if (!p) return null;
    if (p.id != null) return String(p.id);
    const d = p.data as { id?: unknown } | Array<{ id?: unknown }> | null | undefined;
    if (Array.isArray(d)) return d[0]?.id != null ? String(d[0].id) : null;
    if (d && typeof d === "object" && d.id != null) return String(d.id);
    return null;
  }

  async findReviewByFingerprint(fingerprint: string): Promise<string | null> {
    const q = `/api/reviews?filters[fingerprint][$eq]=${encodeURIComponent(fingerprint)}&pagination[pageSize]=1`;
    const out = await this.call("GET", q);
    return StrapiClient.idOf(Array.isArray(out) ? { data: out } : out);
  }

  async createReview(data: StrapiReviewInput): Promise<string> {
    try {
      const out = await this.call("POST", "/api/reviews", { data });
      const id = StrapiClient.idOf(out);
      if (!id) throw new Error("Strapi created a review but returned no id");
      return id;
    } catch (err) {
      // The fingerprint is unique: a previous run may have created it before crashing. Adopt it.
      if (err instanceof StrapiError && err.status === 400 && /unique/i.test(err.body)) {
        const existing = await this.findReviewByFingerprint(data.fingerprint);
        if (existing) {
          log.warn("adopting existing review", { fingerprint: data.fingerprint, id: existing });
          return existing;
        }
      }
      throw err;
    }
  }

  async updateReview(id: string, data: Partial<StrapiReviewInput>): Promise<void> {
    await this.call("PUT", `/api/reviews/${encodeURIComponent(id)}`, { data });
  }

  async deleteReview(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/api/reviews/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof StrapiError && err.status === 404) return; // already gone
      throw err;
    }
  }

  async createReply(reviewId: string, text: string): Promise<string> {
    const out = await this.call("POST", "/api/review-replies", { data: { review: reviewId, text, from: "exchanger", iaApproved: true } });
    const id = StrapiClient.idOf(out);
    if (!id) throw new Error("Strapi created a reply but returned no id");
    return id;
  }

  async deleteReply(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/api/review-replies/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof StrapiError && err.status === 404) return;
      throw err;
    }
  }
}
