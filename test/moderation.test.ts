import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReview, ratingToType, sanitizeReviewText } from "../src/core/moderation";

const base = { rating: 5, flaggedBySource: false, minChars: 15, duplicatesOfText: 0 };
const v = (text: string, o: Partial<Parameters<typeof evaluateReview>[0]> = {}) => evaluateReview({ text, ...base, ...o });

test("a normal review passes, positive or negative alike", () => {
  assert.equal(v("Обмен прошёл быстро, деньги пришли за 10 минут, всё чётко.").status, "published");
  assert.equal(v("Деньги пришли только через два часа, поддержка отвечала долго.", { rating: 1 }).status, "published");
});

test("sentiment is never a reason to hide", () => {
  assert.equal(v("Очень плохо: заявку держали сутки и курс поменяли после оплаты", { rating: 1 }).status, "published");
});

test("short, wordless and out-of-range ratings are rejected", () => {
  assert.equal(v("ок").reason, "too-short");
  assert.equal(v("1234567890 1234567890 12").reason, "not-text");
  assert.equal(v("Нормальный отзыв про обмен", { rating: 9 }).reason, "bad-rating");
  assert.equal(v("Нормальный отзыв про обмен", { rating: null }).status, "published", "unrated reviews are allowed");
});

test("contacts, links and payment data are rejected", () => {
  assert.equal(v("Лучший обменник, заходите на sova.gg там курс лучше").reason, "contains-link");
  assert.equal(v("пишите мне на ivan@mail.ru по обмену").reason, "contains-email");
  assert.equal(v("Пишите в телеграм @super_obmen скидка").reason, "contains-contact");
  assert.equal(v("Мой номер для связи +7 999 123 45 67 звоните").reason, "contains-phone");
  assert.equal(v("Отправлял на кошелёк TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE быстро дошло").reason, "contains-address");
  assert.equal(v("Перевёл на карту 2202 2001 2345 6789 сразу пришло").reason, "contains-card-number");
});

test("profanity is rejected", () => {
  assert.equal(v("Это полный пиздец, а не обменник, не пользуйтесь").reason, "profanity");
});

test("source flags hold the review back (pending), not publish", () => {
  const r = v("Заявка в телеграмме после обещанных 30-150 минут деньги не пришли", { flaggedBySource: true, sourceFlagText: "На проверке у администрации" });
  assert.equal(r.status, "pending");
  assert.match(r.reason ?? "", /source-flag/);
});

test("copy-paste duplicates are rejected after two repeats", () => {
  assert.equal(v("Все отлично, рекомендую этот обменник всем", { duplicatesOfText: 1 }).status, "published");
  assert.equal(v("Все отлично, рекомендую этот обменник всем", { duplicatesOfText: 2 }).reason, "duplicate-text");
});

test("rating scale", () => {
  assert.equal(ratingToType(5), "positive");
  assert.equal(ratingToType(4), "positive");
  assert.equal(ratingToType(3), "neutral");
  assert.equal(ratingToType(2), "negative");
  assert.equal(ratingToType(null), null);
});

test("sanitize collapses whitespace and strips control chars", () => {
  assert.equal(sanitizeReviewText("  a ​ b  c \n\n\n\n d "), "a b c\n\nd");
});
