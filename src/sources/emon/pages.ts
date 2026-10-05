import * as cheerio from "cheerio";
import { cleanText, parseIntLoose, registrableDomain } from "../../core/normalize";
import type { ScrapedReview } from "../../core/importReviews";

// Parsers for e-mon.cc (markup verified 2026-10-05, see test/fixtures). Pure functions.
// robots.txt only closes /manager and /favorite/; the exchanger page shows up to 200 newest reviews.

export type EmListRow = {
  extId: string;
  name: string;
  domain: string | null;
  active: boolean;
  statusText: string;
  ageText: string | null;
  country: string | null;
  reserveUsd: number | null;
  rates: number | null;
  positive: number | null;
  negative: number | null;
};

/** https://e-mon.cc/exchangers — all exchangers: id, name, website, status, reserve, counters. */
export const parseEmList = (html: string): EmListRow[] => {
  const $ = cheerio.load(html);
  const rows: EmListRow[] = [];
  $("tr").each((_, tr) => {
    const row = $(tr);
    const extId = /\/exchanger\/(\d+)/.exec(row.find("td[data-url]").first().attr("data-url") || "")?.[1];
    const name = cleanText(row.find("span.exchanger-name").first().text());
    if (!extId || !name) return;
    const info = row.find(".exchanger-info-data");
    const value = (label: string) => {
      let out: string | null = null;
      info.find(".exchanger-info-data-item").each((__, it) => {
        if (cleanText($(it).find(".exchanger-info-data-item-left").text()) === label) out = cleanText($(it).find(".exchanger-info-data-item-right").text()) || null;
      });
      return out;
    };
    const statusText = cleanText(row.find("span.exchanger-status").first().text());
    const cells = row.children("td").map((__, td) => cleanText($(td).text())).get();
    rows.push({
      extId,
      name,
      domain: registrableDomain(info.find("a[target='_blank']").first().attr("href")),
      active: row.find("span.exchanger-status-active").length > 0,
      statusText,
      ageText: value("Возраст"),
      country: value("Страна"),
      reserveUsd: parseIntLoose(value("Резервы")),
      rates: parseIntLoose(cells[4]),
      positive: parseIntLoose(row.find("span.reviews-counter-good").first().text()),
      negative: parseIntLoose(row.find("span.reviews-counter-bad").first().text()),
    });
  });
  return rows;
};

/** "2020-09-25 00:16:21" (Moscow time, as on the rest of the site) -> unix seconds. */
export const parseEmDate = (text: string): number | null => {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 3, Number(m[5]), Number(m[6] || 0));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

// Review types offered by the site's form: bad / good / very-good / excellent; "comment" is a follow-up, not a review.
const SENTIMENT: Record<string, ScrapedReview["sentiment"]> = { bad: "negative", good: "positive", "very-good": "positive", excellent: "positive" };

export type ParsedEmPage = { title: string | null; positive: number | null; negative: number | null; reviews: ScrapedReview[] };

export const parseEmExchangerPage = (html: string, pageUrl: string): ParsedEmPage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  const reviews: ScrapedReview[] = [];
  $("div.review").each((_, el) => {
    const node = $(el);
    const type = /\btype-([a-z-]+)/.exec(node.attr("class") || "")?.[1];
    if (!type) return;
    // The review id lives only in the reply form (`form-add-comment<id>`) and its hidden field.
    const id = node.find("input[name='Comment[review_id]']").first().attr("value") || /form-add-comment(\d+)/.exec(node.html() || "")?.[1];
    if (!id || !/^\d+$/.test(id)) return;
    const nameEl = node.find(".review-item-name").first().clone();
    nameEl.find(".review-item-date").remove();
    nameEl.find("i").remove();
    const body = node.find(".review-item-content").first().clone();
    body.find(".comments").remove();
    body.find("br").replaceWith("\n");
    // Trailing "Номер заявки обмена: N" is form noise, not part of the text.
    const text = cleanText(body.text()).replace(/\n?Номер заявки обмена:\s*\d*\s*$/i, "").trim();
    reviews.push({
      extReviewId: id,
      kind: type in SENTIMENT ? "review" : "unknown",
      author: cleanText(nameEl.text()) || null,
      country: null,
      rating: null,
      sentiment: SENTIMENT[type] ?? null,
      postedAt: parseEmDate(cleanText(node.find(".review-item-date").first().text())),
      permalink: `${pageUrl.split("#")[0]}#review-${id}`,
      text,
      flagTexts: [],
      reply: null,
    });
  });
  return {
    title,
    positive: parseIntLoose($("span.reviews-counter-good").first().text()),
    negative: parseIntLoose($("span.reviews-counter-bad").first().text()),
    reviews,
  };
};
