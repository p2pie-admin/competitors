import { computeMatches } from "../../core/matcher";
import { SOURCE_ID } from "./constants";
import type { JobCtx } from "../../core/types";
import { applySeed } from "./list";

// Which of our exchangers take part in matching. Drafts are scraped placeholders that are not
// shown on the site, so linking them would only make us crawl pages nobody reads.
const MATCHABLE_STATUSES = new Set(["active", "paused", "suspended"]);

export const runMatchJob = async (ctx: JobCtx): Promise<Record<string, unknown>> => {
  const { store, ours, log } = ctx;
  applySeed(ctx);
  const ourList = (await ours.list()).filter((e) => !e.status || MATCHABLE_STATUSES.has(e.status));
  const theirs = store.listExchangers(SOURCE_ID, { status: "active" }).map((e) => ({ ext_id: e.ext_id, name: e.name, domain: e.domain }));

  const { matches, conflicts } = computeMatches(ourList, theirs);
  const wanted = new Map(matches.map((m) => [m.ext_id, m]));
  const ourById = new Map(ourList.map((e) => [e.id, e]));

  let created = 0;
  let updated = 0;
  let removed = 0;
  store.db.transaction(() => {
    for (const l of store.listLinks(SOURCE_ID)) {
      if (l.locked) continue; // human decision
      const m = wanted.get(l.ext_id);
      if (!m) {
        // The link no longer holds (exchanger removed/renamed/conflict): drop it, reviews stop being shown.
        store.deleteLink(SOURCE_ID, l.ext_id);
        removed++;
      }
    }
    for (const m of matches) {
      const existing = store.getLink(SOURCE_ID, m.ext_id);
      if (existing?.locked) continue;
      if (!existing) created++;
      else if (existing.our_exchanger_id !== m.our_exchanger_id || existing.method !== m.method || existing.confidence !== m.confidence) updated++;
      else continue;
      store.upsertLink({ source: SOURCE_ID, ext_id: m.ext_id, our_exchanger_id: m.our_exchanger_id, our_name: ourById.get(m.our_exchanger_id)?.name ?? m.our_name, method: m.method, confidence: m.confidence });
    }
  })();

  // Persist what could not be decided so a human can resolve it (GET /admin/unmatched, PUT /admin/links).
  store.kvSet("bestchange:match:conflicts", JSON.stringify(conflicts.slice(0, 200)));
  for (const c of conflicts.slice(0, 20)) log.warn("match conflict", { ...c });
  return { ours: ourList.length, theirs: theirs.length, linked: matches.length, created, updated, removed, conflicts: conflicts.length };
};
