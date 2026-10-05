import * as cheerio from "cheerio";
import { cleanText, parseIntLoose, registrableDomain, sha1 } from "../../core/normalize";
import { ratingToType } from "../../core/moderation";
import type { ScrapedReview } from "../../core/importReviews";

// Parsers for obmify.com (Ukrainian monitoring; markup verified 2026-10-05, see test/fixtures). Pure functions.
// robots.txt closes only /api/ (where the review cards are loaded from), so we read the server-rendered
// JSON-LD `Organization` block of the exchanger page: the 10 newest reviews with stars, author and ISO date.

export type ObListRow = {
  slug: string;
  name: string;
  active: boolean;
  statusText: string;
  reviewsCount: number | null;
  rating: number | null;
  directions: number | null;
  label: string | null;
};

/** https://obmify.com/exchanges — table rows: slug (…-exchange), name, reviews count, rating, directions, status. */
export const parseObList = (html: string): ObListRow[] => {
  const $ = cheerio.load(html);
  const rows: ObListRow[] = [];
  $("div.Table__row").each((_, el) => {
    const row = $(el);
    const link = row.find("a.Table__exchange-info").first();
    const slug = /^\/(?:[a-z]{2}\/)?([a-z0-9-]+)-exchange$/.exec(link.attr("href") || "")?.[1];
    const name = cleanText(link.find(".Table__exchange-info-name").first().text()) || cleanText(link.text());
    if (!slug || !name) return;
    const statusText = cleanText(row.find(".Table__column--status .Status").first().text());
    rows.push({
      slug,
      name,
      active: /актив/i.test(statusText),
      statusText,
      reviewsCount: parseIntLoose(row.find(".Table__column--reviews-count").first().text()),
      rating: Number(cleanText(row.find(".Table__column--rating .Table__text").first().text()).replace(",", ".")) || null,
      directions: parseIntLoose(row.find(".Table__column--directions-count").first().text()),
      label: cleanText(row.find(".ExchangeLabel__text").first().text()) || null,
    });
  });
  return rows;
};

export type ParsedObPage = { title: string | null; domain: string | null; ratingValue: number | null; reviewCount: number | null; reviews: ScrapedReview[] };

type LdReview = { reviewRating?: { ratingValue?: unknown }; reviewBody?: unknown; author?: { name?: unknown }; sdDatePublished?: unknown; datePublished?: unknown };
type LdOrg = { "@type"?: unknown; url?: unknown; aggregateRating?: { ratingValue?: unknown; reviewCount?: unknown }; reviews?: LdReview[] };

export const parseObExchangerPage = (html: string, pageUrl: string): ParsedObPage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  let org: LdOrg | null = null;
  $("script[type='application/ld+json']").each((_, el) => {
    if (org) return;
    try {
      const d = JSON.parse($(el).text()) as LdOrg | LdOrg[];
      const list = Array.isArray(d) ? d : [d];
      org = list.find((x) => x && x["@type"] === "Organization" && Array.isArray(x.reviews)) ?? null;
    } catch {
      /* not JSON */
    }
  });
  const o = org as LdOrg | null;
  const reviews: ScrapedReview[] = [];
  for (const r of o?.reviews ?? []) {
    const text = cleanText(String(r.reviewBody ?? ""));
    const author = cleanText(String(r.author?.name ?? "")) || null;
    const ratingRaw = Number(r.reviewRating?.ratingValue);
    const rating = Number.isFinite(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? Math.round(ratingRaw) : null;
    const dateRaw = String(r.sdDatePublished ?? r.datePublished ?? "");
    const ms = Date.parse(dateRaw);
    if (!text || !Number.isFinite(ms)) continue;
    const postedAt = Math.floor(ms / 1000);
    reviews.push({
      // No review ids on the site: a stable hash of author + date + text.
      extReviewId: sha1(`${author}|${postedAt}|${text}`).slice(0, 16),
      kind: "review",
      author,
      country: null,
      rating,
      sentiment: ratingToType(rating),
      postedAt,
      permalink: pageUrl.split("#")[0]!,
      text,
      flagTexts: [],
      reply: null,
    });
  }
  const agg = o?.aggregateRating;
  return {
    title,
    domain: registrableDomain(typeof o?.url === "string" ? o.url : null),
    ratingValue: agg && Number.isFinite(Number(agg.ratingValue)) ? Number(agg.ratingValue) : null,
    reviewCount: agg && Number.isFinite(Number(agg.reviewCount)) ? Number(agg.reviewCount) : null,
    reviews,
  };
};
