# github-app-anakin

A GitHub App, listed on GitHub Marketplace, that uses [Anakin](https://anakin.io)
to research CI failures and answer ad-hoc questions from inside a GitHub
issue.

## What it does

- **Auto-research on CI failure.** Subscribes to the `workflow_run` webhook
  event. When a run completes with `conclusion: "failure"`, the app:
  1. Looks up the failed job/step via GitHub's Actions API.
  2. Immediately files a GitHub issue (so there's something to look at right
     away, before Anakin's research finishes).
  3. Calls Anakin's `agentic-search` — a multi-stage AI research pipeline —
     with a prompt built from the workflow/job/step names, asking it to
     search recent GitHub issues, release notes, and docs for that error
     signature.
  4. Posts the findings as a follow-up comment on the issue it just filed.
- **Slash commands in issue comments.** Subscribes to `issue_comment`; a
  comment starting with one of the commands below triggers the matching
  Anakin API call and replies with the result. `/anakin-search` is the
  original, lightest-weight one; the rest (added in a later pass) cover
  Anakin's site-automation, AI-visibility, monitoring, and crawling surface
  for research/lookup use from a GitHub thread. All are read-only lookups —
  none of them create, change, or delete anything on Anakin's side.

  | Command | Anakin endpoint | What it does |
  | --- | --- | --- |
  | `/anakin-search <query>` | `POST /search` | Synchronous AI web search — top results, no polling. |
  | `/anakin-wire <query>` | `GET /wire/resolve` | Find Wire actions (pre-built site automations) for a natural-language intent, e.g. "top phones on walmart". |
  | `/anakin-wire-catalog [slug]` | `GET /wire/catalog[/:slug]` | Browse the Wire catalog, or one site's full action list + param schemas. |
  | `/anakin-wire-run <action_id> [json]` | `POST /wire/task` (polled) | Run a Wire action (intended for **read**/data-extraction actions — see "Known limitations"). `[json]` is the action's `params`, single line. |
  | `/anakin-ai-visibility-sources` | `GET /ai-visibility/sources` | List the AI answer engines available to `/anakin-ai-visibility`. |
  | `/anakin-ai-visibility <query>` | `POST /ai-visibility/search` (polled) | Ask ChatGPT/Gemini/Google AI Overview/etc. the same question and compare answers. |
  | `/anakin-monitors [id]` | `GET /monitors[/:id]` | List website monitors, or fetch one by id. |
  | `/anakin-monitor-changes <id>` | `GET /monitors/:id/changes` | Detected changes for a monitor. |
  | `/anakin-sessions [domain]` | `GET /sessions` | List saved browser sessions, optionally filtered to a domain. |
  | `/anakin-map <url>` | `POST /map` (polled) | Discover reachable URLs under a site. |
  | `/anakin-crawl <url>` | `POST /crawl` (polled) | Bulk-fetch markdown across a site (capped at 10 pages). |

## Architecture

```
app.yml            GitHub App manifest (registration source of truth)
server.js          Express server: webhook route, signature check, event routing,
                    slash-command dispatch table (SLASH_COMMANDS), all command handlers
lib/
  verify-signature.js   HMAC-SHA256 verification of X-Hub-Signature-256
  github-auth.js         JWT (RS256) -> installation access token -> Octokit
  anakin-client.js        Anakin API client (search, agentic-search, wire,
                           ai-visibility, monitors, sessions, map, crawl)
test/                Unit tests (node:test) — signature verification, event routing
scripts/smoke-test.js  Starts the real server, sends real signed webhook requests
```

### Auth flow (GitHub App -> GitHub API)

1. The App's private key (PEM, issued once at registration) signs a JWT:
   RS256, claims `iat` (backdated 60s), `exp` (<= 10 min from `iat`), `iss`
   (the App ID).
2. That JWT is exchanged for a short-lived (1 hour) installation access token
   via `POST /app/installations/{installation_id}/access_tokens`.
3. The installation token authenticates normal REST calls (file the issue,
   post the comment).

`lib/github-auth.js` doesn't hand-roll this — it uses `@octokit/auth-app`
(GitHub's own recommended library for it) and `@octokit/rest` for the
resulting API calls.

### Webhook signature verification

GitHub signs every delivery with HMAC-SHA256 over the **raw** request body,
sent as `X-Hub-Signature-256: sha256=<hex digest>`. `server.js` uses
`express.raw()` (not `express.json()`) on `/webhook` specifically so the
bytes handed to `verifySignature` are exactly what GitHub signed — parsing
first and re-serializing would silently break verification on any
whitespace/key-order difference. Comparison uses `crypto.timingSafeEqual`,
per GitHub's own documented recommendation.

### Why the webhook handler responds before the work is done

`agentic-search` is a submit-then-poll job that can take up to minutes.
GitHub expects webhook deliveries to be acked quickly. So `/webhook`
verifies the signature, parses the payload, and responds `202` immediately;
the actual GitHub-issue-filing and Anakin research happen in an unawaited
async function whose errors are caught and logged, never left as an
unhandled rejection.

## Anakin API usage

Ground truth for `search`/`agentic-search` read directly from the real SDK
(not guessed): `anakin-py/src/anakin/client.py`, `_http.py`, `models.py`.
Ground truth for every endpoint added in the later pass (wire, ai-visibility,
monitors, sessions, map, crawl) read directly from Anakin's own MCP server
source instead: `anakin-mcp/src/client.ts` and `anakin-mcp/src/tools/*.ts`
(field names, defaults, and poll semantics all transcribed from there, not
invented).

- Base URL: `https://api.anakin.io/v1`
- Auth: `X-API-Key: <key>` header
- `POST /search` — synchronous, `{prompt, limit}` -> `{id, results: [...]}`
- `POST /agentic-search` — submits `{prompt, useBrowser}` -> `{jobId}`
- `GET /agentic-search/:jobId` — poll until `status` is `"completed"` or
  `"failed"`; on completion, `generatedJson.summary` is the text posted to
  the issue.
- `GET /wire/resolve?q=&limit=` — ranked candidate Wire actions for a
  natural-language intent.
- `GET /wire/catalog` / `GET /wire/catalog/:slug` — browse the catalog.
- `POST /wire/task {action_id, params?}` — submits; sync actions return data
  inline (no `job_id`), async ones are polled at `GET /wire/jobs/:jobId`
  (honoring the server's `retry_after_ms` pacing hint).
- `POST /ai-visibility/search {query, sources?, country?}` — submits; polled
  at `GET /ai-visibility/search/:id` while `status` is `"running"` (a
  terminal `"failed"` is returned, not thrown — per-source results are
  useful either way).
- `GET /ai-visibility/sources` — available AI engine slugs.
- `GET /monitors` / `GET /monitors/:id` — list or fetch website monitors.
- `GET /monitors/:id/changes` — a monitor's detected changes.
- `GET /sessions?domain=` — saved browser sessions.
- `POST /map {url, ...}` — submits; polled at `GET /map/:jobId`.
- `POST /crawl {url, ...}` — submits; polled at `GET /crawl/:jobId`.

## Setup

```sh
npm install
cp .env.example .env   # fill in GITHUB_APP_ID, GITHUB_PRIVATE_KEY,
                        # GITHUB_WEBHOOK_SECRET, ANAKIN_API_KEY
npm start
```

Registering the App itself (one-time, needs a real GitHub account and a
publicly reachable host for the webhook/redirect URLs) follows GitHub's
manifest flow — see the header comment in `app.yml` for the exact steps.

## Test

```sh
npm test    # unit tests: signature verification + event routing (node:test)
npm run smoke   # starts the real server, sends real signed HTTP requests
```

## Known limitations

- Uses the failed job/step **name** as the error signature for Anakin's
  research prompt, not the full job log text. Downloading and unzipping the
  full log archive (`GET .../actions/runs/{run_id}/logs`) would give a more
  precise error signature but adds real complexity (zip handling, log size,
  log redaction) — a reasonable v2 improvement, not implemented here.
- No idempotency/dedup key on `workflow_run` deliveries — a GitHub webhook
  redelivery (manual retry, or GitHub's own retry-on-5xx behavior) would file
  a second issue. A production hardening pass would key on
  `workflow_run.id` (e.g. in a small KV store) before filing.
- No `marketplace_purchase` webhook handling — required for a *paid*
  Marketplace listing (see `SUBMIT.md`), not needed for a free listing.
- **`/anakin-wire-run` does not verify an action is read-only before running
  it.** Anakin's own MCP server exposes Wire execution as two tools —
  `wire_read_action` / `wire_write_action` — purely as a tool-schema safety
  annotation; `POST /wire/task` itself doesn't distinguish read from write.
  This app only implements the read-oriented command (no
  `/anakin-wire-write`, `/anakin-wire-login`, or `/anakin-wire-build`
  command exists), but doesn't cross-check a given `action_id`'s `type`
  against the catalog before running it — an issue commenter who already
  knows a write action's `action_id` (from `/anakin-wire-catalog`, say)
  could still trigger it. A production hardening pass would look up the
  action's `type` via `wire_catalog` first and refuse `type: "write"`.
- **No allowlist on who can invoke `/anakin-*` commands.** Any GitHub user
  who can comment on an issue in an installed repo can trigger any command
  (including `/anakin-wire-run`, `/anakin-map`, `/anakin-crawl` — all of
  which spend Anakin credits and, for `/anakin-wire-run`, may hit an
  external site). A production hardening pass would check
  `payload.comment.user` against repo write-access or an explicit allowlist
  before dispatching.
- **`monitor_create`, `monitor_control`, `session_delete`,
  `wire_login`, `wire_build`, `wire_write_action`, and `browser_task`
  are deliberately not exposed as commands** — all are state-changing (spend
  credits recurringly, sign in to third-party sites, delete stored
  credentials, or drive a live browser) and don't fit an unauthenticated,
  anyone-can-comment issue thread without the access-control hardening noted
  above. `wire_identities` (listing saved credentials) is also omitted: it
  has no standalone use once `wire_login` is out of scope, since most Wire
  read actions need no auth in the first place. `scrape` (single-URL fetch)
  is omitted too — `/anakin-map` and `/anakin-crawl` already cover
  multi/whole-site fetches, and `/anakin-wire`/`/anakin-search` cover
  single-page lookups.
- Wire/monitor/session responses have open (`Record<string, unknown>`)
  shapes in Anakin's own SDK — this app renders them as a fenced JSON block
  (truncated past 6000 chars) rather than reformatting into prose, so it
  never has to guess at field names that aren't documented anywhere.
  `/anakin-monitors` and `/anakin-monitor-changes` strip each monitor's
  `alertWebhookSecret` first (mirroring `anakin-mcp`'s own `redactSecrets`)
  since issue comments are frequently public.
