import type { Config } from "../config";
import { logger } from "../log";

const log = logger("revalidate");

/** Same transformation the front uses for /exchangers/<slug> (components/exchangers/helper.ts). */
export const exchangerSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-");

/**
 * Ask the front to regenerate the pages of exchangers whose external reviews changed.
 * Best effort: a failure only means the page refreshes at its normal TTL.
 */
export const revalidateExchangerPages = async (
  config: Pick<Config, "FRONT_URL" | "REVALIDATE_SECRET">,
  ourNames: string[],
  fetchImpl: typeof fetch = fetch
): Promise<{ requested: number; ok: boolean }> => {
  if (!config.FRONT_URL || !config.REVALIDATE_SECRET) return { requested: 0, ok: true };
  const paths = [...new Set(ourNames.map(exchangerSlug).filter(Boolean))].map((s) => `/exchangers/${s}`);
  if (!paths.length) return { requested: 0, ok: true };
  try {
    const res = await fetchImpl(`${config.FRONT_URL.replace(/\/$/, "")}/api/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": config.REVALIDATE_SECRET },
      body: JSON.stringify({ paths: paths.slice(0, 60) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) log.warn("revalidate rejected", { status: res.status });
    return { requested: paths.length, ok: res.ok };
  } catch (err) {
    log.warn("revalidate failed", { err: String(err) });
    return { requested: paths.length, ok: false };
  }
};
