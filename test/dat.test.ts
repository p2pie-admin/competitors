import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { aggregateRates, parseExchangers, parseReviewsField, unpackInfoZip, parseCities } from "../src/sources/bestchange/dat";

const cp1251 = (s: string): Uint8Array => {
  // minimal encoder for the Cyrillic range used in tests
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 128) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else throw new Error("unsupported char " + ch);
  }
  return Uint8Array.from(out);
};
const ascii = (s: string) => new TextEncoder().encode(s);

test("bm_exch: windows-1251 names, reserve", () => {
  const rows = parseExchangers(cp1251("1006;Сова;;0;124272375\n29;N-Change;;0;563507871\n\nbad;line\n51;ExchangeX;687408836403;1969;26303648\n"));
  assert.deepEqual(rows.map((r) => r.id), ["1006", "29", "51"]);
  assert.equal(rows[0]!.name, "Сова");
  assert.equal(rows[0]!.reserveUsd, 124272375);
});

test("bm_cities", () => {
  assert.deepEqual(parseCities(cp1251("1;Москва\n2;Санкт-Петербург\n")).map((c) => c.name), ["Москва", "Санкт-Петербург"]);
});

test("reviews field is negative.positive", () => {
  assert.deepEqual(parseReviewsField("5.1234"), { neg: 5, pos: 1234 });
  assert.deepEqual(parseReviewsField("0.88673"), { neg: 0, pos: 88673 });
  assert.deepEqual(parseReviewsField("n/a"), { neg: null, pos: null });
});

test("aggregateRates counts rows per exchanger and keeps reviews", () => {
  const rows = [
    "10;23;1;1.0075;1;292.42;0.122;1;200;294.32;0",
    "19;23;1;1;770.5;292.42;0.122;1;0.27;0.37;0",
    "24;23;1006;1.02;1;5;0.88673;1;10;20;0",
    "25;23;1006;1.02;1;5;0.88673;1;10;20;3",
    "26;23;1006;1.02;1;5;0.88673;1;10;20;3",
  ].join("\n");
  const agg = aggregateRates(ascii(rows)); // no trailing newline on purpose
  assert.equal(agg.get("1")!.directions, 2);
  assert.equal(agg.get("1")!.reviewsPos, 122);
  assert.equal(agg.get("1006")!.directions, 3);
  assert.equal(agg.get("1006")!.reviewsPos, 88673);
  assert.equal(agg.size, 2);
});

test("aggregateRates tolerates CRLF and junk lines", () => {
  const agg = aggregateRates(ascii("1;2;7;1;1;1;1.2;1;1;1;0\r\n\r\ngarbage\r\n1;2;7;1;1;1;1.2;1;1;1;0\r\n"));
  assert.equal(agg.get("7")!.directions, 2);
});

test("unpackInfoZip requires the files we rely on", () => {
  const zip = zipSync({ "bm_exch.dat": ascii("1;A;;0;1\n"), "bm_rates.dat": ascii("1;2;1;1;1;1;0.1;1;1;1;0\n") });
  const files = unpackInfoZip(zip);
  assert.ok(files["bm_exch.dat"]);
  assert.throws(() => unpackInfoZip(zipSync({ "bm_exch.dat": ascii("x") })), /bm_rates/);
});
