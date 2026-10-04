import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { parseExchangerPage, parseListPage, domainFromTitle } from "../src/sources/bestchange/pages";

const fx = (n: string) => readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("list page: id, name, slug, status, reserve, directions, reviews", () => {
  const rows = parseListPage(fx("bestchange-list.html"));
  assert.equal(rows.length, 12);
  const sova = rows.find((r) => r.extId === "1006");
  assert.ok(sova);
  assert.equal(sova.name, "Сова");
  assert.equal(sova.slug, "sova");
  assert.equal(sova.working, true);
  assert.equal(sova.directions, 2336);
  assert.equal(sova.reserveUsd, 124335975);
  assert.equal(sova.reviewsCount, 88673);
  for (const r of rows) {
    assert.match(r.extId, /^\d+$/);
    assert.ok(r.name.length > 0);
    assert.ok(r.slug && !r.slug.includes("exchanger"));
  }
});

test("exchanger page: counters, id, domain from title", () => {
  const p = parseExchangerPage(fx("bestchange-exchanger-sova.html"));
  assert.equal(p.extId, "1006");
  assert.equal(p.domain, "sova.gg");
  assert.equal(p.reviewsTotal, 89463);
  assert.equal(p.claimsOpen, 0);
  assert.equal(p.claimsClosed, 650);
  assert.equal(p.directions, 2336);
  assert.equal(p.reserveUsd, 124335975);
  assert.equal(p.currencies, 53);
  assert.equal(p.country, "Сербия");
  assert.equal(p.aml, "2");
  assert.match(p.ageText ?? "", /6 лет/);
});

test("exchanger page: reviews with rating, date, permalink, reply; never the IP", () => {
  const p = parseExchangerPage(fx("bestchange-exchanger-sova.html"));
  assert.equal(p.reviews.length, 7, "6 ordinary + 1 flagged");
  const r = p.reviews.find((x) => x.extReviewId === "4054789");
  assert.ok(r);
  assert.equal(r.kind, "review");
  assert.equal(r.author, "Andrey");
  assert.equal(r.country, "Россия");
  assert.equal(r.rating, 5);
  assert.equal(r.postedAt, 1791134745);
  assert.equal(r.text, "Чёткая работа обменника.");
  assert.equal(r.permalink, "https://www.bestchange.ru/sova-exchanger.html?review=4054789");
  assert.ok(r.reply);
  assert.equal(r.reply.author, "Администратор Сова");
  assert.match(r.reply.text, /Благодарим Вас/);
  assert.ok(r.reply.text.includes("\n"), "<br> becomes a newline");
  assert.equal(JSON.stringify(p).match(/\d+\.\d+\.\d+\.\*/), null, "masked IPs are never extracted");
});

test("exchanger page: source-flagged review is surfaced with its flags (to be held back)", () => {
  const p = parseExchangerPage(fx("bestchange-exchanger-sova.html"));
  const flagged = p.reviews.find((x) => x.extReviewId === "4053541");
  assert.ok(flagged);
  assert.equal(flagged.blockType, 3);
  assert.equal(flagged.rating, null);
  assert.ok(flagged.flagTexts.length >= 1);
  assert.match(flagged.flagTexts.join(" "), /проверке|Персональные/);
});

test("domainFromTitle", () => {
  assert.equal(domainFromTitle("Обменник Сова – отзывы, информация, статистика (sova.gg)"), "sova.gg");
  assert.equal(domainFromTitle("Обменник X (www.pay.example.co.uk)"), "example.co.uk");
  assert.equal(domainFromTitle("No domain here"), null);
  assert.equal(domainFromTitle(null), null);
});

test("garbage html does not throw", () => {
  const p = parseExchangerPage("<html><body>nope</body></html>");
  assert.equal(p.extId, null);
  assert.equal(p.reviews.length, 0);
  assert.deepEqual(parseListPage("<html></html>"), []);
});
