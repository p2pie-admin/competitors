import type { DB } from "./index";
import { nowSec } from "./index";

export type SourceExchanger = {
  source: string;
  ext_id: string;
  name: string;
  slug: string | null;
  url: string | null;
  domain: string | null;
  country: string | null;
  status: "active" | "gone";
  reserve_usd: number | null;
  directions: number | null;
  reviews_pos: number | null;
  reviews_neg: number | null;
  claims_open: number | null;
  claims_closed: number | null;
  reviews_total: number | null;
  aml: string | null;
  age_text: string | null;
  on_source_text: string | null;
  first_seen: number;
  last_seen: number;
  page_fetched_at: number | null;
  page_hash: string | null;
};

export type ReviewStatus = "published" | "pending" | "hidden" | "rejected";

export type ExternalReview = {
  id: number;
  source: string;
  ext_id: string;
  ext_review_id: string;
  author: string | null;
  country: string | null;
  rating: number | null;
  text: string;
  text_hash: string;
  posted_at: number;
  source_url: string;
  reply_author: string | null;
  reply_text: string | null;
  reply_at: number | null;
  status: ReviewStatus;
  reject_reason: string | null;
  first_seen: number;
  last_seen: number;
  updated_at: number;
};

export type NewReview = Omit<ExternalReview, "id" | "first_seen" | "last_seen" | "updated_at">;

export type Link = {
  source: string;
  ext_id: string;
  our_exchanger_id: string;
  our_name: string | null;
  method: "domain" | "name" | "manual";
  confidence: number;
  locked: number;
  created_at: number;
  updated_at: number;
};

export type UpsertReviewResult = "inserted" | "updated" | "unchanged" | "takedown";

// All SQL lives here: the rest of the code works with typed methods.
export class Store {
  constructor(readonly db: DB) {}

  // ---- kv ------------------------------------------------------------------------------------
  kvGet(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  kvSet(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, value, nowSec());
  }
  kvDelete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  // ---- sources -------------------------------------------------------------------------------
  ensureSource(id: string, name: string, baseUrl: string, enabled = true): void {
    this.db
      .prepare(
        "INSERT INTO sources(id, name, base_url, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url"
      )
      .run(id, name, baseUrl, enabled ? 1 : 0);
  }
  listSources(): Array<{ id: string; name: string; base_url: string; enabled: number }> {
    return this.db.prepare("SELECT * FROM sources ORDER BY id").all() as never;
  }

  // ---- source exchangers ---------------------------------------------------------------------
  /** Insert or refresh the API-level facts. Page-level facts are untouched (see updateFromPage). */
  upsertExchangerFromApi(e: {
    source: string;
    ext_id: string;
    name: string;
    reserve_usd: number | null;
    directions: number | null;
    reviews_pos: number | null;
    reviews_neg: number | null;
  }): void {
    const t = nowSec();
    this.db
      .prepare(
        `INSERT INTO source_exchangers(source, ext_id, name, status, reserve_usd, directions, reviews_pos, reviews_neg, first_seen, last_seen)
         VALUES (@source, @ext_id, @name, 'active', @reserve_usd, @directions, @reviews_pos, @reviews_neg, @t, @t)
         ON CONFLICT(source, ext_id) DO UPDATE SET
           name = excluded.name, status = 'active', reserve_usd = excluded.reserve_usd,
           directions = excluded.directions, reviews_pos = excluded.reviews_pos,
           reviews_neg = excluded.reviews_neg, last_seen = excluded.last_seen`
      )
      .run({ ...e, t });
  }

  /** Mark exchangers missing from the latest API snapshot as gone (kept for history). */
  markGoneExcept(source: string, presentExtIds: Set<string>): number {
    const rows = this.db
      .prepare("SELECT ext_id FROM source_exchangers WHERE source = ? AND status = 'active'")
      .all(source) as Array<{ ext_id: string }>;
    const stmt = this.db.prepare("UPDATE source_exchangers SET status = 'gone' WHERE source = ? AND ext_id = ?");
    let n = 0;
    for (const r of rows) {
      if (!presentExtIds.has(r.ext_id)) {
        stmt.run(source, r.ext_id);
        n++;
      }
    }
    return n;
  }

  clearSlug(source: string, extId: string): void {
    this.db.prepare("UPDATE source_exchangers SET slug = NULL, url = NULL WHERE source = ? AND ext_id = ?").run(source, extId);
  }

  setSlug(source: string, extId: string, slug: string, url: string): void {
    this.db
      .prepare("UPDATE source_exchangers SET slug = ?, url = ? WHERE source = ? AND ext_id = ?")
      .run(slug, url, source, extId);
  }

  updateFromPage(
    source: string,
    extId: string,
    p: {
      domain?: string | null;
      country?: string | null;
      claims_open?: number | null;
      claims_closed?: number | null;
      reviews_total?: number | null;
      aml?: string | null;
      age_text?: string | null;
      on_source_text?: string | null;
      page_hash?: string | null;
      directions?: number | null;
      reserve_usd?: number | null;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE source_exchangers SET
           domain = COALESCE(@domain, domain), country = COALESCE(@country, country),
           claims_open = COALESCE(@claims_open, claims_open), claims_closed = COALESCE(@claims_closed, claims_closed),
           reviews_total = COALESCE(@reviews_total, reviews_total), aml = COALESCE(@aml, aml),
           age_text = COALESCE(@age_text, age_text), on_source_text = COALESCE(@on_source_text, on_source_text),
           page_hash = COALESCE(@page_hash, page_hash), page_fetched_at = @t
         WHERE source = @source AND ext_id = @extId`
      )
      .run({
        domain: null,
        country: null,
        claims_open: null,
        claims_closed: null,
        reviews_total: null,
        aml: null,
        age_text: null,
        on_source_text: null,
        page_hash: null,
        ...p,
        t: nowSec(),
        source,
        extId,
      });
  }

  /** Domain learned from a seed/list, not from a page fetch: must not count as "page fetched". */
  setDomainIfMissing(source: string, extId: string, domain: string): void {
    this.db.prepare("UPDATE source_exchangers SET domain = ? WHERE source = ? AND ext_id = ? AND domain IS NULL").run(domain, source, extId);
  }

  touchPageFetched(source: string, extId: string): void {
    this.db
      .prepare("UPDATE source_exchangers SET page_fetched_at = ? WHERE source = ? AND ext_id = ?")
      .run(nowSec(), source, extId);
  }

  getExchanger(source: string, extId: string): SourceExchanger | undefined {
    return this.db
      .prepare("SELECT * FROM source_exchangers WHERE source = ? AND ext_id = ?")
      .get(source, extId) as SourceExchanger | undefined;
  }

  listExchangers(source: string, opts: { status?: "active" | "gone" } = {}): SourceExchanger[] {
    return (opts.status
      ? this.db.prepare("SELECT * FROM source_exchangers WHERE source = ? AND status = ? ORDER BY name").all(source, opts.status)
      : this.db.prepare("SELECT * FROM source_exchangers WHERE source = ? ORDER BY name").all(source)) as SourceExchanger[];
  }

  /** Exchangers whose page should be fetched next: stalest first, linked ones only unless `all`. */
  crawlCandidates(source: string, olderThanSec: number, all: boolean, limit: number): SourceExchanger[] {
    const cutoff = nowSec() - olderThanSec;
    const sql = `
      SELECT e.* FROM source_exchangers e
      ${all ? "" : "JOIN exchanger_links l ON l.source = e.source AND l.ext_id = e.ext_id"}
      WHERE e.source = ? AND e.status = 'active' AND e.slug IS NOT NULL
        AND (e.page_fetched_at IS NULL OR e.page_fetched_at < ?)
      ORDER BY (e.page_fetched_at IS NOT NULL), e.page_fetched_at ASC
      LIMIT ?`;
    return this.db.prepare(sql).all(source, cutoff, limit) as SourceExchanger[];
  }

  recordDaily(source: string, extId: string, day: string, v: { reviews_pos: number | null; reviews_neg: number | null; directions: number | null; reserve_usd: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO exchanger_daily(source, ext_id, day, reviews_pos, reviews_neg, directions, reserve_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, ext_id, day) DO UPDATE SET reviews_pos = excluded.reviews_pos, reviews_neg = excluded.reviews_neg,
           directions = excluded.directions, reserve_usd = excluded.reserve_usd`
      )
      .run(source, extId, day, v.reviews_pos, v.reviews_neg, v.directions, v.reserve_usd);
  }

  dailyHistory(source: string, extId: string, days: number): Array<{ day: string; reviews_pos: number | null; reviews_neg: number | null; directions: number | null; reserve_usd: number | null }> {
    return this.db
      .prepare(
        `SELECT day, reviews_pos, reviews_neg, directions, reserve_usd FROM exchanger_daily
         WHERE source = ? AND ext_id = ? ORDER BY day DESC LIMIT ?`
      )
      .all(source, extId, days) as never;
  }

  // ---- links ---------------------------------------------------------------------------------
  getLink(source: string, extId: string): Link | undefined {
    return this.db.prepare("SELECT * FROM exchanger_links WHERE source = ? AND ext_id = ?").get(source, extId) as Link | undefined;
  }
  linksForOur(ourId: string): Link[] {
    return this.db.prepare("SELECT * FROM exchanger_links WHERE our_exchanger_id = ?").all(ourId) as Link[];
  }
  listLinks(source?: string): Link[] {
    return (source
      ? this.db.prepare("SELECT * FROM exchanger_links WHERE source = ? ORDER BY our_name").all(source)
      : this.db.prepare("SELECT * FROM exchanger_links ORDER BY source, our_name").all()) as Link[];
  }
  upsertLink(l: { source: string; ext_id: string; our_exchanger_id: string; our_name: string | null; method: Link["method"]; confidence: number; locked?: boolean }): void {
    const t = nowSec();
    this.db
      .prepare(
        `INSERT INTO exchanger_links(source, ext_id, our_exchanger_id, our_name, method, confidence, locked, created_at, updated_at)
         VALUES (@source, @ext_id, @our_exchanger_id, @our_name, @method, @confidence, @locked, @t, @t)
         ON CONFLICT(source, ext_id) DO UPDATE SET our_exchanger_id = excluded.our_exchanger_id, our_name = excluded.our_name,
           method = excluded.method, confidence = excluded.confidence, locked = excluded.locked, updated_at = excluded.updated_at`
      )
      .run({ ...l, locked: l.locked ? 1 : 0, t });
  }
  deleteLink(source: string, extId: string): void {
    this.db.prepare("DELETE FROM exchanger_links WHERE source = ? AND ext_id = ?").run(source, extId);
  }

  // ---- reviews -------------------------------------------------------------------------------
  isTakenDown(source: string, extId: string, extReviewId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM takedowns WHERE source = ? AND (ext_review_id = ? OR ext_id = ?) LIMIT 1")
      .get(source, extReviewId, extId);
    return !!row;
  }

  upsertReview(r: NewReview): UpsertReviewResult {
    if (this.isTakenDown(r.source, r.ext_id, r.ext_review_id)) return "takedown";
    const t = nowSec();
    const existing = this.db
      .prepare("SELECT * FROM external_reviews WHERE source = ? AND ext_review_id = ?")
      .get(r.source, r.ext_review_id) as ExternalReview | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO external_reviews(source, ext_id, ext_review_id, author, country, rating, text, text_hash, posted_at, source_url,
             reply_author, reply_text, reply_at, status, reject_reason, first_seen, last_seen, updated_at)
           VALUES (@source, @ext_id, @ext_review_id, @author, @country, @rating, @text, @text_hash, @posted_at, @source_url,
             @reply_author, @reply_text, @reply_at, @status, @reject_reason, @t, @t, @t)`
        )
        .run({ ...r, t });
      return "inserted";
    }
    // A human decision (hidden) always wins over the automatic verdict.
    const status: ReviewStatus = existing.status === "hidden" ? "hidden" : r.status;
    const changed =
      existing.text_hash !== r.text_hash ||
      existing.rating !== r.rating ||
      existing.reply_text !== r.reply_text ||
      existing.status !== status;
    this.db
      .prepare(
        `UPDATE external_reviews SET author = @author, country = @country, rating = @rating, text = @text, text_hash = @text_hash,
           reply_author = @reply_author, reply_text = @reply_text, reply_at = @reply_at, status = @status,
           reject_reason = @reject_reason, last_seen = @t, updated_at = CASE WHEN @changed THEN @t ELSE updated_at END
         WHERE id = @id`
      )
      .run({ ...r, status, changed: changed ? 1 : 0, t, id: existing.id });
    return changed ? "updated" : "unchanged";
  }

  /** Other reviews of the same exchanger with identical text (copy-paste detection). */
  countSameText(source: string, extId: string, textHash: string, exceptExtReviewId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM external_reviews WHERE source = ? AND ext_id = ? AND text_hash = ? AND ext_review_id != ?")
      .get(source, extId, textHash, exceptExtReviewId) as { n: number };
    return row.n;
  }

  getReview(id: number): ExternalReview | undefined {
    return this.db.prepare("SELECT * FROM external_reviews WHERE id = ?").get(id) as ExternalReview | undefined;
  }

  setReviewStatus(id: number, status: ReviewStatus, reason?: string | null): boolean {
    const res = this.db
      .prepare("UPDATE external_reviews SET status = ?, reject_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, reason ?? null, nowSec(), id);
    return res.changes > 0;
  }

  /** Published reviews for the source exchangers linked to one of our exchangers. */
  publishedForOur(ourId: string, opts: { limit: number; offset: number; minPostedAt: number; rating?: "positive" | "neutral" | "negative" }): ExternalReview[] {
    const ratingSql =
      opts.rating === "positive" ? "AND r.rating >= 4" : opts.rating === "neutral" ? "AND r.rating = 3" : opts.rating === "negative" ? "AND r.rating <= 2" : "";
    return this.db
      .prepare(
        `SELECT r.* FROM external_reviews r
         JOIN exchanger_links l ON l.source = r.source AND l.ext_id = r.ext_id
         WHERE l.our_exchanger_id = ? AND r.status = 'published' AND r.posted_at >= ? ${ratingSql}
         ORDER BY r.posted_at DESC, r.id DESC LIMIT ? OFFSET ?`
      )
      .all(ourId, opts.minPostedAt, opts.limit, opts.offset) as ExternalReview[];
  }

  publishedForExchanger(source: string, extId: string, opts: { limit: number; offset: number; minPostedAt: number; rating?: "positive" | "neutral" | "negative" }): ExternalReview[] {
    const ratingSql =
      opts.rating === "positive" ? "AND rating >= 4" : opts.rating === "neutral" ? "AND rating = 3" : opts.rating === "negative" ? "AND rating <= 2" : "";
    return this.db
      .prepare(
        `SELECT * FROM external_reviews WHERE source = ? AND ext_id = ? AND status = 'published' AND posted_at >= ? ${ratingSql}
         ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(source, extId, opts.minPostedAt, opts.limit, opts.offset) as ExternalReview[];
  }

  countPublishedForExchanger(source: string, extId: string, minPostedAt: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM external_reviews WHERE source = ? AND ext_id = ? AND status = 'published' AND posted_at >= ?")
      .get(source, extId, minPostedAt) as { n: number };
    return row.n;
  }

  countPublishedForOur(ourId: string, minPostedAt: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM external_reviews r
         JOIN exchanger_links l ON l.source = r.source AND l.ext_id = r.ext_id
         WHERE l.our_exchanger_id = ? AND r.status = 'published' AND r.posted_at >= ?`
      )
      .get(ourId, minPostedAt) as { n: number };
    return row.n;
  }

  reviewStats(): Array<{ source: string; status: string; n: number }> {
    return this.db.prepare("SELECT source, status, COUNT(*) AS n FROM external_reviews GROUP BY source, status").all() as never;
  }

  listReviews(opts: { source?: string; extId?: string; status?: ReviewStatus; limit: number; offset: number }): ExternalReview[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.source) (where.push("source = ?"), args.push(opts.source));
    if (opts.extId) (where.push("ext_id = ?"), args.push(opts.extId));
    if (opts.status) (where.push("status = ?"), args.push(opts.status));
    const sql = `SELECT * FROM external_reviews ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, opts.limit, opts.offset) as ExternalReview[];
  }

  // ---- takedowns -----------------------------------------------------------------------------
  addTakedown(t: { source: string; ext_review_id?: string | null; ext_id?: string | null; reason?: string | null }): number {
    const res = this.db
      .prepare("INSERT INTO takedowns(source, ext_review_id, ext_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(t.source, t.ext_review_id ?? null, t.ext_id ?? null, t.reason ?? null, nowSec());
    // Remove what we already hold, so a takedown is immediate and permanent.
    if (t.ext_review_id) {
      this.db.prepare("DELETE FROM external_reviews WHERE source = ? AND ext_review_id = ?").run(t.source, t.ext_review_id);
    }
    if (t.ext_id) {
      this.db.prepare("DELETE FROM external_reviews WHERE source = ? AND ext_id = ?").run(t.source, t.ext_id);
    }
    return Number(res.lastInsertRowid);
  }
  listTakedowns(): Array<{ id: number; source: string; ext_review_id: string | null; ext_id: string | null; reason: string | null; created_at: number }> {
    return this.db.prepare("SELECT * FROM takedowns ORDER BY id DESC").all() as never;
  }

  // ---- jobs / fetch log ----------------------------------------------------------------------
  startRun(job: string): number {
    return Number(this.db.prepare("INSERT INTO job_runs(job, started_at) VALUES (?, ?)").run(job, nowSec()).lastInsertRowid);
  }
  finishRun(id: number, ok: boolean, stats: unknown, error?: string): void {
    this.db
      .prepare("UPDATE job_runs SET finished_at = ?, ok = ?, stats = ?, error = ? WHERE id = ?")
      .run(nowSec(), ok ? 1 : 0, JSON.stringify(stats ?? {}), error ?? null, id);
  }
  lastRuns(limit = 30): Array<{ id: number; job: string; started_at: number; finished_at: number | null; ok: number | null; stats: string | null; error: string | null }> {
    return this.db.prepare("SELECT * FROM job_runs ORDER BY id DESC LIMIT ?").all(limit) as never;
  }
  lastRunOf(job: string): { started_at: number; finished_at: number | null; ok: number | null; stats: string | null; error: string | null } | undefined {
    return this.db.prepare("SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1").get(job) as never;
  }
  lastSuccessOf(job: string): number | null {
    const row = this.db.prepare("SELECT finished_at FROM job_runs WHERE job = ? AND ok = 1 ORDER BY id DESC LIMIT 1").get(job) as { finished_at: number } | undefined;
    return row ? row.finished_at : null;
  }
  /** Runs left unfinished by a crash/restart are closed so status stays truthful. */
  closeStaleRuns(): number {
    return this.db
      .prepare("UPDATE job_runs SET finished_at = ?, ok = 0, error = 'interrupted by restart' WHERE finished_at IS NULL")
      .run(nowSec()).changes;
  }

  logFetch(f: { host: string; url: string; status: number | null; ms: number; bytes: number; note?: string }): void {
    this.db
      .prepare("INSERT INTO fetch_log(ts, host, url, status, ms, bytes, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(nowSec(), f.host, f.url, f.status, f.ms, f.bytes, f.note ?? null);
  }
  recentFetches(limit = 50): unknown[] {
    return this.db.prepare("SELECT * FROM fetch_log ORDER BY id DESC LIMIT ?").all(limit);
  }
  pruneLogs(keepDays = 14): void {
    const cutoff = nowSec() - keepDays * 86400;
    this.db.prepare("DELETE FROM fetch_log WHERE ts < ?").run(cutoff);
    this.db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(cutoff);
  }
}
