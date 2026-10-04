import * as cheerio from "cheerio";
import { cleanText, parseIntLoose, registrableDomain } from "../../core/normalize";
import type { ScrapedReview } from "../../core/importReviews";

// Parsers for kurs.expert (markup verified 2026-10-04, see test/fixtures). Pure functions.

export type KeListRow = {
  extId: string;
  slug: string;
  name: string;
  active: boolean;
  statusText: string;
  ageText: string | null;
  reserveUsd: number | null;
  positive: number | null;
  neutral: number | null;
  negative: number | null;
  /** Reputation 0..100 as computed by the source. */
  reputation: number | null;
  zone: string | null;
};

/** https://kurs.expert/ru/obmennik.html — every exchanger with id, slug, reserve and review counters. */
export const parseKeList = (html: string): KeListRow[] => {
  const $ = cheerio.load(html);
  const rows: KeListRow[] = [];
  $("tr.eLine").each((_, tr) => {
    const row = $(tr);
    const slug = /\/obmennik\/([^/]+)\//.exec(row.attr("elink") || "")?.[1];
    const extId = /\/click\/(\d+)\//.exec(row.attr("link") || "")?.[1];
    const name = cleanText(row.find("a.mainlink").first().text());
    if (!slug || !extId || !name) return;
    const statusText = cleanText(row.find("td.eStatus").first().text());
    // The age cell holds a hidden sortable number before the text.
    const age = row.find("td.eAge").first().clone();
    age.find("span.n").remove();
    rows.push({
      extId,
      slug,
      name,
      active: /активен/i.test(statusText),
      statusText,
      ageText: cleanText(age.text()) || null,
      reserveUsd: parseIntLoose(row.find("td.eSummaryReserve").first().text()),
      positive: parseIntLoose(row.find("span.positiveFeedbacks").first().text()),
      neutral: parseIntLoose(row.find("span.neutralFeedbacks").first().text()),
      negative: parseIntLoose(row.find("span.negativeFeedbacks").first().text()),
      reputation: parseIntLoose(row.find("td.eRep[rep]").first().attr("rep")),
      zone: row.attr("zone") || null,
    });
  });
  return rows;
};

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

/**
 * "29 сентября 2026, 01:08" -> unix seconds. The site shows Moscow time (UTC+3, no DST since 2014).
 */
export const parseKeDate = (text: string): number | null => {
  const m = /(\d{1,2})\s+([а-яё]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  const ms = Date.UTC(Number(m[3]), month - 1, Number(m[1]), Number(m[4]) - 3, Number(m[5]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** `swap-po.com отзывы, претензии, описание, ...` -> "swap-po.com" (only when the first token looks like a domain). */
export const domainFromKeTitle = (title: string | null): string | null => {
  const first = (title || "").trim().split(/\s+/)[0] || "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(first) ? registrableDomain(first) : null;
};

export type ParsedKePage = { title: string | null; domain: string | null; reviews: ScrapedReview[] };

const SENTIMENT: Record<string, ScrapedReview["sentiment"]> = {
  commPositive: "positive",
  commNeutral: "neutral",
  commNegative: "negative",
};

export const parseKeExchangerPage = (html: string, pageUrl: string): ParsedKePage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  const reviews: ScrapedReview[] = [];

  $("div.comment").each((_, el) => {
    const node = $(el);
    // Root reviews only: comments under a review (`to` = parent id, class "answer") are users talking to each other.
    if ((node.attr("to") || "0") !== "0") return;
    const cls = (node.attr("class") || "").split(/\s+/);
    const toneClass = cls.find((c) => c in SENTIMENT);
    const id = node.find("div.commTime").first().attr("date") || node.prev("a[name]").attr("name");
    if (!id || !/^\d+$/.test(id)) return;

    const authorEl = node.find("div.commAuthor").first();
    const author = cleanText(authorEl.attr("name") || authorEl.text()) || null;
    const time = node.find("div.commTime").first();
    const country = time.find("img").first().attr("title") || null;
    const body = node.find("div.commText").first().clone();
    body.find("img").remove();
    body.find("br").replaceWith("\n");

    reviews.push({
      extReviewId: id,
      kind: toneClass ? "review" : "unknown",
      author,
      country,
      rating: null, // the source has no stars: tone is the rating
      sentiment: toneClass ? SENTIMENT[toneClass]! : null,
      postedAt: parseKeDate(cleanText(time.clone().find("span.ipComment").remove().end().text())),
      permalink: `${pageUrl.split("#")[0]}#${id}`,
      text: cleanText(body.text()),
      flagTexts: [],
      reply: null,
    });
  });

  return { title, domain: domainFromKeTitle(title), reviews };
};
