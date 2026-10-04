import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMatches } from "../src/core/matcher";
import { compactName, hostOf, registrableDomain } from "../src/core/normalize";
import { normalize } from "../src/core/ourExchangers";

const ours = [
  { id: "1", name: "Sova", ref_link: "https://sova.gg/?ref=1", rates_link: "https://sova.gg/export.xml" },
  { id: "2", name: "Crypto-Box", display_name: "CryptoBox", ref_link: "https://cryptobox.pro", rates_link: "https://cryptobox.pro/export.xml" },
  { id: "3", name: "Obmen", ref_link: "https://obmen.example", rates_link: null },
  { id: "4", name: "Twin", ref_link: "https://twin-a.example", rates_link: null },
  { id: "5", name: "Twin", ref_link: "https://twin-b.example", rates_link: null },
];

test("domain match beats everything, Cyrillic name transliterates", () => {
  const { matches } = computeMatches(ours, [{ ext_id: "1006", name: "Сова", domain: "sova.gg" }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.our_exchanger_id, "1");
  assert.equal(matches[0]!.method, "domain");
  assert.ok(matches[0]!.confidence >= 0.98);
});

test("name-only match when the domain is unknown (0.8)", () => {
  const { matches } = computeMatches(ours, [{ ext_id: "9", name: "CryptoBox", domain: null }]);
  assert.equal(matches[0]!.our_exchanger_id, "2");
  assert.equal(matches[0]!.method, "name");
  assert.equal(matches[0]!.confidence, 0.8);
});

test("same name but a different known domain is a conflict, not a link", () => {
  const { matches, conflicts } = computeMatches(ours, [{ ext_id: "7", name: "Obmen", domain: "obmen-other.example" }]);
  assert.equal(matches.length, 0);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]!.reason, /different domain/);
});

test("ambiguous names are never guessed", () => {
  const { matches, conflicts } = computeMatches(ours, [{ ext_id: "8", name: "Twin", domain: null }]);
  assert.equal(matches.length, 0);
  assert.equal(conflicts[0]!.candidates.length, 2);
});

test("ambiguous name resolved by domain", () => {
  const { matches } = computeMatches(ours, [{ ext_id: "8", name: "Twin", domain: "twin-b.example" }]);
  assert.equal(matches[0]!.our_exchanger_id, "5");
});

test("too-short names do not match", () => {
  const { matches } = computeMatches([{ id: "9", name: "X" }], [{ ext_id: "1", name: "X", domain: null }]);
  assert.equal(matches.length, 0);
});

test("normalize helpers", () => {
  assert.equal(compactName("Crypto-Box"), "cryptobox");
  assert.equal(compactName("Шахта"), "shahta");
  assert.equal(hostOf("https://www.Sova.GG/path?x=1"), "sova.gg");
  assert.equal(hostOf("sova.gg"), "sova.gg");
  assert.equal(hostOf("not a url"), null);
  assert.equal(registrableDomain("pay.sova.gg"), "sova.gg");
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
});

test("our exchangers payload: object keyed by id or array", () => {
  const asObject = normalize({ "859": { id: "859", name: "Crypto-Box", ref_link: "https://cryptobox.pro" }, "1": { id: 1, name: "A", status: "active" }, bad: { name: 1 } });
  assert.deepEqual(asObject.map((e) => e.id).sort(), ["1", "859"]);
  assert.equal(normalize([{ id: "5", name: "Z" }]).length, 1);
  assert.deepEqual(normalize(null), []);
});
