import { BlockedByRobotsError, HttpError } from "../http/errors";
import { addStats, emptyImportStats, importReviews, type ScrapedReview } from "./importReviews";
import { revalidateExchangerPages } from "./revalidate";
import { sha1 } from "./normalize";
import type { JobCtx } from "./types";
import type { SourceExchanger } from "../db/store";

export type PageSourceSpec = {
  source: string;
  /** Re-read a linked exchanger page after this many hours. */
  refreshHours: number;
  perTick: number;
  urlFor: (ex: SourceExchanger) => string;
  /** Pure parser. `recognised=false` means the layout is not what we expect: nothing is imported. */
  parse: (html: string, url: string) => { domain?: string | null; reviews: ScrapedReview[]; recognised: boolean };
  fallbackDecode?: "utf8" | "windows-1251";
  maxBytes?: number;
};

/**
 * One crawl tick shared by sources whose exchanger page is "fetch one URL, parse reviews":
 * the stalest linked exchangers first, robots-blocked pages skipped, 403/429 or an open circuit stops the tick,
 * broken pages are marked as attempted so they do not starve the queue.
 */
export const runPageTick = async (ctx: JobCtx, spec: PageSourceSpec): Promise<Record<string, unknown>> => {
  const { store, client, log } = ctx;
  const batch = store.crawlCandidates(spec.source, spec.refreshHours * 3600, false, spec.perTick);
  const total = emptyImportStats();
  const changed = new Set<string>();
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  for (const ex of batch) {
    const url = spec.urlFor(ex);
    try {
      const res = await client.get(url, { fallbackDecode: spec.fallbackDecode, maxBytes: spec.maxBytes ?? 4 * 1024 * 1024 });
      fetched++;
      const page = spec.parse(res.text ?? "", url);
      if (!page.recognised) throw new Error("page layout not recognised");
      store.updateFromPage(spec.source, ex.ext_id, { domain: page.domain ?? null, page_hash: sha1(page.reviews.map((r) => r.extReviewId + r.text).join("|")) });
      const s = importReviews(ctx, spec.source, ex, page.reviews, url);
      addStats(total, s);
      if (s.inserted + s.updated > 0) {
        const link = store.getLink(spec.source, ex.ext_id);
        if (link?.our_name) changed.add(link.our_name);
      }
    } catch (err) {
      if (err instanceof BlockedByRobotsError) {
        store.touchPageFetched(spec.source, ex.ext_id);
        skipped++;
        continue;
      }
      failed++;
      log.warn("page failed", { source: spec.source, url, err: err instanceof Error ? err.message : String(err) });
      store.touchPageFetched(spec.source, ex.ext_id);
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) break;
      if (err instanceof Error && err.name === "CircuitOpenError") break;
    }
  }
  const rv = changed.size ? await revalidateExchangerPages(ctx.config, [...changed], ctx.fetch) : { requested: 0, ok: true };
  return { candidates: batch.length, fetched, failed, skipped, ...total, revalidated: rv.requested, revalidateOk: rv.ok };
};
