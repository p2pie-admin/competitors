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
  /** The date shown and sorted by (= external_date for copies). */
  review_date: string;
};

export type StrapiRatingExchanger = {
  id: string;
  name: string;
  status: string | null;
  admin_rating: number | null;
  trust_level: string | null;
  trust_score: number | null;
  reviews_count: number | null;
  rating_details: unknown;
  rating_locked: boolean;
  check_verdict: string | null;
  check_score: number | null;
  /** exchanger_card.date_created, "DD.MM.YYYY". */
  date_created: string | null;
};

/** `{id, attributes}` / `{data: {id, attributes}}` / already flat -> `{id, ...attributes}`. */
const flat = (v: unknown): Record<string, unknown> => {
  let o = v as Record<string, unknown> | null;
  if (o && typeof o === "object" && "data" in o && !("id" in o)) o = o.data as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return {};
  const attrs = o.attributes as Record<string, unknown> | undefined;
  return attrs && typeof attrs === "object" ? { id: o.id, ...attrs } : o;
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

  /** All pages of a REST list, rows flattened to `{id, ...attributes}` whatever the response shape. */
  private async listAll(path: string, query: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    const size = 100;
    for (let page = 1; page <= 200; page++) {
      const res = (await this.call("GET", `${path}?${query}&pagination[page]=${page}&pagination[pageSize]=${size}`)) as unknown;
      const rows = (Array.isArray(res) ? res : (res as { data?: unknown } | null)?.data) as unknown;
      if (!Array.isArray(rows)) break;
      for (const r of rows) out.push(flat(r));
      if (rows.length < size) break;
    }
    return out;
  }

  /** Our listed exchangers with what the rating needs (and what it wrote last time). */
  async listExchangersForRating(): Promise<StrapiRatingExchanger[]> {
    const fields = ["name", "status", "admin_rating", "trust_level", "trust_score", "reviews_count", "rating_details", "rating_locked", "check_verdict", "check_score"];
    // Only what the site shows: drafts and paused exchangers get a rating when they go live.
    const q =
      fields.map((f, i) => `fields[${i}]=${f}`).join("&") +
      "&populate[exchanger_card][fields][0]=date_created&filters[status][$in][0]=active&filters[status][$in][1]=suspended";
    return (await this.listAll("/api/exchangers", q)).map((r) => {
      const card = r.exchanger_card ? flat(r.exchanger_card) : null;
      const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
      return {
        id: String(r.id),
        name: String(r.name ?? ""),
        status: typeof r.status === "string" ? r.status : null,
        admin_rating: num(r.admin_rating),
        trust_level: typeof r.trust_level === "string" ? r.trust_level : null,
        trust_score: num(r.trust_score),
        reviews_count: num(r.reviews_count),
        rating_details: r.rating_details ?? null,
        rating_locked: r.rating_locked === true,
        check_verdict: typeof r.check_verdict === "string" ? r.check_verdict : null,
        check_score: num(r.check_score),
        date_created: card && typeof card.date_created === "string" ? card.date_created : null,
      };
    });
  }

  /** Approved reviews left by our own users (no `source`), counted per exchanger id. */
  async nativeReviewCounts(): Promise<Map<string, { positive: number; negative: number; neutral: number }>> {
    const q = "fields[0]=type&filters[source][$null]=true&filters[isApproved][$eq]=true&populate[exchanger][fields][0]=name";
    const out = new Map<string, { positive: number; negative: number; neutral: number }>();
    for (const r of await this.listAll("/api/reviews", q)) {
      const ex = r.exchanger ? flat(r.exchanger) : null;
      if (!ex || ex.id == null) continue;
      const c = out.get(String(ex.id)) ?? { positive: 0, negative: 0, neutral: 0 };
      if (r.type === "positive") c.positive++;
      else if (r.type === "negative") c.negative++;
      else if (r.type === "neutral") c.neutral++;
      out.set(String(ex.id), c);
    }
    return out;
  }

  async updateExchanger(id: string, data: Record<string, unknown>): Promise<void> {
    await this.call("PUT", `/api/exchangers/${encodeURIComponent(id)}`, { data });
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
