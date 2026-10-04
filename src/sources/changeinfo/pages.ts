import * as cheerio from "cheerio";
import { cleanText, parseIntLoose, registrableDomain } from "../../core/normalize";
import type { ScrapedReview } from "../../core/importReviews";

// Parsers for changeinfo.ru (markup verified 2026-10-04, see test/fixtures). Pure functions.
// robots.txt forbids URLs containing "positive"/"negative" (the per-tone sub-pages) but allows /review/<name>.

export type CiListRow = {
  /** The path segment of /review/<slug>: also our id for this source (the site has no numeric ids). */
  slug: string;
  name: string;
  domain: string | null;
  working: boolean;
  reserveUsd: number | null;
  rates: number | null;
  positive: number | null;
  negative: number | null;
};

/** https://changeinfo.ru/exchangers — every exchanger with its website, reserve and comment counters. */
export const parseCiList = (html: string): CiListRow[] => {
  const $ = cheerio.load(html);
  const rows: CiListRow[] = [];
  $("tbody tr").each((_, tr) => {
    const row = $(tr);
    const slug = /\/review\/([^/]+)\/(?:positive|negative)/.exec(row.find("a.positive, a.negative").first().attr("href") || "")?.[1];
    const nameLink = row.find("h4 a").first();
    const name = cleanText(nameLink.text());
    if (!slug || !name) return;
    rows.push({
      slug: decodeURIComponent(slug),
      name,
      domain: registrableDomain(nameLink.attr("href")),
      working: /работает/i.test(row.find("span.work").first().attr("title") || ""),
      reserveUsd: parseIntLoose(row.find("td[data-value]").first().text()),
      rates: parseIntLoose(row.find("div.sell-sum").first().text()),
      positive: parseIntLoose(row.find("a.positive").first().text()),
      negative: parseIntLoose(row.find("a.negative").first().text()),
    });
  });
  return rows;
};

const COUNTRIES: Record<string, string> = {
  ru: "Россия", ua: "Украина", by: "Беларусь", kz: "Казахстан", us: "США", de: "Германия", pl: "Польша", gb: "Великобритания",
  fr: "Франция", it: "Италия", es: "Испания", tr: "Турция", ge: "Грузия", am: "Армения", az: "Азербайджан", md: "Молдова",
  lv: "Латвия", lt: "Литва", ee: "Эстония", il: "Израиль", cz: "Чехия", nl: "Нидерланды", ae: "ОАЭ", cy: "Кипр",
};

/** "24 09 2025 03:31" (dd mm yyyy hh:mm, Moscow time as everywhere on the site) -> unix seconds. */
export const parseCiDate = (text: string): number | null => {
  const m = /(\d{1,2})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) - 3, Number(m[5]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const SENTIMENT: Record<string, ScrapedReview["sentiment"]> = { positive: "positive", neutral: "neutral", negative: "negative" };

export type ParsedCiPage = { title: string | null; reviews: ScrapedReview[] };

export const parseCiReviewPage = (html: string, pageUrl: string): ParsedCiPage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  const reviews: ScrapedReview[] = [];
  $("div.comment-block").each((_, el) => {
    const block = $(el);
    const body = block.find("div.comment-body").first();
    const tone = (body.attr("class") || "").split(/\s+/).find((c) => c in SENTIMENT);
    const id = block.find("[data-id]").first().attr("data-id") || block.find("div.nested-comments").first().attr("id");
    if (!id || !/^\d+$/.test(id)) return;
    const flag = /flag-icon-([a-z]{2})/.exec(body.find("span.flag-icon").first().attr("class") || "")?.[1];
    reviews.push({
      extReviewId: id,
      kind: tone ? "review" : "unknown",
      author: cleanText(block.find(".commentator-name").first().text()) || null,
      country: flag ? COUNTRIES[flag] ?? null : null,
      rating: null,
      sentiment: tone ? SENTIMENT[tone]! : null,
      postedAt: parseCiDate(cleanText(body.find(".comment-date").first().text())),
      permalink: `${pageUrl.split("#")[0]}#comment-${id}`,
      text: cleanText(body.find("p[itemprop='description']").first().text()),
      flagTexts: [],
      reply: null,
    });
  });
  return { title, reviews };
};
