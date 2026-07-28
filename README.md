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
- **`/anakin-search <query>` slash command.** Subscribes to `issue_comment`.
  A comment starting with `/anakin-search` triggers Anakin's plain, synchronous
  `search` endpoint (no polling) and replies with the top results — a
  lighter-weight alternative for one-off questions that don't need the full
  agentic pipeline.

## Architecture

```
app.yml            GitHub App manifest (registration source of truth)
server.js          Express server: webhook route, signature check, event routing
lib/
  verify-signature.js   HMAC-SHA256 verification of X-Hub-Signature-256
  github-auth.js         JWT (RS256) -> installation access token -> Octokit
  anakin-client.js        Anakin API client (search, agentic-search)
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

Ground truth read directly from the real SDK (not guessed):
`anakin-py/src/anakin/client.py`, `_http.py`, `models.py`.

- Base URL: `https://api.anakin.io/v1`
- Auth: `X-API-Key: <key>` header
- `POST /search` — synchronous, `{prompt, limit}` -> `{id, results: [...]}`
- `POST /agentic-search` — submits `{prompt, useBrowser}` -> `{jobId}`
- `GET /agentic-search/:jobId` — poll until `status` is `"completed"` or
  `"failed"`; on completion, `generatedJson.summary` is the text posted to
  the issue.

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
