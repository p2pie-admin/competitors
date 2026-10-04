import type { JobCtx, JobDef } from "./types";
import { logger } from "../log";

const log = logger("scheduler");

type State = { def: JobDef; timer: NodeJS.Timeout | null; running: boolean; failures: number; nextAt: number | null };

/**
 * In-process job runner.
 *  - one job at a time across the whole service (the zip import is memory heavy and the crawler
 *    must stay gentle, so jobs never overlap);
 *  - the next run is scheduled after the previous one FINISHES (no pile-ups), with +-10 % jitter;
 *  - consecutive failures back off exponentially up to 6 h;
 *  - every run is recorded in job_runs (also when it throws).
 */
export class Scheduler {
  private states = new Map<string, State>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: JobCtx) {}

  add(def: JobDef): void {
    if (this.states.has(def.name)) throw new Error(`duplicate job ${def.name}`);
    this.states.set(def.name, { def, timer: null, running: false, failures: 0, nextAt: null });
  }

  start(): void {
    for (const s of this.states.values()) this.schedule(s, s.def.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.states.values()) if (s.timer) clearTimeout(s.timer);
  }

  jobs(): Array<{ name: string; everyMs: number; running: boolean; failures: number; nextAt: number | null }> {
    return [...this.states.values()].map((s) => ({ name: s.def.name, everyMs: s.def.everyMs, running: s.running, failures: s.failures, nextAt: s.nextAt }));
  }

  /** Run now (admin). Resolves with the job's stats; rejects with its error. */
  runNow(name: string): Promise<Record<string, unknown>> {
    const s = this.states.get(name);
    if (!s) return Promise.reject(new Error(`unknown job ${name}`));
    return this.execute(s);
  }

  private schedule(s: State, delayMs: number): void {
    if (this.stopped) return;
    s.nextAt = Date.now() + delayMs;
    s.timer = setTimeout(() => {
      this.execute(s)
        .catch(() => undefined)
        .finally(() => {
          const base = s.def.everyMs * 2 ** Math.min(s.failures, 6);
          const capped = Math.min(base, 6 * 3600_000);
          const jitter = 1 + (Math.random() - 0.5) * 0.2;
          this.schedule(s, Math.max(30_000, Math.round(capped * jitter)));
        });
    }, delayMs);
    s.timer.unref?.();
  }

  private execute(s: State): Promise<Record<string, unknown>> {
    const run = this.chain.then(async () => {
      s.running = true;
      const runId = this.ctx.store.startRun(s.def.name);
      const started = Date.now();
      try {
        const stats = await s.def.run(this.ctx);
        this.ctx.store.finishRun(runId, true, { ...stats, ms: Date.now() - started });
        s.failures = 0;
        log.info("job ok", { job: s.def.name, ms: Date.now() - started, ...stats });
        return stats;
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.ctx.store.finishRun(runId, false, { ms: Date.now() - started }, msg);
        s.failures++;
        log.error("job failed", { job: s.def.name, err: msg, failures: s.failures });
        throw err;
      } finally {
        s.running = false;
      }
    });
    // Keep the chain alive after a failure.
    this.chain = run.catch(() => undefined);
    return run;
  }
}
