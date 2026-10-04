import { computeMatches } from "./matcher";
import type { JobCtx } from "./types";

// Which of our exchangers take part in matching. Drafts are scraped placeholders that are not
// shown on the site, so linking them would only make us crawl pages nobody reads.
const MATCHABLE_STATUSES = new Set(["active", "paused", "suspended"]);

/**
 * Link a source's exchangers with ours (domain first, then name; see matcher.ts), keep human links,
 * drop automatic links that no longer hold, and save the conflicts for GET /admin/unmatched.
 */
export const runMatchJob = async (ctx: JobCtx, source: string, prepare?: () => void): Promise<Record<string, unknown>> => {
  const { store, ours, log } = ctx;
  prepare?.();
  const ourList = (await ours.list()).filter((e) => !e.status || MATCHABLE_STATUSES.has(e.status));
  const theirs = store.listExchangers(source, { status: "active" }).map((e) => ({ ext_id: e.ext_id, name: e.name, domain: e.domain }));

  const { matches, conflicts } = computeMatches(ourList, theirs);
  const wanted = new Map(matches.map((m) => [m.ext_id, m]));
  const ourById = new Map(ourList.map((e) => [e.id, e]));

  let created = 0;
  let updated = 0;
  let removed = 0;
  store.db.transaction(() => {
    for (const l of store.listLinks(source)) {
      if (l.locked) continue; // human decision
      if (!wanted.has(l.ext_id)) {
        store.deleteLink(source, l.ext_id);
        removed++;
      }
    }
    for (const m of matches) {
      const existing = store.getLink(source, m.ext_id);
      if (existing?.locked) continue;
      if (!existing) created++;
      else if (existing.our_exchanger_id !== m.our_exchanger_id || existing.method !== m.method || existing.confidence !== m.confidence) updated++;
      else continue;
      store.upsertLink({ source, ext_id: m.ext_id, our_exchanger_id: m.our_exchanger_id, our_name: ourById.get(m.our_exchanger_id)?.name ?? m.our_name, method: m.method, confidence: m.confidence });
    }
  })();

  store.kvSet(`${source}:match:conflicts`, JSON.stringify(conflicts.slice(0, 200)));
  for (const c of conflicts.slice(0, 20)) log.warn("match conflict", { source, ...c });
  return { ours: ourList.length, theirs: theirs.length, linked: matches.length, created, updated, removed, conflicts: conflicts.length };
};
