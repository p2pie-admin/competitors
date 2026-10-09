/**
 * Exchanger rating (stars) and trust level. Pure functions, no I/O: the job in ratingSync.ts feeds them.
 *
 * Two separate answers:
 *   - stars (1..5): what customers say. Smoothed share of positive reviews, so one 5-star review does not
 *     beat hundreds of reviews with a single complaint.
 *   - trust (0..100 + level): how much evidence stands behind the exchanger at all. "unknown" means
 *     "not enough data", never "bad"; "caution" needs a real negative signal.
 *
 * The public description of this method lives in the front (/rating). Change both together and bump METHOD_VERSION.
 */

export const METHOD_VERSION = 1;

export type TrustLevel = "unknown" | "caution" | "verified" | "reliable";
export type CheckVerdict = "green" | "yellow" | "red" | "block";

export type RatingSource = {
  source: string;
  name: string;
  positive: number | null;
  negative: number | null;
  /** Total as the source reports it; may exceed positive + negative (neutral reviews, or no split at all). */
  total: number | null;
  claimsOpen: number | null;
  ageMonths: number | null;
};

export type RatingInput = {
  sources: RatingSource[];
  /** Reviews left by p2pie users (approved only). */
  native: { positive: number; negative: number; neutral: number };
  /** Age known to our CMS (exchanger card), months. */
  cardAgeMonths: number | null;
  /** Status on p2pie: "active" = its rates are being parsed right now. */
  status: string | null;
  check: { verdict: CheckVerdict | null; score: number | null };
};

export type RatingFactor = { key: "reviews" | "age" | "monitorings" | "check" | "live" | "claims" | "negative"; points: number; max: number };

export type RatingDetails = {
  v: number;
  stars: number | null;
  score: number;
  level: TrustLevel;
  reviews: {
    positive: number;
    negative: number;
    total: number;
    sources: Array<{ source: string; name: string; positive: number | null; negative: number | null; total: number }>;
  };
  ageMonths: number | null;
  monitorings: number;
  claimsOpen: number;
  check: CheckVerdict | null;
  factors: RatingFactor[];
  /** Why the level is "caution" (empty otherwise). */
  flags: Array<"check_red" | "check_block" | "claims" | "negative_share">;
};

export type RatingResult = { stars: number | null; score: number; level: TrustLevel; reviewsCount: number; details: RatingDetails };

// Stars: prior of PRIOR_WEIGHT imaginary reviews with PRIOR_SHARE positive ones (= 4.4 stars for a newcomer).
const PRIOR_WEIGHT = 30;
const PRIOR_SHARE = 0.85;
// Monitorings remove a complaint once it is settled, so the negatives that remain are rare and heavy.
const NEGATIVE_WEIGHT = 10;
const CLAIM_WEIGHT = 10;

const FULL_REVIEWS = 1000; // reviews for the full "reviews" factor (log scale)
const FULL_AGE_MONTHS = 60;
const MAX = { reviews: 30, age: 25, monitorings: 20, check: 15, live: 10 } as const;
const LEVELS = { reliable: 70, verified: 45 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** "3 года и 8 месяцев", "1 год 8 мес", "12 лет", "9 месяцев" -> months. */
export const parseAgeMonths = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const y = /(\d+)\s*(?:лет|год)/i.exec(text);
  const m = /(\d+)\s*мес/i.exec(text);
  if (!y && !m) return null;
  return (y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0);
};

/** "01.04.2017" or "2017-04-01" -> months before `now`. */
export const monthsSince = (date: string | null | undefined, now: Date = new Date()): number | null => {
  if (!date) return null;
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date.trim());
  const d = ru ? new Date(Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]))) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const months = (now.getTime() - d.getTime()) / (30.44 * 86400_000);
  return months >= 0 && months < 12 * 60 ? Math.floor(months) : null;
};

export const computeRating = (input: RatingInput): RatingResult => {
  const sources = input.sources.map((s) => {
    const split = s.positive != null || s.negative != null;
    const positive = s.positive ?? 0;
    const negative = s.negative ?? 0;
    // Sources also count neutral reviews, or (Obmify) give only a total: the volume is the larger number.
    return { ...s, split, total: Math.max(positive + negative, s.total ?? 0, 0) };
  });

  const positive = sources.reduce((a, s) => a + (s.split ? s.positive ?? 0 : 0), 0) + input.native.positive;
  const negative = sources.reduce((a, s) => a + (s.split ? s.negative ?? 0 : 0), 0) + input.native.negative;
  const total = sources.reduce((a, s) => a + s.total, 0) + input.native.positive + input.native.negative + input.native.neutral;
  const claimsOpen = sources.reduce((a, s) => a + (s.claimsOpen ?? 0), 0);

  // --- stars ---
  const judged = positive + negative;
  const share =
    (positive + PRIOR_WEIGHT * PRIOR_SHARE) / (positive + NEGATIVE_WEIGHT * negative + CLAIM_WEIGHT * claimsOpen + PRIOR_WEIGHT);
  const stars = judged + claimsOpen > 0 ? Math.round((1 + 4 * share) * 100) / 100 : null;

  // --- trust ---
  const ages = [...sources.map((s) => s.ageMonths), input.cardAgeMonths].filter((m): m is number => m != null);
  const ageMonths = ages.length ? Math.max(...ages) : null;
  const others = sources.filter((s) => s.source !== "bestchange").length;
  const onBestChange = sources.some((s) => s.source === "bestchange");
  const negativeShare = judged > 0 ? negative / judged : 0;
  const { verdict } = input.check;

  const factors: RatingFactor[] = [
    { key: "reviews", max: MAX.reviews, points: MAX.reviews * Math.min(1, Math.log10(1 + total) / Math.log10(1 + FULL_REVIEWS)) },
    { key: "age", max: MAX.age, points: MAX.age * Math.min(1, (ageMonths ?? 0) / FULL_AGE_MONTHS) },
    { key: "monitorings", max: MAX.monitorings, points: (onBestChange ? 10 : 0) + Math.min(10, others * 5) },
    { key: "check", max: MAX.check, points: verdict === "green" ? 15 : verdict === "yellow" ? 5 : verdict === "red" || verdict === "block" ? -25 : 0 },
    { key: "live", max: MAX.live, points: input.status === "active" ? MAX.live : 0 },
    { key: "claims", max: 0, points: -Math.min(15, claimsOpen * 5) },
    { key: "negative", max: 0, points: judged >= 10 && negativeShare > 0.1 ? -20 : judged >= 10 && negativeShare > 0.02 ? -10 : 0 },
  ].map((f) => ({ ...f, points: round1(f.points) })) as RatingFactor[];

  let score = Math.round(clamp(factors.reduce((a, f) => a + f.points, 0), 0, 100));
  if (verdict === "block") score = Math.min(score, 20);

  const flags: RatingDetails["flags"] = [];
  if (verdict === "block") flags.push("check_block");
  if (verdict === "red") flags.push("check_red");
  if (claimsOpen >= 3) flags.push("claims");
  if (judged >= 10 && negativeShare > 0.1) flags.push("negative_share");

  const level: TrustLevel = flags.length ? "caution" : score >= LEVELS.reliable ? "reliable" : score >= LEVELS.verified ? "verified" : "unknown";

  const details: RatingDetails = {
    v: METHOD_VERSION,
    stars,
    score,
    level,
    reviews: {
      positive,
      negative,
      total,
      sources: [
        ...sources.filter((s) => s.total > 0).map((s) => ({ source: s.source, name: s.name, positive: s.split ? s.positive ?? 0 : null, negative: s.split ? s.negative ?? 0 : null, total: s.total })),
        ...(input.native.positive + input.native.negative + input.native.neutral > 0
          ? [{ source: "p2pie", name: "P2PIE", positive: input.native.positive, negative: input.native.negative, total: input.native.positive + input.native.negative + input.native.neutral }]
          : []),
      ],
    },
    ageMonths,
    monitorings: sources.length,
    claimsOpen,
    check: verdict,
    factors,
    flags,
  };

  return { stars, score, level, reviewsCount: total, details };
};
