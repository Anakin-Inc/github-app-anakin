# GitHub App + GitHub Marketplace — submission instructions

Real, but the biggest lift in this batch: unlike an MCP-registry PR or a
connector CLI deploy, a GitHub App is a standing service (needs a host,
private key, webhook secret) *and* a Marketplace listing is a reviewed,
legal-agreement-gated process on top of that. Nothing here was filed —
filing needs the account owner's GitHub identity, a deployed host, and
acceptance of GitHub's Marketplace Developer Agreement.

## What's here

```
app.yml               GitHub App manifest (registration source of truth)
server.js              Express webhook server + event routing
lib/verify-signature.js   HMAC-SHA256 / X-Hub-Signature-256 verification
lib/github-auth.js         JWT (RS256) -> installation access token, via @octokit/auth-app
lib/anakin-client.js        Anakin API client (search, agentic-search)
test/*.test.js          node:test unit tests
scripts/smoke-test.js    Starts the real server, sends real signed HTTP requests
package.json, .env.example, .gitignore
```

## Real GitHub App / webhook structure — confirmed live, not guessed

All of the following was read directly from `docs.github.com` via WebFetch
during this session (not recalled from training data), specifically because
GitHub App auth details are exactly the kind of thing worth re-verifying:

- **Manifest registration flow** —
  [docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
  a JSON-encoded manifest is POSTed as a form field to
  `github.com/settings/apps/new` (or the org equivalent), GitHub redirects to
  `redirect_url` with a one-time `code`, and the app exchanges that code —
  within one hour — via `POST /app-manifests/{code}/conversions` for the
  permanent App ID, PEM private key, and webhook secret. `app.yml`'s header
  comment documents this exact sequence; `app.yml`'s fields
  (`name`, `url`, `hook_attributes.url`, `redirect_url`, `public`,
  `default_permissions`, `default_events`) match the manifest schema
  confirmed on that page.
- **JWT generation** —
  [docs.github.com/.../generating-a-json-web-token-jwt-for-a-github-app](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
  RS256 signing; claims `iat` (backdated 60s for clock drift), `exp` (no more
  than 10 minutes past `iat`), `iss` (the App ID). `lib/github-auth.js`
  doesn't hand-roll this — it delegates to `@octokit/auth-app`, which
  implements exactly this (confirmed by reading its dependency
  `universal-github-app-jwt`'s behavior in the stack trace captured during
  the smoke test below).
- **Installation access token exchange** —
  [docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app):
  `POST /app/installations/{installation_id}/access_tokens`, `Authorization:
  Bearer <jwt>`, response `{token, expires_at, ...}`, 1-hour validity.
- **`workflow_run` event** —
  [docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run](https://docs.github.com/en/webhooks/webhook-events-and-payloads):
  fires on `action: "completed"` (among other actions) with
  `workflow_run.conclusion` / `workflow_run.status`; a GitHub App must have
  at least read-level `Actions` permission to receive it — this is why
  `app.yml`'s `default_permissions.actions` is `read`.
- **`issue_comment` event**: `action: "created"` with `comment.body` and
  `issue.number` — used for the slash command.
- **Signature verification** —
  [docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries):
  `X-Hub-Signature-256: sha256=<hmac-sha256 hex digest of the raw body>`,
  verified with a constant-time comparison
  (`crypto.timingSafeEqual`) — GitHub's own docs explicitly warn against
  `===`/`==`. `lib/verify-signature.js` implements exactly this.
- **`X-GitHub-Api-Version` header value**: fetched live from
  `docs.github.com/en/rest/about-the-rest-api/api-versions`, which currently
  shows `2026-03-10` in its curl example — noted here because this differs
  from the `2022-11-28` value that had been the long-standing constant for
  years; this integration relies on `@octokit/rest`'s own default rather
  than hardcoding either value, so it isn't exposed to this drift.
- **GitHub Marketplace listing requirements** (via WebSearch, since the
  specific docs URLs 404'd on first WebFetch attempt —
  `docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app`
  and the Marketplace API overview page — resolved via search instead):
  a listing needs a public (non-preview, non-invite-only) app, a pricing
  plan (a free plan is fine, but *some* plan is required), a privacy policy
  link, a terms-of-service link, a support contact, a logo/feature
  card/screenshots meeting GitHub's image guidelines, and — regardless of
  whether the plan is free — a webhook configured for
  `marketplace_purchase` events (`purchased`/`changed`/`cancelled`
  actions) so the publisher is notified of plan changes. Paid plans
  additionally require the owning account to be a **verified publisher**
  and the app to have **at least 100 installations** before a paid plan can
  go live.

## What's real and running vs what needs the account owner

**Built and verified in this sandbox:**
- `npm install` — succeeds, 96 packages, real `@octokit/auth-app`,
  `@octokit/rest`, `express`, `dotenv` from the npm registry.
- `node --check` passes on every `.js` file (`server.js`, all of `lib/`,
  all of `test/`, `scripts/smoke-test.js`).
- `npm test` — 14 unit tests, all passing (`node:test`): signature
  verification (accept, wrong secret, tampered body, missing header, missing
  configured secret, non-Buffer input, missing `sha256=` prefix) and event
  routing (`workflow_run` non-failure/non-completed cases ignored,
  `issue_comment` without the slash command ignored, unrelated event types
  ignored, slash-command regex parsing incl. multiline/case-insensitivity).
- **The webhook signature-verification code path was actually exercised
  end-to-end, not bypassed**: `npm run smoke` starts the real `server.js` as
  a child process and fires real HTTP `POST /webhook` requests at it with a
  genuinely HMAC-SHA256-computed `X-Hub-Signature-256` header over
  real-documented-shape `issue_comment` and `workflow_run` JSON payloads
  (fields matching what's cited above from GitHub's webhook payload docs).
  Results, all passing:
  ```
  PASS  valid signature / issue_comment slash command   (status=202)
  PASS  valid signature / workflow_run failure            (status=202)
  PASS  wrong-secret signature is rejected                 (status=401)
  PASS  missing signature header is rejected                (status=401)
  PASS  tampered body invalidates prior signature             (status=401)
  ```
  The tampered-body case reuses the signature from a *different*,
  previously-valid payload against a modified body — confirming the
  comparison is against the actual bytes received, not just "a signature
  header is present."
- After the 202 ack, the async handler chain (JWT-sign attempt ->
  `@octokit/auth-app`) does run for real against the smoke test's
  intentionally-fake PEM, and fails exactly where expected —
  `error:1E08010C:DECODER routines::unsupported` from Node's own
  `crypto.createPrivateKey`, thrown inside `universal-github-app-jwt`
  (the library `@octokit/auth-app` uses internally) — confirming the JWT
  step is real code, not a stub, and that failures there are caught by
  `server.js`'s `.catch(...)` rather than crashing the process or corrupting
  the already-sent HTTP response.

**Not done — needs a real GitHub account/App and a real Anakin key:**
- **No real GitHub App was ever registered.** The manifest flow needs a
  publicly reachable `hook_attributes.url`/`redirect_url` (a deployed host,
  or a tunnel like ngrok/smee.io during dev) and a human confirming creation
  in GitHub's UI — neither exists in this sandbox.
- **No real webhook delivery from GitHub was ever received.** Everything
  above is this server responding to a locally-constructed request shaped
  like GitHub's documented payload — not a live delivery from
  `api.github.com`'s webhook dispatcher, which is the remaining gap between
  "the code is correct against the docs" and "this works in production."
- **No real installation access token, issue, or comment was created.**
  The GitHub REST calls in `handleWorkflowRunFailure`/`handleSlashCommand`
  were never exercised against a real `api.github.com` — only unit-tested
  for routing logic, and smoke-tested up to (and including) their real
  failure at the JWT-signing step with a fake key.
- **No real Anakin API key was used** — `anakin-client.js`'s request/response
  shapes are transcribed from `anakin-py`'s `client.py`/`models.py`, the same
  "read the real SDK source, not guessed" standard as this session's other
  submissions, but never confirmed against a live `200` from
  `api.anakin.io`.
- **No GitHub Marketplace listing was drafted or submitted.** That needs:
  the app owned by an org, a public GitHub repo the App's homepage can point
  to, a logo/feature card/screenshots, a privacy policy + ToS page, a
  support email, at least one pricing plan (free is acceptable), and —
  before submission is even possible — acceptance of the GitHub Marketplace
  Developer Agreement, none of which are engineering tasks this session can
  do on the account owner's behalf.
- **No `marketplace_purchase` webhook handling implemented.** Required for
  *any* Marketplace listing per the requirements cited above (even free
  plans must handle purchase/cancellation events), not implemented here
  since it only matters once an actual Marketplace listing exists to
  configure it against — flagged in README's "Known limitations", not
  silently omitted.

## Steps (needs the account owner)

1. Deploy `server.js` somewhere with a stable public URL (or run locally
   behind a tunnel for testing) and set real env vars from `.env.example`.
2. Edit `app.yml`, replacing `<your-deployed-host>` with the real hostname.
3. Run the manifest flow: JSON-encode `app.yml` and POST it to
   `github.com/settings/apps/new` (or the org URL), per the flow documented
   in `app.yml`'s header comment. Save the App ID / private key / webhook
   secret from the `/app-manifests/{code}/conversions` response into the
   deployed server's env.
4. Install the App on a test repo, push a failing workflow run, confirm a
   real issue gets filed and a real Anakin-research comment follows; test
   `/anakin-search <query>` on an issue.
5. For Marketplace: enroll as a GitHub Marketplace developer, accept the
   Developer Agreement, draft the listing (logo, screenshots, privacy
   policy, ToS, support contact, at least one pricing plan), add
   `marketplace_purchase` webhook handling, and submit for GitHub's review.
