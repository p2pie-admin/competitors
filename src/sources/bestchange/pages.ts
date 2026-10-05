import * as cheerio from "cheerio";
import { cleanText, compactName, parseIntLoose, registrableDomain } from "../../core/normalize";

// HTML parsers for www.bestchange.ru. Markup verified 2026-10-04 (see test/fixtures).
// Everything here is pure: string in, structured data out, no I/O.

export type ListRow = {
  extId: string;
  name: string;
  slug: string | null;
  statusText: string;
  working: boolean;
  reserveUsd: number | null;
  directions: number | null;
  reviewsCount: number | null;
};

const slugFromHref = (href: string | undefined): string | null => {
  const m = /^\/?([a-z0-9][a-z0-9._-]*)-exchanger\.html$/i.exec((href || "").split("?")[0] || "");
  return m ? m[1]!.toLowerCase() : null;
};

/** https://www.bestchange.ru/list.html — one row per exchanger with id, slug, reserve, directions, reviews. */
export const parseListPage = (html: string): ListRow[] => {
  const $ = cheerio.load(html);
  const rows: ListRow[] = [];
  $("tr[onclick^='ccl(']").each((_, tr) => {
    const row = $(tr);
    const idMatch = /ccl\((\d+)\)/.exec(row.attr("onclick") || "");
    if (!idMatch) return;
    const name = cleanText(row.find("div.ca").first().text());
    if (!name) return;
    const slug = slugFromHref(row.find("td.rw a").first().attr("href"));
    const numbers = row
      .find("td.ar")
      .map((__, td) => cleanText($(td).text()))
      .get();
    const statusText = cleanText(row.find("td.bj.bp").first().text());
    rows.push({
      extId: idMatch[1]!,
      name,
      slug,
      statusText,
      working: /работает/i.test(statusText),
      reserveUsd: parseIntLoose(numbers[0]),
      directions: parseIntLoose(numbers[1]),
      reviewsCount: parseIntLoose(row.find("td.rw a").first().text()),
    });
  });
  return rows;
};

export type ParsedReply = { author: string; at: number | null; text: string };

export type ParsedReview = {
  extReviewId: string;
  kind: "review" | "claim" | "unknown";
  blockType: number;
  author: string | null;
  country: string | null;
  rating: number | null;
  postedAt: number | null;
  permalink: string | null;
  text: string;
  flagTexts: string[];
  reply: ParsedReply | null;
};

export type ParsedExchangerPage = {
  extId: string | null;
  title: string | null;
  domain: string | null;
  reviewsTotal: number | null;
  claimsOpen: number | null;
  claimsClosed: number | null;
  ageText: string | null;
  onSourceText: string | null;
  country: string | null;
  aml: string | null;
  directions: number | null;
  reserveUsd: number | null;
  currencies: number | null;
  reviews: ParsedReview[];
};

const htmlToText = ($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string => {
  const clone = el.clone();
  clone.find("br").replaceWith("\n");
  clone.find("script, style").remove();
  return cleanText(clone.text());
};

// The info table is label cells (td.bt) followed by value cells; some values sit behind an empty
// cell (flag icon), so take the first non-empty cell before the next label.
const labelValues = ($: cheerio.CheerioAPI): Map<string, string> => {
  const map = new Map<string, string>();
  $("td.bt").each((_, td) => {
    const label = cleanText($(td).text()).replace(/:$/, "");
    if (!label || map.has(label)) return;
    let value = "";
    for (let n = $(td).next("td"); n.length && !n.hasClass("bt"); n = n.next("td")) {
      value = cleanText(n.text());
      if (value) break;
    }
    if (value) map.set(label, value);
  });
  return map;
};

/** `Обменник Сова – отзывы, информация, статистика (sova.gg)` -> "sova.gg". */
export const domainFromTitle = (title: string | null): string | null => {
  const m = /\(([^()\s]+\.[^()\s]+)\)\s*$/.exec(title || "");
  return m ? registrableDomain(m[1]) : null;
};

export const parseExchangerPage = (html: string): ParsedExchangerPage => {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()).replace(/&ndash;/g, "–") || null;
  const labels = labelValues($);

  const idMatch = /info\.php\?it=(?:reviews|stats)&(?:amp;)?id=(\d+)/.exec(html);

  const reviews: ParsedReview[] = [];
  $("div[id^='review']").each((_, el) => {
    const node = $(el);
    const idm = /^review(\d+)$/.exec(node.attr("id") || "");
    const cls = /review_block_(\d+)/.exec(node.attr("class") || "");
    if (!idm || !cls) return;

    const header = node.find(".review_header").first();
    const typeIcon = Number(/review_type_(\d+)/.exec(header.find("span[class^='review_type_']").first().attr("class") || "")?.[1] || 0);
    const info = header.find("table.review_info tr").first();
    const author = cleanText(info.find("td.nospace").first().text()) || null;
    const country = info.find("img.flagicon").first().attr("title") || null;
    const stars = info.find(".userstar").length;
    const when = Number(info.find("span.localdate").first().attr("data-time"));
    const permalinkRaw = /https?:\/\/[^'"\s)]+\?review=\d+/.exec(header.find(".copy_icon").first().attr("onclick") || "");

    const body = node.find(".review_middle").first();
    const text = htmlToText($, body.find(".review_text").first());
    const flagTexts = body
      .find(".review_flag_text")
      .map((__, f) => cleanText($(f).text()))
      .get()
      .filter(Boolean);

    let reply: ParsedReply | null = null;
    const comment = body.find(".review_comment").first();
    if (comment.length) {
      const t = htmlToText($, comment.find(".comment_text").first());
      if (t) {
        const at = Number(comment.find("span.localdate").first().attr("data-time"));
        reply = {
          author: cleanText(comment.find(".comment_info td.nospace").first().text()) || "Администратор",
          at: Number.isFinite(at) && at > 0 ? at : null,
          text: t,
        };
      }
    }

    // Markup verified 2026-10-05 on a page with an open claim: an ordinary review is review_block_1 (stars optional),
    // an OPEN FINANCIAL CLAIM is review_block_2 (no stars, same icon), review_block_3 is a review the moderators
    // flagged (held back by moderation). Claims are counted but never republished.
    const block = Number(cls[1]);
    const kind: ParsedReview["kind"] = block === 2 ? "claim" : typeIcon === 1 && (block === 1 || block === 3) ? "review" : "unknown";

    reviews.push({
      extReviewId: idm[1]!,
      kind,
      blockType: Number(cls[1]),
      author,
      country,
      rating: stars > 0 ? Math.min(5, stars) : null,
      postedAt: Number.isFinite(when) && when > 0 ? when : null,
      permalink: permalinkRaw ? permalinkRaw[0] : null,
      text,
      flagTexts,
      reply,
    });
  });

  const amlEl = $(".amlclarity").first();
  return {
    extId: idMatch ? idMatch[1]! : null,
    title,
    domain: domainFromTitle(title),
    reviewsTotal: parseIntLoose($("#count_rw").first().text()),
    claimsOpen: parseIntLoose($("#count_claim").first().text()),
    claimsClosed: parseIntLoose($("#count_cancel").first().text()),
    ageText: labels.get("Возраст") ?? null,
    onSourceText: labels.get("На BestChange") ?? null,
    country: labels.get("Страна") ?? null,
    aml: amlEl.length ? (/aml(\d)/.exec(amlEl.attr("class") || "")?.[1] ?? null) : null,
    directions: parseIntLoose(labels.get("Курсов обмена")),
    reserveUsd: parseIntLoose(labels.get("Сумма резервов")),
    currencies: parseIntLoose(labels.get("Всего валют")),
    reviews,
  };
};

export { compactName };
