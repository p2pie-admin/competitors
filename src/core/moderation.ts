import { cleanText } from "./normalize";

export type Verdict = { status: "published" | "pending" | "rejected"; reason: string | null };

export type ModerationInput = {
  text: string;
  rating: number | null;
  /** Source moderators marked the review ("under check", "personal data removed", ...). */
  flaggedBySource: boolean;
  /** Source-side reason text, when flagged. */
  sourceFlagText?: string | null;
  minChars: number;
  /** How many other reviews of the same exchanger already carry exactly this text. */
  duplicatesOfText: number;
};

// What we refuse to republish. Deliberately NOT based on sentiment: negative reviews pass,
// otherwise the block would be cherry-picked advertising and mislead users.
const URL_RE = /(?:https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ru|cc|pro|biz|info|me|su|ua|kz|by|exchange|money|gg|app|xyz|top|online|site|link)\b)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const HANDLE_RE = /(?:^|[\s(])@[a-z0-9_]{4,}/i;
const TG_RE = /\b(?:t\.me|telegram|телеграм\w*|тг|whatsapp|ватсап\w*|viber|вайбер)\b[^\n]{0,20}[:@/+]/i;
const PHONE_RE = /(?:\+?\d[\s\-().]*){10,}/;
// Crypto addresses and long hex/base58 tokens: transaction ids, wallets, card numbers.
const ADDRESS_RE = /\b(?:0x[a-f0-9]{16,}|T[1-9A-HJ-NP-Za-km-z]{33}|(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}|[a-f0-9]{32,})\b/;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;
// Stems of Russian profanity; a match anywhere rejects (we do not publish censored-by-hand text).
const PROFANITY_RE = /(?:^|[^а-яё])(?:[а-яё]*(?:хуй|хуе|хуё|хуя|пизд|пзд|ебан|ебат|ёбан|еблан|ебуч|ебал|заеб|разъеб|наеб|уеб|уёб|сука|суки|сучар|блять|бляд|блядь|мудак|мудил|гандон|пидор|пидар|залуп|шлюх)[а-яё]*)/i;

// Random letter soup ("ODHbHOdrbslGPXIiidIz") and pasted code are test spam, not reviews.
const looksLikeGibberish = (text: string): boolean => {
  const t = text.trim();
  if (/\s/.test(t) && t.split(/\s+/).length > 2) return false;
  const latin = t.replace(/[^A-Za-z]/g, "");
  if (latin.length >= 10 && latin.length / Math.max(1, t.length) > 0.8) {
    const caseFlips = (latin.match(/[a-z][A-Z]/g) || []).length;
    if (caseFlips >= 3) return true;
    if (!/[aeiouyAEIOUY]/.test(latin)) return true;
  }
  return false;
};
const looksLikeCode = (text: string): boolean => (text.match(/[{};=<>]|=>|\)\s*\{/g) || []).length >= 4;

export const sanitizeReviewText = (raw: string): string => cleanText(raw).slice(0, 4000);

/** Replies of exchangers are copied too: drop the whole reply when it carries a link, e-mail, handle or phone. */
export const replyIsClean = (text: string): boolean =>
  !EMAIL_RE.test(text) && !URL_RE.test(text) && !HANDLE_RE.test(text) && !TG_RE.test(text) && !PHONE_RE.test(text) && !ADDRESS_RE.test(text);

export const evaluateReview = (i: ModerationInput): Verdict => {
  const text = i.text;
  if (i.flaggedBySource) return { status: "pending", reason: `source-flag:${(i.sourceFlagText || "flagged").slice(0, 80)}` };
  // Authors may skip the stars: such reviews are shown without a rating, never as "positive".
  if (i.rating != null && (i.rating < 1 || i.rating > 5)) return { status: "rejected", reason: "bad-rating" };
  if (text.replace(/\s/g, "").length < i.minChars) return { status: "rejected", reason: "too-short" };
  const letters = (text.match(/[a-zа-яё]/gi) || []).length;
  if (letters / Math.max(1, text.length) < 0.4) return { status: "rejected", reason: "not-text" };
  if (text.split(/\s+/).some((w) => w.length >= 40)) return { status: "rejected", reason: "not-text" }; // invoices, hashes, pasted blobs
  if (looksLikeGibberish(text)) return { status: "rejected", reason: "gibberish" };
  if (looksLikeCode(text)) return { status: "rejected", reason: "not-text" };
  if (EMAIL_RE.test(text)) return { status: "rejected", reason: "contains-email" };
  if (URL_RE.test(text)) return { status: "rejected", reason: "contains-link" };
  if (HANDLE_RE.test(text) || TG_RE.test(text)) return { status: "rejected", reason: "contains-contact" };
  if (ADDRESS_RE.test(text)) return { status: "rejected", reason: "contains-address" };
  if (CARD_RE.test(text)) return { status: "rejected", reason: "contains-card-number" };
  if (PHONE_RE.test(text)) return { status: "rejected", reason: "contains-phone" };
  if (PROFANITY_RE.test(text.toLowerCase())) return { status: "rejected", reason: "profanity" };
  if (i.duplicatesOfText >= 2) return { status: "rejected", reason: "duplicate-text" };
  return { status: "published", reason: null };
};

/** 4–5 stars positive, 3 neutral, 1–2 negative (same scale as our own review types). */
export const ratingToType = (rating: number | null): "positive" | "neutral" | "negative" | null =>
  rating == null ? null : rating >= 4 ? "positive" : rating === 3 ? "neutral" : "negative";
