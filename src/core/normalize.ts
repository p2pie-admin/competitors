// Name / domain / text helpers shared by the matcher, the parsers and moderation.
import { createHash } from "crypto";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sh", ъ: "",
  ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Lower-case, transliterated, alphanumerics only: "Крипта" / "Cripta" / "Cripta-24" compare sanely. */
export const compactName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? c)
    .replace(/[^a-z0-9]+/g, "");

// Second-level public suffixes that matter for exchanger domains.
const TWO_LEVEL = new Set(["co.uk", "com.ua", "com.ru", "org.ua", "net.ua", "com.tr", "com.br", "co.il", "com.cn", "co.jp", "com.au"]);

/** "https://www.Sova.gg/path" -> "sova.gg"; accepts bare hosts. Returns null for junk. */
export const hostOf = (input: string | null | undefined): string | null => {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    return h.includes(".") ? h : null;
  } catch {
    return null;
  }
};

/** Registrable domain: "pay.sova.gg" -> "sova.gg", "x.co.uk" stays "x.co.uk". */
export const registrableDomain = (hostOrUrl: string | null | undefined): string | null => {
  const h = hostOf(hostOrUrl);
  if (!h) return null;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LEVEL.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
};

/** Collapse whitespace, drop control chars, trim. */
export const cleanText = (s: string): string =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​‎‏﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const parseIntLoose = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
};

export const parseUsd = (s: string | null | undefined): number | null => parseIntLoose(s);

export const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

export const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);
