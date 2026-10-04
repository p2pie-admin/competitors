import { unzipSync } from "fflate";

// Parsers for BestChange's public export "info.zip" (format v2.0x, ';'-separated, windows-1251):
//   bm_exch.dat   id;name;wmbl;?;reserve_usd
//   bm_cities.dat id;name
//   bm_cy.dat     id;group;name;code;?;?;direction-mask
//   bm_rates.dat  give;get;exchanger;rate_give;rate_get;reserve;negative.positive;1;min;max;city
// Verified 2026-10-04 against the site: reserve and direction count of "Сова" match its page.

const win1251 = new TextDecoder("windows-1251");

export type ApiExchanger = { id: string; name: string; reserveUsd: number | null };
export type ApiCity = { id: string; name: string };
export type ApiCurrency = { id: string; name: string; code: string };
export type ApiExchangerAgg = { directions: number; reviewsNeg: number | null; reviewsPos: number | null };

export const unpackInfoZip = (zip: Uint8Array): Record<string, Uint8Array> => {
  const files = unzipSync(zip);
  for (const need of ["bm_exch.dat", "bm_rates.dat"]) {
    if (!files[need]) throw new Error(`info.zip has no ${need}`);
  }
  return files;
};

const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.length > 0);

export const parseExchangers = (bytes: Uint8Array): ApiExchanger[] =>
  lines(win1251.decode(bytes)).flatMap((line) => {
    const f = line.split(";");
    const id = f[0]?.trim();
    const name = f[1]?.trim();
    if (!id || !name || !/^\d+$/.test(id)) return [];
    const reserve = Number(f[4]);
    return [{ id, name, reserveUsd: Number.isFinite(reserve) ? reserve : null }];
  });

export const parseCities = (bytes: Uint8Array): ApiCity[] =>
  lines(win1251.decode(bytes)).flatMap((line) => {
    const f = line.split(";");
    return f[0] && f[1] ? [{ id: f[0], name: f[1].trim() }] : [];
  });

export const parseCurrencies = (bytes: Uint8Array): ApiCurrency[] =>
  lines(win1251.decode(bytes)).flatMap((line) => {
    const f = line.split(";");
    return f[0] && f[2] && f[3] ? [{ id: f[0], name: f[2].trim(), code: f[3].trim() }] : [];
  });

/** "negative.positive" -> numbers. Anything else -> nulls. */
export const parseReviewsField = (s: string): { neg: number | null; pos: number | null } => {
  const m = /^(\d+)\.(\d+)$/.exec(s.trim());
  return m ? { neg: Number(m[1]), pos: Number(m[2]) } : { neg: null, pos: null };
};

/**
 * One pass over bm_rates.dat (~70 MB, ~1.1M rows): per exchanger count rows and keep its reviews
 * field. Works on raw bytes (the file is ASCII apart from nothing we read) to avoid building a
 * million-element array of strings.
 */
export const aggregateRates = (bytes: Uint8Array): Map<string, ApiExchangerAgg> => {
  const out = new Map<string, ApiExchangerAgg>();
  const ascii = new TextDecoder("latin1");
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    // find the end of this line
    let eol = bytes.indexOf(10, i);
    if (eol === -1) eol = n;
    // walk fields: need #2 (exchanger) and #6 (reviews)
    let field = 0;
    let start = i;
    let exch = "";
    let reviews = "";
    for (let p = i; p <= eol && field <= 6; p++) {
      if (p === eol || bytes[p] === 59 /* ; */) {
        if (field === 2) exch = ascii.decode(bytes.subarray(start, p));
        else if (field === 6) reviews = ascii.decode(bytes.subarray(start, p));
        field++;
        start = p + 1;
      }
    }
    if (exch && /^\d+$/.test(exch)) {
      let agg = out.get(exch);
      if (!agg) {
        const r = parseReviewsField(reviews);
        agg = { directions: 0, reviewsNeg: r.neg, reviewsPos: r.pos };
        out.set(exch, agg);
      }
      agg.directions++;
    }
    i = eol + 1;
  }
  return out;
};
