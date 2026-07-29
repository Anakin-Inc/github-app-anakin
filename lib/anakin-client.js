"use strict";

/**
 * Minimal Anakin API client — just the two endpoints this integration uses.
 *
 * Ground truth read directly from the real SDK, not guessed:
 *   /Users/arun/Anakin/anakin-py/src/anakin/client.py  (endpoints, request/response shapes)
 *   /Users/arun/Anakin/anakin-py/src/anakin/_http.py   (base URL, auth header, error body shapes)
 *   /Users/arun/Anakin/anakin-py/src/anakin/models.py  (field names)
 *
 * - Base URL: https://api.anakin.io/v1
 * - Auth: `X-API-Key: <key>` header (not Bearer, not OAuth)
 * - POST /search              -> synchronous, {id, results: [{url, title, snippet, date, lastUpdated}]}
 * - POST /agentic-search      -> submits a job, returns {jobId}
 * - GET  /agentic-search/:id  -> poll; body.status in {pending, processing, completed, failed};
 *                                terminal states are "completed" | "failed";
 *                                on completed, body.generatedJson = {summary, structuredData, dataSchema}
 * - Error bodies come in two shapes (per _http.py's `_extract_error`):
 *     A. {"error": "code_string", "message": "..."}
 *     B. {"status": "error", "error": {"code": "...", "message": "..."}}
 */

const DEFAULT_BASE_URL = "https://api.anakin.io/v1";

// Poll cadence for the newer endpoints below (wire/map/crawl/ai-visibility).
// Matches anakin-mcp's own client (`anakin-mcp/src/client.ts`:
// POLL_INTERVAL_MS / POLL_MAX_ATTEMPTS) — a fixed 3s interval, 60 attempts
// (3 minutes total). Deliberately not reused for `search`/`agenticSearch`
// above, whose existing exponential-backoff/240s-budget polling predates
// this and is left untouched.
const JOB_POLL_INTERVAL_MS = 3000;
const JOB_POLL_MAX_ATTEMPTS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(body, fallback) {
  if (!body || typeof body !== "object") return fallback;
  const err = body.error;
  if (err && typeof err === "object") return err.message || fallback;
  if (typeof err === "string") return body.message || fallback;
  return body.message || fallback;
}

class AnakinClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests.
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error("ANAKIN_API_KEY is not set");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this._fetch = fetchImpl;
  }

  _headers(extra = {}) {
    return {
      "X-API-Key": this.apiKey,
      "User-Agent": "github-app-anakin/1.0.0",
      Accept: "application/json",
      ...extra,
    };
  }

  async _requestJson(res, context) {
    let body = {};
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    if (!res.ok) {
      const message = extractErrorMessage(body, res.statusText || "Unknown error");
      throw new Error(`${context} failed: HTTP ${res.status} — ${message}`);
    }
    return body;
  }

  /**
   * AI-powered web search. Synchronous — no polling. Costs 3 credits per call
   * (per client.py's docstring).
   *
   * @param {string} prompt
   * @param {number} [limit]
   */
  async search(prompt, { limit = 5 } = {}) {
    const res = await this._fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prompt, limit }),
    });
    return this._requestJson(res, "Anakin /search");
  }

  /**
   * Multi-stage AI research pipeline. Submits POST /agentic-search then polls
   * GET /agentic-search/:jobId until status is "completed" or "failed".
   * Costs 10 credits (per client.py's docstring).
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @param {boolean} [opts.useBrowser]
   * @param {object} [opts.schema]
   * @param {number} [opts.pollIntervalMs] - initial poll delay (default 3s, matches tray-anakin's handler).
   * @param {number} [opts.pollMaxIntervalMs]
   * @param {number} [opts.pollTimeoutMs] - total wall-clock budget before giving up.
   */
  async agenticSearch(
    prompt,
    {
      useBrowser = true,
      schema,
      pollIntervalMs = 3000,
      pollMaxIntervalMs = 10000,
      pollTimeoutMs = 240000,
    } = {}
  ) {
    const body = { prompt, useBrowser };
    if (schema) body.schema = schema;

    const submitRes = await this._fetch(`${this.baseUrl}/agentic-search`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /agentic-search submit");

    const jobId = submitted.jobId || submitted.job_id || submitted.id;
    if (!jobId) {
      throw new Error(
        `Anakin /agentic-search submit response did not include a jobId: ${JSON.stringify(
          submitted
        )}`
      );
    }

    const deadline = Date.now() + pollTimeoutMs;
    let wait = pollIntervalMs;
    let attempts = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts += 1;
      const pollRes = await this._fetch(`${this.baseUrl}/agentic-search/${jobId}`, {
        headers: this._headers(),
      });
      const job = await this._requestJson(pollRes, "Anakin /agentic-search poll");

      if (job.status === "completed") {
        return job;
      }
      if (job.status === "failed") {
        throw new Error(`Anakin agentic-search job ${jobId} failed: ${job.error || "unknown error"}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Anakin agentic-search job ${jobId} did not complete within ${pollTimeoutMs}ms (${attempts} polls)`
        );
      }
      await sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 1.5, pollMaxIntervalMs);
    }
  }

  // ─── Additional endpoints ─────────────────────────────────────────────
  //
  // Ground truth for everything below read directly from anakin-mcp's own
  // TypeScript SDK (not guessed, not the anakin-py source cited above):
  //   /Users/arun/Anakin/anakin-mcp/src/client.ts     (endpoints, poll semantics)
  //   /Users/arun/Anakin/anakin-mcp/src/tools/*.ts    (param defaults, response shapes)

  async _get(path, context) {
    const res = await this._fetch(`${this.baseUrl}${path}`, { headers: this._headers() });
    return this._requestJson(res, context);
  }

  async _post(path, body, context) {
    const res = await this._fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this._requestJson(res, context);
  }

  /** Poll a `{jobId}`-style job (map/crawl) to a terminal state. */
  async _pollJobStatus(path, context) {
    for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt += 1) {
      const job = await this._get(path, context);
      if (job.status === "completed") return job;
      if (job.status === "failed") {
        throw new Error(`${context} job failed: ${job.error || "unknown error"}`);
      }
      await sleep(JOB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `${context} did not complete within ${(JOB_POLL_MAX_ATTEMPTS * JOB_POLL_INTERVAL_MS) / 1000}s`
    );
  }

  // ── Wire: discovery ─────────────────────────────────────────────────

  /**
   * Natural-language intent -> ranked candidate Wire actions.
   * GET /wire/resolve?q=&limit= (client.ts: `wireResolve`).
   *
   * @param {string} q
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  async wireDiscover(q, { limit } = {}) {
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set("limit", String(limit));
    return this._get(`/wire/resolve?${params.toString()}`, "Anakin /wire/resolve");
  }

  /**
   * Browse the Wire catalog: every site (no slug), or one site's full
   * action list + param schemas (with slug).
   * GET /wire/catalog or GET /wire/catalog/:slug.
   *
   * @param {string} [slug]
   */
  async wireCatalog(slug) {
    const path = slug ? `/wire/catalog/${encodeURIComponent(slug)}` : "/wire/catalog";
    return this._get(path, "Anakin /wire/catalog");
  }

  // ── Wire: execution (read actions only — see README) ───────────────

  /**
   * Run a Wire action: POST /wire/task {action_id, params?}, then poll
   * GET /wire/jobs/:jobId to a terminal state (honoring the server's
   * `retry_after_ms` pacing hint, per client.ts's `pollWireJob`). Sync
   * actions return their data inline (no `job_id`) and are returned as-is.
   *
   * Anakin's own MCP server splits this one underlying call into two tools
   * — `wire_read_action` / `wire_write_action` — purely as a tool-schema
   * safety annotation (readOnlyHint vs destructiveHint); the API itself
   * does not enforce the split. This app only ever calls it in the
   * `wire_read_action` sense (see the `/anakin-wire-run` command docs) and
   * does not attempt to verify an action's type before running it.
   *
   * @param {string} actionId
   * @param {object} [params]
   * @param {object} [opts]
   * @param {string} [opts.credentialId]
   * @param {string} [opts.identityId]
   */
  async wireRun(actionId, params = {}, { credentialId, identityId } = {}) {
    const body = { action_id: actionId };
    if (params && Object.keys(params).length > 0) body.params = params;
    if (credentialId) body.credential_id = credentialId;
    if (identityId) body.identity_id = identityId;

    const accepted = await this._post("/wire/task", body, "Anakin /wire/task submit");
    if (!accepted.job_id) {
      // Sync action: terminal data came back inline.
      return accepted;
    }

    const path = `/wire/jobs/${accepted.job_id}`;
    for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt += 1) {
      const job = await this._get(path, "Anakin /wire/jobs poll");
      if (job.status === "completed") return job;
      if (job.status === "failed") {
        const reason = (job.error && (job.error.message || job.error.code)) || "unknown error";
        throw new Error(`Anakin wire job ${accepted.job_id} failed: ${reason}`);
      }
      const wait = typeof job.retry_after_ms === "number" ? job.retry_after_ms : JOB_POLL_INTERVAL_MS;
      await sleep(Math.min(Math.max(wait, 500), 10000));
    }
    throw new Error(`Anakin wire job ${accepted.job_id} did not complete within its poll budget`);
  }

  // ── AI Visibility ────────────────────────────────────────────────────

  /** Available AI engines ({slug, label} roster) for aiVisibilitySearch. GET /ai-visibility/sources. */
  async aiVisibilitySources() {
    return this._get("/ai-visibility/sources", "Anakin /ai-visibility/sources");
  }

  /**
   * Ask multiple AI answer engines the same query and compare answers.
   * POST /ai-visibility/search {query, sources?, country?}, then poll
   * GET /ai-visibility/search/:id while status is "running". Unlike a
   * plain job poll, a terminal "failed" status is returned (not thrown) —
   * per-source results/errors are useful either way.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string[]} [opts.sources]
   * @param {string} [opts.country]
   */
  async aiVisibilitySearch(query, { sources, country } = {}) {
    const body = { query };
    if (sources !== undefined) body.sources = sources;
    if (country !== undefined) body.country = country;

    const submitted = await this._post("/ai-visibility/search", body, "Anakin /ai-visibility/search submit");
    const path = `/ai-visibility/search/${encodeURIComponent(submitted.search_id)}`;
    for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt += 1) {
      const search = await this._get(path, "Anakin /ai-visibility/search poll");
      if (search.status !== "running") return search;
      await sleep(JOB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Anakin ai-visibility search ${submitted.search_id} timed out after ` +
        `${(JOB_POLL_MAX_ATTEMPTS * JOB_POLL_INTERVAL_MS) / 1000}s`
    );
  }

  // ── Website Monitoring (read-only surface) ──────────────────────────

  /** GET /monitors. */
  async monitorList() {
    return this._get("/monitors", "Anakin /monitors");
  }

  /** GET /monitors/:id. */
  async monitorGet(id) {
    return this._get(`/monitors/${encodeURIComponent(id)}`, "Anakin /monitors/:id");
  }

  /** GET /monitors/:id/changes. */
  async monitorChanges(id) {
    return this._get(`/monitors/${encodeURIComponent(id)}/changes`, "Anakin /monitors/:id/changes");
  }

  // ── Browser sessions (read-only surface) ────────────────────────────

  /** GET /sessions?domain=. */
  async sessionsList(domain) {
    const path = domain ? `/sessions?domain=${encodeURIComponent(domain)}` : "/sessions";
    return this._get(path, "Anakin /sessions");
  }

  // ── Site discovery / bulk fetch ──────────────────────────────────────

  /**
   * Discover reachable URLs under a site. POST /map, then poll GET /map/:jobId.
   *
   * @param {string} url
   * @param {object} [opts]
   */
  async map(url, opts = {}) {
    const body = {
      url,
      limit: opts.limit ?? 100,
      depth: opts.depth ?? 2,
      limitPerLevel: opts.limitPerLevel ?? 100,
      includeSubdomains: opts.includeSubdomains ?? false,
      includeExternalLinks: opts.includeExternalLinks ?? false,
      useBrowser: opts.useBrowser ?? false,
    };
    if (opts.search !== undefined) body.search = opts.search;

    const submitted = await this._post("/map", body, "Anakin /map submit");
    return this._pollJobStatus(`/map/${submitted.jobId}`, `Anakin /map/${submitted.jobId}`);
  }

  /**
   * Bulk-fetch markdown across a site. POST /crawl, then poll GET /crawl/:jobId.
   *
   * @param {string} url
   * @param {object} [opts]
   */
  async crawl(url, opts = {}) {
    const body = {
      url,
      maxPages: opts.maxPages ?? 10,
      depth: opts.depth ?? 1,
      country: opts.country ?? "us",
      useBrowser: opts.useBrowser ?? false,
    };
    if (opts.includePatterns) body.includePatterns = opts.includePatterns;
    if (opts.excludePatterns) body.excludePatterns = opts.excludePatterns;
    if (opts.sessionId !== undefined) body.sessionId = opts.sessionId;
    if (opts.sessionName !== undefined) body.sessionName = opts.sessionName;

    const submitted = await this._post("/crawl", body, "Anakin /crawl submit");
    return this._pollJobStatus(`/crawl/${submitted.jobId}`, `Anakin /crawl/${submitted.jobId}`);
  }
}

module.exports = { AnakinClient, DEFAULT_BASE_URL };
