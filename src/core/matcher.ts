import { compactName, registrableDomain } from "./normalize";
import type { OurExchanger } from "./ourExchangers";

export type TheirExchanger = { ext_id: string; name: string; domain: string | null };

export type MatchDecision = {
  ext_id: string;
  our_exchanger_id: string;
  our_name: string;
  method: "domain" | "name";
  confidence: number;
};

export type MatchConflict = { ext_id: string; reason: string; candidates: string[] };

export type MatchResult = { matches: MatchDecision[]; conflicts: MatchConflict[] };

const ourDomains = (e: OurExchanger): string[] =>
  [registrableDomain(e.ref_link), registrableDomain(e.rates_link)].filter((d): d is string => !!d);

const ourNames = (e: OurExchanger): string[] =>
  [compactName(e.name), e.display_name ? compactName(e.display_name) : ""].filter((n) => n.length >= 3);

/**
 * Pure matching of a source's exchangers with ours.
 *  1. Website domain equal (strongest; both known)                          -> confidence 0.98 (1.0 with equal name)
 *  2. Compact (transliterated) name equal and unique among ours             -> 0.8
 *  A name match is dropped when both sides know a domain and the domains differ: two different
 *  businesses can share a brand word, and showing one's reviews on the other would be wrong.
 */
export const computeMatches = (ours: OurExchanger[], theirs: TheirExchanger[]): MatchResult => {
  const byDomain = new Map<string, OurExchanger[]>();
  const byName = new Map<string, OurExchanger[]>();
  const domainsOf = new Map<string, string[]>();
  for (const e of ours) {
    const ds = ourDomains(e);
    domainsOf.set(e.id, ds);
    for (const d of new Set(ds)) byDomain.set(d, [...(byDomain.get(d) ?? []), e]);
    for (const n of new Set(ourNames(e))) byName.set(n, [...(byName.get(n) ?? []), e]);
  }

  const matches: MatchDecision[] = [];
  const conflicts: MatchConflict[] = [];

  for (const t of theirs) {
    const tName = compactName(t.name);
    const sameName = (e: OurExchanger) => tName.length >= 3 && ourNames(e).includes(tName);

    if (t.domain) {
      const cands = byDomain.get(t.domain) ?? [];
      if (cands.length === 1) {
        const e = cands[0]!;
        matches.push({ ext_id: t.ext_id, our_exchanger_id: e.id, our_name: e.name, method: "domain", confidence: sameName(e) ? 1 : 0.98 });
        continue;
      }
      if (cands.length > 1) {
        const named = cands.filter(sameName);
        if (named.length === 1) {
          const e = named[0]!;
          matches.push({ ext_id: t.ext_id, our_exchanger_id: e.id, our_name: e.name, method: "domain", confidence: 0.99 });
        } else {
          conflicts.push({ ext_id: t.ext_id, reason: "several of our exchangers share this domain", candidates: cands.map((c) => c.id) });
        }
        continue;
      }
    }

    const cands = byName.get(tName) ?? [];
    if (tName.length < 3 || cands.length === 0) continue;
    if (cands.length > 1) {
      conflicts.push({ ext_id: t.ext_id, reason: "name is ambiguous among our exchangers", candidates: cands.map((c) => c.id) });
      continue;
    }
    const e = cands[0]!;
    const known = domainsOf.get(e.id) ?? [];
    if (t.domain && known.length > 0 && !known.includes(t.domain)) {
      conflicts.push({ ext_id: t.ext_id, reason: `same name, different domain (${t.domain} vs ${known.join("/")})`, candidates: [e.id] });
      continue;
    }
    matches.push({ ext_id: t.ext_id, our_exchanger_id: e.id, our_name: e.name, method: "name", confidence: 0.8 });
  }
  return { matches, conflicts };
};
