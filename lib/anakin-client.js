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
}

module.exports = { AnakinClient, DEFAULT_BASE_URL };
