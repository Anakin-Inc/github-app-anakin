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
    const match = SLASH_COMMAND_RE.exec((payload.comment && payload.comment.body) || "");
    if (match) {
      return handleSlashCommand(payload, match[1].trim(), ctx);
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
  SLASH_COMMAND_RE,
};
