"use strict";

require("dotenv").config();

const express = require("express");
const { verifySignature } = require("./lib/verify-signature");
const { getInstallationOctokit } = require("./lib/github-auth");
const { AnakinClient } = require("./lib/anakin-client");

const PORT = process.env.PORT || 3000;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_PRIVATE_KEY = (process.env.GITHUB_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const ANAKIN_API_KEY = process.env.ANAKIN_API_KEY;
const ANAKIN_BASE_URL = process.env.ANAKIN_BASE_URL || "https://api.anakin.io/v1";

const SLASH_COMMAND_RE = /^\/anakin-search\s+(.+)$/im;

// Additional slash commands. Each requires whitespace immediately after its
// command word before any argument, so overlapping prefixes (e.g.
// `/anakin-wire` vs `/anakin-wire-catalog`, `/anakin-ai-visibility` vs
// `/anakin-ai-visibility-sources`) never cross-match — the shorter command's
// regex only matches when the next character is whitespace/end-of-line, not
// a literal `-`. Like SLASH_COMMAND_RE, arguments are single-line (`.` does
// not match `\n`).
const WIRE_DISCOVER_RE = /^\/anakin-wire\s+(.+)$/im;
const WIRE_CATALOG_RE = /^\/anakin-wire-catalog(?:\s+(\S+))?\s*$/im;
const WIRE_RUN_RE = /^\/anakin-wire-run\s+(\S+)(?:\s+(.+))?$/im;
const AI_VISIBILITY_SOURCES_RE = /^\/anakin-ai-visibility-sources\s*$/im;
const AI_VISIBILITY_SEARCH_RE = /^\/anakin-ai-visibility\s+(.+)$/im;
const MONITORS_RE = /^\/anakin-monitors(?:\s+(\S+))?\s*$/im;
const MONITOR_CHANGES_RE = /^\/anakin-monitor-changes\s+(\S+)$/im;
const SESSIONS_RE = /^\/anakin-sessions(?:\s+(\S+))?\s*$/im;
const MAP_RE = /^\/anakin-map\s+(\S+)$/im;
const CRAWL_RE = /^\/anakin-crawl\s+(\S+)$/im;

// Monitor API responses include an `alertWebhookSecret` (an HMAC signing
// secret for that monitor's alert webhook). Issue comments are frequently
// public, so — mirroring anakin-mcp's own `monitor.ts` redactSecrets() —
// that field is stripped before anything reaches a comment body; the real
// value stays retrievable only from the Anakin dashboard.
const MONITOR_SECRET_KEYS = new Set(["alertWebhookSecret"]);
const MONITOR_SECRET_REDACTED = "[redacted — view in the Anakin dashboard]";

function redactMonitorSecrets(value) {
  if (Array.isArray(value)) return value.map(redactMonitorSecrets);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = MONITOR_SECRET_KEYS.has(k) && v ? MONITOR_SECRET_REDACTED : redactMonitorSecrets(v);
    }
    return out;
  }
  return value;
}

function buildAnakinClient() {
  return new AnakinClient({ apiKey: ANAKIN_API_KEY, baseUrl: ANAKIN_BASE_URL });
}

function log(deliveryId, ...args) {
  // eslint-disable-next-line no-console
  console.log(`[github-app-anakin]${deliveryId ? ` [${deliveryId}]` : ""}`, ...args);
}

function logError(deliveryId, ...args) {
  // eslint-disable-next-line no-console
  console.error(`[github-app-anakin]${deliveryId ? ` [${deliveryId}]` : ""}`, ...args);
}

/**
 * Pretty-print a value as a fenced JSON code block for a comment body,
 * truncated so a large response (e.g. a big Wire catalog or crawl result)
 * can't blow past GitHub's comment size limit.
 */
function formatJsonBlock(value, { maxLen = 6000 } = {}) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}\n… truncated (${text.length - maxLen} more characters)`;
  }
  return "```json\n" + text + "\n```";
}

// ─── Event handlers ─────────────────────────────────────────────────────────

/**
 * `workflow_run` / action=completed / conclusion=failure:
 *   1. Look up the failed job + step (a cheap, structured stand-in for full
 *      log content — see README's "Known limitations" for why this
 *      integration doesn't download/unzip the full log archive).
 *   2. File a GitHub issue immediately (fast path — this is what makes the
 *      webhook ack meaningful even before Anakin's research finishes).
 *   3. Kick off `agenticSearch` (can take up to minutes) and post the
 *      findings as a follow-up comment on that issue once it resolves.
 */
async function handleWorkflowRunFailure(payload, { deliveryId } = {}) {
  const installationId = payload.installation && payload.installation.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const run = payload.workflow_run;

  if (!installationId) {
    logError(deliveryId, "workflow_run payload missing installation.id — cannot authenticate, skipping");
    return;
  }

  const octokit = await getInstallationOctokit({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    installationId,
  });

  const { data: jobsData } = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
    { owner, repo, run_id: run.id }
  );
  const failedJob = (jobsData.jobs || []).find((j) => j.conclusion === "failure");
  const failedStep = failedJob && (failedJob.steps || []).find((s) => s.conclusion === "failure");

  const { data: issue } = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title: `CI failure: ${run.name} — ${failedJob ? failedJob.name : "unknown job"} (run #${run.run_number})`,
    body: [
      `Workflow **${run.name}** failed on \`${run.head_branch}\` (\`${run.head_sha.slice(0, 7)}\`).`,
      "",
      `- Run: ${run.html_url}`,
      failedJob ? `- Job: ${failedJob.name} (${failedJob.html_url})` : null,
      failedStep ? `- Step: ${failedStep.name}` : null,
      "",
      "_Anakin is researching this failure — findings will follow as a comment on this issue._",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    labels: ["ci-failure", "anakin-auto"],
  });

  log(deliveryId, `filed issue #${issue.number} for failed run ${run.id}`);

  const anakin = buildAnakinClient();
  const prompt = [
    `A GitHub Actions workflow run failed in ${owner}/${repo}.`,
    `Workflow: "${run.name}".`,
    failedJob ? `Job: "${failedJob.name}".` : null,
    failedStep ? `Failing step: "${failedStep.name}".` : null,
    "Research the likely cause of this failure by searching recent GitHub issues, release notes, " +
      "and documentation for this error signature. Summarize the most probable root causes and " +
      "concrete fixes a maintainer could try next.",
  ]
    .filter((line) => line !== null)
    .join(" ");

  let commentBody;
  try {
    const job = await anakin.agenticSearch(prompt);
    const summary = job.generatedJson && job.generatedJson.summary;
    commentBody = `### Anakin research findings\n\n${summary || "_Anakin returned no summary._"}`;
  } catch (err) {
    logError(deliveryId, "agenticSearch failed:", err.message);
    commentBody = `Anakin research could not complete: ${err.message}`;
  }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: issue.number,
    body: commentBody,
  });
  log(deliveryId, `posted findings comment on issue #${issue.number}`);
}

/**
 * `issue_comment` / action=created, body matching `/anakin-search <query>`:
 * a lighter, synchronous alternative to the workflow_run path — calls
 * Anakin's plain `search` endpoint (no polling) and replies with results.
 */
async function handleSlashCommand(payload, query, { deliveryId } = {}) {
  const installationId = payload.installation && payload.installation.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;

  if (!installationId) {
    logError(deliveryId, "issue_comment payload missing installation.id — cannot authenticate, skipping");
    return;
  }

  const octokit = await getInstallationOctokit({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    installationId,
  });

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.search(query, { limit: 5 });
    const lines = (result.results || []).map((r, i) => {
      const label = r.title || r.url;
      const snippet = r.snippet ? ` — ${r.snippet}` : "";
      return `${i + 1}. [${label}](${r.url})${snippet}`;
    });
    body = `### Anakin search: "${query}"\n\n${lines.length ? lines.join("\n") : "No results."}`;
  } catch (err) {
    logError(deliveryId, "search failed:", err.message);
    body = `Anakin search failed: ${err.message}`;
  }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  log(deliveryId, `replied to /anakin-search on issue #${issueNumber}`);
}

// ─── New capability handlers ─────────────────────────────────────────────
//
// All of the commands below share the same shape as handleSlashCommand:
// authenticate as the installation, call one Anakin endpoint, and reply as
// an issue comment. Factored into two small helpers so each handler stays
// focused on formatting its own reply.

/**
 * Resolves installation auth + the (owner, repo, issueNumber) triple every
 * issue_comment handler needs. Returns null (having logged) when the
 * payload can't be authenticated, mirroring handleSlashCommand's own guard.
 */
async function authenticateForIssueComment(payload, { deliveryId } = {}) {
  const installationId = payload.installation && payload.installation.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;

  if (!installationId) {
    logError(deliveryId, "issue_comment payload missing installation.id — cannot authenticate, skipping");
    return null;
  }

  const octokit = await getInstallationOctokit({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    installationId,
  });

  return { octokit, owner, repo, issueNumber };
}

async function replyToIssue(octokit, owner, repo, issueNumber, body) {
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

/**
 * `/anakin-wire <query>`: natural-language search over Wire's catalog of
 * pre-built site actions (GET /wire/resolve). A natural fit for "is there a
 * known action for this site/task" lookups from an issue thread.
 */
async function handleWireDiscoverCommand(payload, query, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.wireDiscover(query, { limit: 5 });
    body = [
      `### Anakin Wire: actions for "${query}"`,
      "",
      formatJsonBlock(result),
      "",
      "Run a read (data-extraction) action with `/anakin-wire-run <action_id> [json params]`.",
    ].join("\n");
  } catch (err) {
    logError(ctx.deliveryId, "wireDiscover failed:", err.message);
    body = `Anakin Wire discovery failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-wire on issue #${issueNumber}`);
}

/**
 * `/anakin-wire-catalog [slug]`: browse the Wire catalog (GET /wire/catalog
 * or /wire/catalog/:slug).
 */
async function handleWireCatalogCommand(payload, slug, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.wireCatalog(slug);
    const heading = slug ? `### Anakin Wire catalog: ${slug}` : "### Anakin Wire catalog";
    body = `${heading}\n\n${formatJsonBlock(result)}`;
  } catch (err) {
    logError(ctx.deliveryId, "wireCatalog failed:", err.message);
    body = `Anakin Wire catalog lookup failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-wire-catalog on issue #${issueNumber}`);
}

/**
 * `/anakin-wire-run <action_id> [json params]`: run a Wire action
 * (POST /wire/task, transparently polled to completion). `params`, if
 * given, must be a single line of valid JSON.
 *
 * Intended for READ (data-extraction) actions only — confirm an action's
 * `type` is "read" via `/anakin-wire` or `/anakin-wire-catalog` first. The
 * underlying API does not itself distinguish read from write (that split is
 * a tool-schema convention in Anakin's MCP server, see lib/anakin-client.js);
 * this app does not attempt to enforce it, so a `/anakin-wire-run` against a
 * write action's action_id would execute it. Not a concern in practice for
 * this app's supported command set — `wire_write_action`/`wire_login`/
 * `wire_build` are deliberately not exposed as their own commands (see
 * README) — but worth calling out explicitly rather than silently assuming
 * safety.
 */
async function handleWireRunCommand(payload, actionId, paramsJson, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch (err) {
      await replyToIssue(
        octokit,
        owner,
        repo,
        issueNumber,
        `Anakin Wire run of \`${actionId}\` failed: params must be valid single-line JSON — ${err.message}`
      );
      return;
    }
  }

  const anakin = buildAnakinClient();
  let body;
  try {
    const job = await anakin.wireRun(actionId, params);
    body = `### Anakin Wire: ran \`${actionId}\`\n\n${formatJsonBlock(job)}`;
  } catch (err) {
    logError(ctx.deliveryId, "wireRun failed:", err.message);
    body = `Anakin Wire run of \`${actionId}\` failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-wire-run on issue #${issueNumber}`);
}

/**
 * `/anakin-ai-visibility-sources`: list the AI answer engines available to
 * `/anakin-ai-visibility` (GET /ai-visibility/sources).
 */
async function handleAiVisibilitySourcesCommand(payload, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.aiVisibilitySources();
    body = `### Anakin AI visibility: available sources\n\n${formatJsonBlock(result)}`;
  } catch (err) {
    logError(ctx.deliveryId, "aiVisibilitySources failed:", err.message);
    body = `Anakin AI visibility sources lookup failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-ai-visibility-sources on issue #${issueNumber}`);
}

/**
 * `/anakin-ai-visibility <query>`: ask multiple AI answer engines (ChatGPT,
 * Gemini, Google AI Overview, ...) the same question and compare answers
 * (POST /ai-visibility/search, transparently polled to completion). Each
 * result's large `full_content` field is stripped — the summary/synthesis
 * fields answer most questions and keep the comment body a sane size.
 */
async function handleAiVisibilitySearchCommand(payload, query, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const search = await anakin.aiVisibilitySearch(query);
    const results = (search.results || []).map((r) => {
      if (!r || typeof r !== "object") return r;
      const { full_content, ...rest } = r;
      return rest;
    });
    body = [
      `### Anakin AI visibility: "${query}"`,
      "",
      `Status: ${search.status}`,
      search.synthesis ? `\n**Synthesis:** ${search.synthesis}` : null,
      "",
      formatJsonBlock(results),
    ]
      .filter((line) => line !== null)
      .join("\n");
  } catch (err) {
    logError(ctx.deliveryId, "aiVisibilitySearch failed:", err.message);
    body = `Anakin AI visibility search failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-ai-visibility on issue #${issueNumber}`);
}

/**
 * `/anakin-monitors [id]`: list website monitors, or fetch one by id
 * (GET /monitors or /monitors/:id). Response is passed through
 * redactMonitorSecrets() first — see its definition above.
 */
async function handleMonitorsCommand(payload, id, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = id ? await anakin.monitorGet(id) : await anakin.monitorList();
    const heading = id ? `### Anakin monitor: ${id}` : "### Anakin monitors";
    body = `${heading}\n\n${formatJsonBlock(redactMonitorSecrets(result))}`;
  } catch (err) {
    logError(ctx.deliveryId, "monitor lookup failed:", err.message);
    body = `Anakin monitor lookup failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-monitors on issue #${issueNumber}`);
}

/**
 * `/anakin-monitor-changes <id>`: detected changes for a monitor
 * (GET /monitors/:id/changes). Also redacted — see redactMonitorSecrets().
 */
async function handleMonitorChangesCommand(payload, id, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.monitorChanges(id);
    body = `### Anakin monitor changes: ${id}\n\n${formatJsonBlock(redactMonitorSecrets(result))}`;
  } catch (err) {
    logError(ctx.deliveryId, "monitorChanges failed:", err.message);
    body = `Anakin monitor-changes lookup for \`${id}\` failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-monitor-changes on issue #${issueNumber}`);
}

/**
 * `/anakin-sessions [domain]`: list saved browser sessions, optionally
 * filtered to one domain (GET /sessions?domain=).
 */
async function handleSessionsCommand(payload, domain, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.sessionsList(domain);
    const heading = domain ? `### Anakin browser sessions: ${domain}` : "### Anakin browser sessions";
    body = `${heading}\n\n${formatJsonBlock(result)}`;
  } catch (err) {
    logError(ctx.deliveryId, "sessionsList failed:", err.message);
    body = `Anakin sessions lookup failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-sessions on issue #${issueNumber}`);
}

/**
 * `/anakin-map <url>`: discover reachable URLs under a site
 * (POST /map, transparently polled to completion). Useful for "what's on
 * this site" before deciding whether/what to crawl.
 */
async function handleMapCommand(payload, url, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.map(url, { limit: 100 });
    const links = result.links || [];
    const shown = links.slice(0, 30);
    body = [
      `### Anakin map: ${url}`,
      "",
      `${result.totalLinks ?? links.length} internal link(s), ${result.totalExternalLinks ?? 0} external.`,
      "",
      ...shown.map((l) => `- ${l}`),
      links.length > shown.length ? `\n… and ${links.length - shown.length} more.` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
  } catch (err) {
    logError(ctx.deliveryId, "map failed:", err.message);
    body = `Anakin map of ${url} failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-map on issue #${issueNumber}`);
}

/**
 * `/anakin-crawl <url>`: bulk-fetch markdown across a site
 * (POST /crawl, transparently polled to completion). Capped to Anakin's
 * default 10-page budget — this app doesn't expose maxPages from a comment
 * to keep a single command from triggering a very large, slow crawl.
 */
async function handleCrawlCommand(payload, url, ctx = {}) {
  const auth = await authenticateForIssueComment(payload, ctx);
  if (!auth) return;
  const { octokit, owner, repo, issueNumber } = auth;

  const anakin = buildAnakinClient();
  let body;
  try {
    const result = await anakin.crawl(url, { maxPages: 10 });
    const pages = result.pages || [];
    const shown = pages.slice(0, 20);
    body = [
      `### Anakin crawl: ${url}`,
      "",
      `${result.completedPages ?? pages.length}/${result.totalPages ?? pages.length} page(s) fetched.`,
      "",
      ...shown.map((p) => `- [${p.status}] ${p.url}`),
      pages.length > shown.length ? `\n… and ${pages.length - shown.length} more.` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
  } catch (err) {
    logError(ctx.deliveryId, "crawl failed:", err.message);
    body = `Anakin crawl of ${url} failed: ${err.message}`;
  }

  await replyToIssue(octokit, owner, repo, issueNumber, body);
  log(ctx.deliveryId, `replied to /anakin-crawl on issue #${issueNumber}`);
}

// Dispatch table for issue_comment slash commands, tried in order; the
// first regex to match a comment body wins. Kept as data (rather than an
// if/else chain) so adding a command is a one-line addition here.
const SLASH_COMMANDS = [
  { re: SLASH_COMMAND_RE, run: (payload, m, ctx) => handleSlashCommand(payload, m[1].trim(), ctx) },
  { re: WIRE_DISCOVER_RE, run: (payload, m, ctx) => handleWireDiscoverCommand(payload, m[1].trim(), ctx) },
  {
    re: WIRE_CATALOG_RE,
    run: (payload, m, ctx) => handleWireCatalogCommand(payload, m[1] ? m[1].trim() : undefined, ctx),
  },
  {
    re: WIRE_RUN_RE,
    run: (payload, m, ctx) =>
      handleWireRunCommand(payload, m[1].trim(), m[2] ? m[2].trim() : undefined, ctx),
  },
  { re: AI_VISIBILITY_SOURCES_RE, run: (payload, _m, ctx) => handleAiVisibilitySourcesCommand(payload, ctx) },
  {
    re: AI_VISIBILITY_SEARCH_RE,
    run: (payload, m, ctx) => handleAiVisibilitySearchCommand(payload, m[1].trim(), ctx),
  },
  {
    re: MONITORS_RE,
    run: (payload, m, ctx) => handleMonitorsCommand(payload, m[1] ? m[1].trim() : undefined, ctx),
  },
  {
    re: MONITOR_CHANGES_RE,
    run: (payload, m, ctx) => handleMonitorChangesCommand(payload, m[1].trim(), ctx),
  },
  {
    re: SESSIONS_RE,
    run: (payload, m, ctx) => handleSessionsCommand(payload, m[1] ? m[1].trim() : undefined, ctx),
  },
  { re: MAP_RE, run: (payload, m, ctx) => handleMapCommand(payload, m[1].trim(), ctx) },
  { re: CRAWL_RE, run: (payload, m, ctx) => handleCrawlCommand(payload, m[1].trim(), ctx) },
];

/**
 * Routes a verified, parsed webhook payload to the right handler. Exported
 * separately from the Express route so it can be unit tested without an
 * HTTP round trip.
 */
async function handleEvent(eventName, payload, ctx = {}) {
  if (
    eventName === "workflow_run" &&
    payload.action === "completed" &&
    payload.workflow_run &&
    payload.workflow_run.conclusion === "failure"
  ) {
    return handleWorkflowRunFailure(payload, ctx);
  }

  if (eventName === "issue_comment" && payload.action === "created") {
    const body = (payload.comment && payload.comment.body) || "";
    for (const command of SLASH_COMMANDS) {
      const match = command.re.exec(body);
      if (match) {
        return command.run(payload, match, ctx);
      }
    }
  }

  // All other events/actions are intentionally ignored (we only ever
  // subscribe to workflow_run + issue_comment per app.yml's default_events).
  return null;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

// `express.raw` (not `express.json`) so `req.body` is the exact byte buffer
// GitHub signed — verifying a re-serialized JSON.stringify of the parsed
// object would silently break on any whitespace/key-order difference.
app.post("/webhook", express.raw({ type: "application/json", limit: "2mb" }), (req, res) => {
  const deliveryId = req.header("X-GitHub-Delivery");
  const eventName = req.header("X-GitHub-Event");
  const signature = req.header("X-Hub-Signature-256");

  if (!verifySignature(req.body, signature, GITHUB_WEBHOOK_SECRET)) {
    logError(deliveryId, "signature verification failed — rejecting delivery");
    res.status(401).json({ error: "signature verification failed" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    logError(deliveryId, "invalid JSON body:", err.message);
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  // Ack immediately. GitHub expects a fast response (its own guidance is to
  // return 2xx quickly and do slow work asynchronously); `agenticSearch`
  // alone can take up to the poll budget (default 240s), far past what a
  // webhook delivery should be left waiting on.
  res.status(202).json({ ok: true, event: eventName, deliveryId });

  handleEvent(eventName, payload, { deliveryId }).catch((err) => {
    logError(deliveryId, `unhandled error processing ${eventName}:`, err && err.stack ? err.stack : err);
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    log(null, `listening on :${PORT}`);
  });
}

module.exports = {
  app,
  verifySignature,
  handleEvent,
  handleWorkflowRunFailure,
  handleSlashCommand,
  handleWireDiscoverCommand,
  handleWireCatalogCommand,
  handleWireRunCommand,
  handleAiVisibilitySourcesCommand,
  handleAiVisibilitySearchCommand,
  handleMonitorsCommand,
  handleMonitorChangesCommand,
  handleSessionsCommand,
  handleMapCommand,
  handleCrawlCommand,
  SLASH_COMMAND_RE,
  WIRE_DISCOVER_RE,
  WIRE_CATALOG_RE,
  WIRE_RUN_RE,
  AI_VISIBILITY_SOURCES_RE,
  AI_VISIBILITY_SEARCH_RE,
  MONITORS_RE,
  MONITOR_CHANGES_RE,
  SESSIONS_RE,
  MAP_RE,
  CRAWL_RE,
};
