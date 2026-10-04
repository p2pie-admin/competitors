# competitors

Backend service of p2pie.com that collects data about **exchangers listed on competing monitorings**
(BestChange first) and feeds it to the site:

- exchanger facts from the source: reserves, number of directions, review counters, claims, age;
- review **texts copied with the source named** and a link to the original, shown on our exchanger pages;
- growth history (daily snapshots) for later analysis.

It is a separate service like `server`/`parser`: Fastify + TypeScript, its own Docker image, SQLite in a volume,
reachable only inside the docker network (`http://competitors:5100`), not exposed through the reverse proxy.

```
                          info.zip (official export)        exchanger pages (robots.txt allowed only)
                                   │                                    │
                                   ▼                                    ▼
 sources/bestchange:  api job ─► source_exchangers ◄─ list job      pages job ─► external_reviews
                                   │  (id,name,reserve,dirs,reviews)   │  (+counters, domain)    (moderated, with source)
                                   ▼                                    │
                              match job ──► exchanger_links ◄───────────┘ (only linked exchangers are crawled)
                                   ▲
                            our exchangers (GET server /exchangers)

 public API  GET /v1/exchangers/:ourId/external  ──►  front (getStaticProps, ISR)  ──►  "Отзывы на BestChange"
 admin API   /admin/*  (Bearer token)                  moderation, manual links, takedowns, job runs, status
```

## What is collected and how (BestChange)

| Job | Every | Source | What |
|---|---|---|---|
| `bestchange.api` | 60 min | `http://api.bestchange.ru/info.zip` — BestChange's official public export (~16 MB) | all exchangers, reserves, number of directions, `negative.positive` review counters; daily snapshot per exchanger; marks vanished exchangers `gone` (only after a plausible snapshot) |
| `bestchange.list` | 24 h | `/list.html` (one page, allowed) | id ↔ slug for all ~635 exchangers |
| `bestchange.match` | 60 min | our `server` + seed `seed/bestchange-links.json` | links source exchangers to ours (see Matching) |
| `bestchange.pages` | 10 min tick | `/<slug>-exchanger.html` — plain page only | per tick ≤ 6 of the *stalest linked* exchangers (each re-read after 12 h): counters, website domain, **latest ~50 reviews** |
| `housekeeping` | 24 h | — | prune fetch log/job runs (14 d), WAL checkpoint |

### Crawl policy (non-negotiable, enforced in `src/http/client.ts`)

- Identifying `User-Agent: p2pie-competitors/1.0 (+https://p2pie.com; support@p2pie.com)` — the site owner can contact us.
- **robots.txt is obeyed** (RFC 9309; 4xx = allowed, 5xx = disallowed for a while). BestChange disallows every URL with a
  query string (`?filter=`, `?page=`, `?review=`), so **only the plain exchanger page is ever requested** — the latest ~50
  reviews. Full review history is *not* crawled. Over time the periodic reads accumulate the stream of new reviews.
- One request at a time per host, ≥ 6 s apart (+ jitter, and the site's `Crawl-delay` if any); ≤ 6 pages per 10 min.
- 429/503 honor `Retry-After`; 403 or 4 consecutive failures open a **circuit breaker for 30 min** (persisted, survives restarts).
- Size caps, per-request timeouts, retries with backoff for 5xx only.
- The zip is fetched conditionally (ETag / If-Modified-Since). The export is an official partner feed on a dedicated host.
- An official API v2 exists (`api.bestchange.ru`, Swagger) but needs a key; if BestChange grants one and it exposes reviews,
  swap the crawler for it (the `pages` job is the only consumer of HTML).

### Review handling

- Stored per review: source id, author's public nickname, country, stars, text, date, **permalink**, the exchanger's reply.
  **Never stored: the (masked) IP address**, e-mail, anything else on the page.
- Only ordinary reviews are imported. **Financial claims are not republished** (only their count is shown).
- Moderation (`src/core/moderation.ts`) rejects: too short, mostly non-text, links/e-mails/@handles/messenger contacts,
  phone numbers, crypto addresses/long hashes, card numbers, Russian profanity, copy-paste duplicates (≥ 3 identical texts for
  one exchanger). **Sentiment is never a filter**: negative reviews are shown exactly like positive ones, otherwise the block
  would be advertising and mislead users. Reviews the *source's own moderators* flagged ("на проверке", "персональные данные
  удалены", …) are held `pending`; unrated reviews are shown without stars.
- Statuses: `published` · `pending` (held, re-evaluated each crawl) · `rejected` (with reason) · `hidden` (human decision, sticky).
- Only reviews younger than `MAX_REVIEW_AGE_DAYS` (365) are shown; at most `MAX_PUBLIC_REVIEWS` (30) per exchanger.
- **Takedowns**: `POST /admin/takedowns` for one review or a whole source exchanger deletes now and blocks re-import forever.
  Answer any removal request (BestChange, an author, an exchanger) with this endpoint, same day.
- `PUBLISH_REVIEW_TEXTS=false` switches texts off in the public API at once (counters stay). Use it as the kill switch.

### Matching with our exchangers (`src/core/matcher.ts`)

1. website **domain** equal (our `ref_link`/`rates_link` vs the domain the source shows) → 0.98 (1.0 with equal name);
2. **name** equal after transliteration, unique among ours → 0.8;
3. same name but both sides know a *different* domain → **conflict**, no link (two businesses can share a brand word);
4. ambiguous names are never guessed. Conflicts are saved and listed by `GET /admin/unmatched`.

Links made by a human (`PUT /admin/links`) are `locked` and never touched by the matcher. Links the matcher made that no longer
hold are removed, and with them the reviews disappear from the site.

## Public API (internal)

`GET /v1/exchangers/:ourId/external?limit=&offset=&type=positive|neutral|negative` →
`{ notice, textsEnabled, sources: [{ source, name, exchangerName, url, stats{positive,negative,reviewsTotal,claimsOpen,claimsClosed,age,onSource,fetchedAt}, reviewsAvailable, reviews[{id,author,country,rating,type,text,postedAt,url,reply}] }] }`

`GET /v1/summary?ids=1,2,3` — counters only, many exchangers. `GET /health`.

## Admin API (`Authorization: Bearer $COMPETITORS_ADMIN_TOKEN`)

`GET /admin/status` (jobs, last runs, counts, open circuit breakers) · `GET /admin/exchangers?q=&linked=1` ·
`GET /admin/unmatched` · `GET|PUT /admin/links`, `DELETE /admin/links/:source/:extId` · `GET /admin/reviews?status=&ext_id=` ·
`POST /admin/reviews/:id/hide|publish` · `GET|POST /admin/takedowns` · `POST /admin/jobs/:name/run` · `GET /admin/fetches` ·
`GET /admin/history/:source/:extId`. From the VDS: `docker exec competitors wget -qO- --header "Authorization: Bearer …" http://127.0.0.1:5100/admin/status`.

## On the site

`front`: `services/competitors.ts` (fetch, optional — null on any failure, env `COMPETITORS_URL=http://competitors:5100`),
`components/exchangers/exchanger/ExternalReviews.tsx`. The block is labelled "Отзывы на BestChange", every review links to the
original, there is a notice that these are **not p2pie users' reviews and not part of our rating**. No schema.org Review markup,
no `aggregateRating` (self-serving/third-party markup is a ranking risk), the texts sit inside Yandex `<noindex>` and
`data-nosnippet`, so copied text is shown to people but is not offered to the index. All source links are `nofollow`.

## Adding another monitoring

Create `src/sources/<name>/` with a `SourceDef` (jobs: `<name>.api|list|pages`), reuse `PoliteClient`, `moderation`, `Store`
(`source` column already separates data), register it in `src/sources/registry.ts`, add its label to `SOURCE_LABELS`
(`src/api/public.ts`). Read its robots.txt and terms first; prefer an official feed.

## Run / test / deploy

```
docker run --rm -v $PWD:/app -w /app node:20-alpine sh -c "yarn && yarn typecheck && yarn test"   # 66 tests, no network
cp .env.example .env && docker compose up --build                                                   # local, :5100
~/p2pie-ops/scripts/deploy-service.sh competitors                                                    # build on red, ship to VDS
```

Production wiring (VDS `/root/docker-compose.yml`): service `competitors`, image `darkshrine/competitors:latest`, volume
`competitors_data:/data`, network `my-network`, env `COMPETITORS_ADMIN_TOKEN`, `OUR_SERVER_URL=http://server:5000`;
`front` gets `COMPETITORS_URL=http://competitors:5100`. Backups: the volume is covered by the 2-hourly volume backup script.
Data is re-creatable (the API job refills everything within an hour, reviews within a few days), so losing the volume is
annoying, not fatal — except `takedowns` and manual links: keep the volume backup.

## Operating notes

- Cheap to run: ~250 MB image, SQLite WAL, one 16 MB download per hour, ≤ 36 small page requests per hour.
- Healthy = `GET /admin/status`: `bestchangeApiUpdatedAt` < 2 h old, no open circuit, last runs `ok`.
- If BestChange changes markup the page parser fails loudly (`page layout not recognised`), the job records the error, nothing is
  imported from that page. Fixtures in `test/fixtures` show what the parser expects.
- Legal: copying third-party review texts is the owner's decision and risk (BestChange's terms are not a licence). Mitigations built
  in: attribution + link, takedown endpoint, kill switch, no claims, no personal data, polite crawling. Respond quickly to any request.
