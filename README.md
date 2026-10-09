# competitors

Backend service of p2pie.com that collects data about **exchangers listed on competing monitorings**
(BestChange, KursExpert, ChangeInfo, E-mon, Wellcrypto, Obmify so far) and feeds it to the site:

- exchanger facts from the source: reserves, number of directions, review counters, claims, age;
- review **texts copied with the source named** and a link to the original. They are written into Strapi's native
  `review` collection (new fields `source`, `external_link`, `external_id`, `external_date`), so the site shows them in
  the same list and format as our own reviews, tagged "ИСТОЧНИК: …" with a link to the original;
- growth history (daily snapshots) for later analysis.

It is a separate service like `server`/`parser`: Fastify + TypeScript, its own Docker image, SQLite in a volume,
reachable only inside the docker network (`http://competitors:5100`), not exposed through the reverse proxy.

```
 sources: BestChange · KursExpert · ChangeInfo · E-mon · Wellcrypto · Obmify (more: see "Sources we looked at")
                          info.zip (official export)        exchanger pages (robots.txt allowed only)
                                   │                                    │
                                   ▼                                    ▼
 sources/bestchange:  api job ─► source_exchangers ◄─ list job      pages job ─► external_reviews
                                   │  (id,name,reserve,dirs,reviews)   │  (+counters, domain)    (moderated, with source)
                                   ▼                                    │
                              match job ──► exchanger_links ◄───────────┘ (only linked exchangers are crawled)
                                   ▲
                            our exchangers (GET server /exchangers)

 strapi.sync job (every 5 min): published + rated/toned + linked reviews ──► Strapi `review` (REST, user "parser")
                                  hidden/rejected/unlinked/takedown/kill switch ──► deleted from Strapi
 public API  GET /v1/exchangers/:ourId/external  ──►  front: counters line "Отзывы на BestChange" (limit=0)
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
- Only ordinary reviews are imported. **Financial claims are not republished** (only their count is shown). On BestChange an open claim is `review_block_2` (verified 2026-10-05); a row that a later crawl shows to be a claim/comment is retired (`rejected: claim`) and its Strapi copy removed.
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

Manual review of the conflict list (2026-10-06): the BestChange exchanger page `<title>` ends with the real domain in brackets
(`Обменник E-Change – … (e-change.io)`), which settles most "same name, different domain" cases — the second domain is usually a
mirror or a move (exdex.ae → exdex.xyz, ponybit.ru → ponybit.org, flashobmen.com → .io, xchange.fund = xchange.pub, royalcash.cc ↔ .info,
cryptokzn.ru → .com, coinblinker.me ↔ .org). Linked by hand (locked). Left unlinked on purpose: BestChange `Boss-Exchange`
(boss-exchange.com, a different business from our bossexchange.pro, which is linked to `BossExchangePro`), `WorldChange` (worldchange.cc is
not the WorldChange.ru/.me brand we list); `Exchnage` and `Swapbit` are not on BestChange at all. Possible matcher improvement: read the
domain from the page title when the export has none.

## Public API (internal)

`GET /v1/exchangers/:ourId/external?limit=&offset=&type=positive|neutral|negative` →
`{ notice, textsEnabled, sources: [{ source, name, exchangerName, url, stats{positive,negative,reviewsTotal,claimsOpen,claimsClosed,age,onSource,fetchedAt}, reviewsAvailable, reviews[{id,author,country,rating,type,text,postedAt,url,reply}] }] }`

`GET /v1/summary?ids=1,2,3` — counters only, many exchangers. `GET /health`.

## Admin API (`Authorization: Bearer $COMPETITORS_ADMIN_TOKEN`)

`GET /admin/status` (jobs, last runs, counts, open circuit breakers) · `GET /admin/exchangers?q=&linked=1` ·
`GET /admin/unmatched` · `GET|PUT /admin/links`, `DELETE /admin/links/:source/:extId` · `GET /admin/reviews?status=&ext_id=` ·
`POST /admin/reviews/:id/hide|publish` · `GET|POST /admin/takedowns` · `POST /admin/jobs/:name/run` · `GET /admin/fetches` ·
`GET /admin/history/:source/:extId`. From the VDS: `docker exec competitors wget -qO- --header "Authorization: Bearer …" http://127.0.0.1:5100/admin/status`.

## Rating and trust level (since 2026-10-09)

Job `rating.sync` (hourly, `RATING_SYNC_*` env) recomputes two numbers for every listed exchanger (status active/suspended) and
writes the changed ones to Strapi `exchanger`: `admin_rating` (stars, 0 = no reviews = hidden), `trust_level`
(unknown / caution / verified / reliable), `trust_score` (0..100), `reviews_count`, `rating_details` (breakdown shown on the page),
`rating_updated_at`. Method: `src/core/rating.ts` (pure, tested in `test/rating.test.ts`); its public description is the front page
`/rating` (`front/pages/rating/index.tsx`) — change both together and bump `METHOD_VERSION`.

- Stars = smoothed share of positive reviews (prior 30 reviews at 0.85; a negative review or an open claim weighs 10).
- Trust = reviews volume (30, log) + age (25, full at 5 years) + monitorings (20) + our check (15 / 5 / −25) + live rates (10) − claims / negative share.
- Inputs from this DB: counters, claims and age of the linked source exchangers (a missing link = missing reviews: fix it with
  `PUT /admin/links`); sources without counters (Obmify) are judged by the reviews we collected. From Strapi: our users' reviews,
  `exchanger_card.date_created`, `status`, and the manual fields `check_verdict` / `check_score` / `check_date` (result of
  `p2pie-ops/agent/exchanger-check.md`) and `rating_locked` (true = the job never touches this exchanger).
- Run now: `POST /admin/jobs/rating.sync/run` (JSON body `{}`); the stats list a sample of changed names.

## On the site

`front`: `services/competitors.ts` (fetch, optional — null on any failure, env `COMPETITORS_URL=http://competitors:5100`),
`components/exchangers/exchanger/ExternalReviews.tsx`. The block is labelled "Отзывы на BestChange", every review links to the
original, there is a notice that these are **not p2pie users' reviews** (since 2026-10-09 their counts DO feed the rating, see below). No schema.org Review markup,
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


## Strapi (native review format)

`strapi.sync` (src/core/strapiSync.ts) keeps Strapi's `review` collection equal to what we are allowed to show:

| Strapi field | value |
|---|---|
| `exchanger` | our exchanger id (from the link) |
| `text`, `type` | sanitized text; `type` = tone (positive/neutral/negative: stars on BestChange, the source's own tone on KursExpert) |
| `name`, `location` | author's public nickname, country |
| `isApproved` | `true` (it passed our moderation) |
| `fingerprint` | `ext:<source>:<review id>` — unique, so a retry after a crash adopts the existing copy |
| `source` | display name ("BestChange", "KursExpert") |
| `external_link` | permalink of the review on the source |
| `external_id`, `external_date` | `<source>:<id>`, the original date |
| `review_date` | the date reviews are shown and sorted by, for ALL reviews: = `external_date` for copies, creation time for our own (Strapi lifecycle `beforeCreate` default + one-off backfill; Strapi's `createdAt` cannot be set via the API) |
| `review_replies` | the exchanger's reply (`from: "exchanger"`) when the source has one |

Rules: unrated reviews (no stars and no tone) are not synced; Strapi does not cascade deletes, so replies are deleted
explicitly; a review deleted in Strapi by hand is marked `hidden` here and never resurrected; `PUBLISH_REVIEW_TEXTS=false`
removes every copy from Strapi (kill switch); takedowns delete the copy through `strapi_tombstones`. Credentials are the
`STRAPI_AUTH_IDENTIFIER/PASSWORD` of the `parser` user already in the shared `.env`. Batch size `STRAPI_SYNC_BATCH` (40 per run).
The exchanger page (front) loads **10 reviews** of all sources merged and sorted by `review_date` (top-level `reviews` query filtered by
exchanger, `services/exchangerReviews.ts`); "Показать ещё N из M" and the tone filters fetch further pages of 10 from
`/api/exchanger-reviews?id=&start=&type=` (cached 60 s, ids/offsets validated). The light nested `reviews` list (`type`, `source`, up to 100)
only feeds the counters. The global "latest reviews" feed on the home page excludes copies (`source: { null: true }`).

**No outbound links to other sites from the reviews area** (SEO): the source tag is not an `<a>` — `components/shared/OutLink.tsx` is a
`role="link"` span that opens `external_link` in a new tab on click, so crawlers see text, not a link. Review texts never contain
links/contacts (moderation) and **exchanger replies are copied only when they are free of links, e-mails, handles and phones**.

## Sources we looked at (2026-10-04)

| Source | Status | Why |
|---|---|---|
| BestChange | **done** | official `info.zip` + plain exchanger pages; query URLs forbidden by robots.txt |
| KursExpert (kurs.expert) | **done** | robots.txt open; list `/ru/obmennik.html` (369 exchangers, counters, reserves), reviews on `/ru/obmennik/<slug>/feedbacks.html` (~40 newest per page, tone given by the source); its negative reviews ("претензия") are imported too so the picture stays balanced; user-to-user answers are not |
| ChangeInfo (changeinfo.ru) | **done** | `/exchangers` list (name, website → domain match, reserve, counters), reviews on `/review/<name>` (the `/positive` and `/negative` sub-pages are disallowed by robots.txt and never requested); the feed has a lot of test spam (random strings, pasted code, invoices), so moderation also rejects gibberish, code and 40+ character tokens |
| E-mon (e-mon.cc) | **done** | robots.txt open; `/exchangers` (429 exchangers with website → domain match, status, reserve, counters), `/exchanger/<id>` shows up to 200 newest reviews (tone classes bad/good/very-good/excellent; `type-comment` follow-ups are skipped); many exchangers' reviews are old (2020) and fall outside the 365-day window |
| Wellcrypto (wellcrypto.io) | **done** | robots.txt open; `/ru/exchangers/` (226 exchangers), `/ru/exchangers/<slug>/` renders the 25 newest reviews with a tone class (`positive _confirmed`); the site exposes no review ids, so ids are a stable hash of author+date+text; the "Перейти" button gives the exchanger's domain |
| Obmify (obmify.com) | **done** | Ukrainian monitoring, Nuxt SSR; robots.txt closes only `/api/` (where the review cards load from), so the page's JSON-LD `Organization` block is read: 10 newest reviews with stars (→ tone), author, ISO date, plus the referral `url` (→ domain for matching) and the total count. 161 exchangers, 9 overlap with ours by name. Ids = hash of author+date+text |
| bits.media (exchanger.bits.media) | too small | only 7 exchangers listed |
| Scanbit.ua | skipped | Ukrainian market, 49 exchangers, 3 overlap with ours; Nuxt SSR with JSON-LD reviews — easy to add later if wanted |
| ExchangeSumo | no texts | reviews are loaded through `/comment/…`, which its robots.txt disallows; no server-rendered reviews |
| OKChanger | skipped | exchanger pages take 80+ s and 1.4 MB, reviews load by AJAX (`view-thread`, disallowed) |
| Exnode.ru | blocked | answers 403 to non-browser clients (anti-bot); we do not circumvent protections |
| 1obmen.net, cryptorates.ru | blocked | Cloudflare challenge; same |
| bits.media exchangers | gone | `exchanger.bits.media` returns 404 |
| bestexchangers.com & co | duplicates | redirect to / clones of BestChange (same reviews) |

Review texts of KursExpert come with Moscow-time stamps (the site shows no zone); stored as UTC.
