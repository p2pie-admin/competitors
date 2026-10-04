// Forward-only migrations, applied in order and tracked through PRAGMA user_version.
// Never edit an applied migration: add a new one.
export const MIGRATIONS: string[] = [
  // 1 — core schema
  `
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- An exchanger as listed by a source monitoring.
  CREATE TABLE source_exchangers (
    source TEXT NOT NULL REFERENCES sources(id),
    ext_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT,                 -- path slug on the source (e.g. "sova" for /sova-exchanger.html)
    url TEXT,                  -- source page of the exchanger
    domain TEXT,               -- exchanger website host as shown by the source
    country TEXT,
    status TEXT NOT NULL DEFAULT 'active',   -- active | gone
    reserve_usd REAL,
    directions INTEGER,
    reviews_pos INTEGER,
    reviews_neg INTEGER,
    claims_open INTEGER,
    claims_closed INTEGER,
    reviews_total INTEGER,     -- total reviews counter shown on the page
    aml TEXT,
    age_text TEXT,
    on_source_text TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    page_fetched_at INTEGER,
    page_hash TEXT,
    PRIMARY KEY (source, ext_id)
  );
  CREATE INDEX idx_srcex_slug ON source_exchangers(source, slug);
  CREATE INDEX idx_srcex_domain ON source_exchangers(domain);
  CREATE INDEX idx_srcex_name ON source_exchangers(source, name);

  -- Our exchanger <-> source exchanger.
  CREATE TABLE exchanger_links (
    source TEXT NOT NULL,
    ext_id TEXT NOT NULL,
    our_exchanger_id TEXT NOT NULL,
    our_name TEXT,
    method TEXT NOT NULL,      -- domain | name | manual
    confidence REAL NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,   -- 1 = set by a human, never re-matched automatically
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, ext_id),
    FOREIGN KEY (source, ext_id) REFERENCES source_exchangers(source, ext_id) ON DELETE CASCADE
  );
  CREATE INDEX idx_links_our ON exchanger_links(our_exchanger_id);

  -- Daily numbers per source exchanger (growth of reviews, reserves, directions).
  CREATE TABLE exchanger_daily (
    source TEXT NOT NULL,
    ext_id TEXT NOT NULL,
    day TEXT NOT NULL,         -- YYYY-MM-DD (UTC)
    reviews_pos INTEGER,
    reviews_neg INTEGER,
    directions INTEGER,
    reserve_usd REAL,
    PRIMARY KEY (source, ext_id, day)
  );

  -- Review texts copied from a source, always with provenance.
  CREATE TABLE external_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ext_id TEXT NOT NULL,              -- source exchanger
    ext_review_id TEXT NOT NULL,       -- review id on the source
    author TEXT,
    country TEXT,
    rating INTEGER,                    -- 1..5 stars as given by the author
    text TEXT NOT NULL,                -- sanitized text we are allowed to show
    text_hash TEXT NOT NULL,
    posted_at INTEGER NOT NULL,        -- unix seconds, from the source
    source_url TEXT NOT NULL,          -- permalink of the review on the source
    reply_author TEXT,
    reply_text TEXT,
    reply_at INTEGER,
    status TEXT NOT NULL,              -- published | pending | hidden | rejected
    reject_reason TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, ext_review_id)
  );
  CREATE INDEX idx_reviews_ex ON external_reviews(source, ext_id, status, posted_at DESC);
  CREATE INDEX idx_reviews_status ON external_reviews(status);

  -- Removal requests: nothing listed here is ever (re-)imported.
  CREATE TABLE takedowns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ext_review_id TEXT,        -- one review, or ...
    ext_id TEXT,               -- ... every review of one source exchanger
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_takedowns_review ON takedowns(source, ext_review_id);
  CREATE INDEX idx_takedowns_ex ON takedowns(source, ext_id);

  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    stats TEXT,
    error TEXT
  );
  CREATE INDEX idx_job_runs ON job_runs(job, started_at DESC);

  CREATE TABLE fetch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    host TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER,
    ms INTEGER,
    bytes INTEGER,
    note TEXT
  );
  CREATE INDEX idx_fetch_log ON fetch_log(ts);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];
