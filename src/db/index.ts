import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MIGRATIONS } from "./migrations";
import { logger } from "../log";

const log = logger("db");

export type DB = Database.Database;

export const openDb = (dataDir: string, file = "competitors.sqlite"): DB => {
  const full = dataDir === ":memory:" ? ":memory:" : path.join(dataDir, file);
  if (full !== ":memory:") fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(full);
  // WAL: readers (public API) never block the writer (crawler); NORMAL sync is safe with WAL.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
};

export const migrate = (db: DB): void => {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
    log.info("migration applied", { version: v + 1 });
  }
};

export const nowSec = (): number => Math.floor(Date.now() / 1000);
