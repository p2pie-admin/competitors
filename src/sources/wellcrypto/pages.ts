import * as cheerio from "cheerio";
import { cleanText, parseIntLoose, registrableDomain } from "../../core/normalize";
import type { ScrapedReview } from "../../core/importReviews";

// Parsers for wellcrypto.io (markup verified 2026-10-05, see test/fixtures). Pure functions.
// robots.txt is open; the exchanger page server-renders the 25 newest reviews.

export type WcListRow = {
  slug: string;
  name: string;
  available: boolean;
  statusText: string;
  ageText: string | null;
  country: string | null;
  reserveUsd: number | null;
  rates: number | null;
  /** The site shows one signed counter ("+24"): positive when >= 0. */
  feedback: number | null;
};

/** https://wellcrypto.io/ru/exchangers/ — all exchangers with slug, status, age, reserve, feedback counter. */
export const parseWcList = (html: string): WcListRow[] => {
  const $ = cheerio.load(html);
  const rows: WcListRow[] = [];
  $("tr.table__exchange").each((_, tr) => {
    const row = $(tr);
    const slug = /\/exchangers\/([^/]+)\//.exec(row.attr("data-href") || "")?.[1];
    const name = cleanText(row.find(".exchange-details__name").first().text()) || cleanText(row.find("a.exchange__title").first().text());
    if (!slug || !name) return;
    const age = row.find("td.exchange__age").first().clone();
    age.find("br").replaceWith(" ");
    const fb = cleanText(row.find("td.exchange__feedback span").first().text());
    rows.push({
      slug,
      name,
      available: (row.attr("class") || "").includes("status-available"),
      statusText: cleanText(row.find("td.exchange__status").first().text()),
      ageText: cleanText(age.text()) || null,
      country: cleanText(row.find(".country-value__name").first().text()) || null,
      reserveUsd: parseIntLoose(row.find("td.exchange__reserve").first().text()),
      rates: parseIntLoose(row.find("td.exchange__quotes").first().text()),
      feedback: fb ? (fb.startsWith("-") ? -(parseIntLoose(fb) ?? 0) : parseIntLoose(fb)) : null,
    });
  });
  return rows;
};

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

/** "04 сентября 2026" + "01:52" (Moscow time) -> unix seconds. */
export const parseWcDate = (date: string, time: string): number | null => {
  const m = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(date);
  const t = /(\d{1,2}):(\d{2})/.exec(time) || ["", "0", "0"];
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  const ms = Date.UTC(Number(m[3]), month - 1, Number(m[1]), Number(t[1]) - 3, Number(t[2]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const TONES = new Set(["positive", "neutral", "negative"]);

export type ParsedWcPage = { title: string | null; domain: string | null; reviews: ScrapedReview[] };

export const parseWcExchangerPage = (html: string, pageUrl: string): ParsedWcPage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  // "Перейти" button: the exchanger's own site (referral link); gives the domain for matching.
  let domain: string | null = null;
  $("a[href^='http']").each((_, a) => {
    if (domain) return;
    const text = cleanText($(a).text());
    const href = $(a).attr("href") || "";
    if (/^Перейти/i.test(text) && !/wellcrypto\.io/.test(href)) domain = registrableDomain(href);
  });

  const reviews: ScrapedReview[] = [];
  let n = 0;
  $("div.item-comment").each((_, el) => {
    const node = $(el);
    const cls = (node.attr("class") || "").split(/\s+/);
    const tone = cls.find((c) => TONES.has(c)) ?? null;
    const confirmed = cls.includes("_confirmed");
    const date = cleanText(node.find(".comment-age__date").first().text());
    const time = cleanText(node.find(".comment-age__time").first().text());
    const postedAt = parseWcDate(date, time);
    const author = cleanText(node.find(".comment-info__name").first().text()) || null;
    const text = cleanText(node.find(".item-comment__content").first().text());
    if (!text) return;
    n++;
    // The site exposes no review ids: derive a stable one from author + date + text.
    const extReviewId = stableId(`${author}|${postedAt}|${text}`);
    reviews.push({
      extReviewId,
      kind: "review",
      author,
      country: null,
      rating: null,
      // Unconfirmed reviews carry no tone on the site: kept unrated (never shown as positive/negative).
      sentiment: confirmed && tone ? (tone as ScrapedReview["sentiment"]) : tone ? (tone as ScrapedReview["sentiment"]) : null,
      postedAt,
      permalink: pageUrl.split("#")[0]!,
      text,
      flagTexts: [],
      reply: null,
    });
  });
  void n;
  return { title, domain, reviews };
};

// FNV-1a 52-bit, decimal: short, stable, collision-safe enough for a few thousand reviews per exchanger.
const stableId = (s: string): string => {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(s)) h = ((h ^ BigInt(ch)) * 0x100000001b3n) & 0xfffffffffffffn;
  return h.toString();
};
