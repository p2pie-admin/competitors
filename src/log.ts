// Thin structured logger (JSON lines, same shape family as fastify/pino output) so the process
// has one logging style without pulling pino in as a direct dependency.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

const write = (level: Level, scope: string, msg: string, extra?: Record<string, unknown>) => {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...extra });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
};

export const logger = (scope: string) => ({
  debug: (msg: string, extra?: Record<string, unknown>) => write("debug", scope, msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write("info", scope, msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write("warn", scope, msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", scope, msg, extra),
});
export type Logger = ReturnType<typeof logger>;
