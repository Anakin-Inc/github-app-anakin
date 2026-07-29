"use strict";

/**
 * Starts the real server as a child process and fires real HTTP requests at
 * it with a genuinely-computed X-Hub-Signature-256 header — exercising the
 * actual signature-verification code path (both the accept and reject
 * branches), not a mock/bypass of it.
 *
 * Deliberately does NOT require real GitHub or Anakin credentials: the
 * webhook route acks (202) as soon as the signature check + JSON parse
 * succeed, then processes the event asynchronously. Downstream calls to
 * GitHub's/Anakin's real APIs will fail with fake credentials, but that
 * happens after the response we're asserting on has already been sent, and
 * is caught by server.js's `.catch(...)` — this script only asserts on the
 * synchronous HTTP behavior (status codes), and prints the child's stderr
 * so those async failures are visible, not hidden.
 *
 * Run: node scripts/smoke-test.js
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const PORT = 3917;
const WEBHOOK_SECRET = "smoke-test-secret";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Shaped like a real GitHub `issue_comment` "created" delivery — trimmed to
// the fields server.js's handlers actually read, per GitHub's documented
// payload (https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment).
const ISSUE_COMMENT_PAYLOAD = {
  action: "created",
  issue: {
    number: 42,
    title: "CI is flaky on main",
  },
  comment: {
    id: 1,
    body: "/anakin-search ERESOLVE unable to resolve dependency tree",
  },
  repository: {
    name: "example-repo",
    full_name: "octocat/example-repo",
    owner: { login: "octocat" },
  },
  installation: { id: 123456 },
  sender: { login: "octocat" },
};

// One issue_comment payload per new slash command added on top of
// /anakin-search, same shape as ISSUE_COMMENT_PAYLOAD above — only
// `comment.body` differs. Exercises the same signature-verification path
// for each new command's regex/dispatch route (server.js's SLASH_COMMANDS
// table), not just the original /anakin-search.
function issueCommentPayloadWithBody(body) {
  return {
    action: "created",
    issue: { number: 42, title: "CI is flaky on main" },
    comment: { id: 1, body },
    repository: {
      name: "example-repo",
      full_name: "octocat/example-repo",
      owner: { login: "octocat" },
    },
    installation: { id: 123456 },
    sender: { login: "octocat" },
  };
}

const NEW_COMMAND_PAYLOADS = [
  ["/anakin-wire <query>", issueCommentPayloadWithBody("/anakin-wire top phones on walmart")],
  ["/anakin-wire-catalog [slug]", issueCommentPayloadWithBody("/anakin-wire-catalog amazon")],
  [
    "/anakin-wire-run <action_id> [json]",
    issueCommentPayloadWithBody('/anakin-wire-run amazon.search_products {"query":"mouse"}'),
  ],
  ["/anakin-ai-visibility-sources", issueCommentPayloadWithBody("/anakin-ai-visibility-sources")],
  [
    "/anakin-ai-visibility <query>",
    issueCommentPayloadWithBody("/anakin-ai-visibility what is your return policy?"),
  ],
  ["/anakin-monitors [id]", issueCommentPayloadWithBody("/anakin-monitors")],
  ["/anakin-monitor-changes <id>", issueCommentPayloadWithBody("/anakin-monitor-changes mon_123")],
  ["/anakin-sessions [domain]", issueCommentPayloadWithBody("/anakin-sessions amazon.com")],
  ["/anakin-map <url>", issueCommentPayloadWithBody("/anakin-map https://example.com")],
  ["/anakin-crawl <url>", issueCommentPayloadWithBody("/anakin-crawl https://example.com")],
];

// Shaped like a real `workflow_run` "completed"/failure delivery
// (https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run).
const WORKFLOW_RUN_PAYLOAD = {
  action: "completed",
  workflow_run: {
    id: 987654321,
    name: "CI",
    run_number: 42,
    head_branch: "main",
    head_sha: "abc123def4567890",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/octocat/example-repo/actions/runs/987654321",
  },
  repository: {
    name: "example-repo",
    full_name: "octocat/example-repo",
    owner: { login: "octocat" },
  },
  installation: { id: 123456 },
  sender: { login: "octocat" },
};

function hmacSign(bodyBuffer, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex");
}

async function postWebhook({ event, payload, secretForSignature, signatureOverride }) {
  const bodyBuffer = Buffer.from(JSON.stringify(payload));
  const signature =
    signatureOverride !== undefined ? signatureOverride : hmacSign(bodyBuffer, secretForSignature);

  const res = await fetch(`${BASE_URL}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": crypto.randomUUID(),
      ...(signature !== null ? { "X-Hub-Signature-256": signature } : {}),
    },
    body: bodyBuffer,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function waitForHealth(deadlineMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() - start < deadlineMs) {
        try {
          const res = await fetch(`${BASE_URL}/healthz`);
          if (res.ok) return resolve();
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error("server did not become healthy in time"));
    })();
  });
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // Deliberately fake — see the file header comment. These make the
      // async downstream GitHub/Anakin calls fail loudly (visible in
      // stderr below) rather than silently, without affecting the HTTP
      // assertions this script makes.
      GITHUB_APP_ID: "999999",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key-intentionally-invalid\n-----END RSA PRIVATE KEY-----\n",
      ANAKIN_API_KEY: "fake-smoke-test-key-not-real",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const results = [];
  let exitCode = 0;

  try {
    await waitForHealth(5000);
    console.log("server is up, running signature-verification exercises...\n");

    // 1. Valid signature, real-shaped issue_comment payload -> should ack 202.
    const validComment = await postWebhook({
      event: "issue_comment",
      payload: ISSUE_COMMENT_PAYLOAD,
      secretForSignature: WEBHOOK_SECRET,
    });
    results.push([
      "valid signature / issue_comment slash command",
      validComment.status === 202,
      validComment,
    ]);

    // 2. Valid signature, real-shaped workflow_run failure payload -> should ack 202.
    const validRun = await postWebhook({
      event: "workflow_run",
      payload: WORKFLOW_RUN_PAYLOAD,
      secretForSignature: WEBHOOK_SECRET,
    });
    results.push(["valid signature / workflow_run failure", validRun.status === 202, validRun]);

    // 2b. Every new slash command added in this pass -> each should ack 202,
    // exercising server.js's SLASH_COMMANDS dispatch table end-to-end for
    // real, signed HTTP requests (not just the original /anakin-search).
    for (const [label, payload] of NEW_COMMAND_PAYLOADS) {
      const res = await postWebhook({
        event: "issue_comment",
        payload,
        secretForSignature: WEBHOOK_SECRET,
      });
      results.push([`valid signature / issue_comment ${label}`, res.status === 202, res]);
    }

    // 3. Signature computed with the WRONG secret -> must be rejected (401).
    const wrongSecret = await postWebhook({
      event: "issue_comment",
      payload: ISSUE_COMMENT_PAYLOAD,
      secretForSignature: "not-the-real-secret",
    });
    results.push(["wrong-secret signature is rejected", wrongSecret.status === 401, wrongSecret]);

    // 4. Missing signature header entirely -> must be rejected (401).
    const missingSig = await postWebhook({
      event: "issue_comment",
      payload: ISSUE_COMMENT_PAYLOAD,
      secretForSignature: WEBHOOK_SECRET,
      signatureOverride: null,
    });
    results.push(["missing signature header is rejected", missingSig.status === 401, missingSig]);

    // 5. Valid signature but body tampered after signing -> must be rejected (401).
    const correctSig = hmacSign(Buffer.from(JSON.stringify(ISSUE_COMMENT_PAYLOAD)), WEBHOOK_SECRET);
    const tamperedRes = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": correctSig,
      },
      // Same signature as payload #1, but a different body — simulates an
      // in-flight tamper / replay-with-modification attempt.
      body: Buffer.from(JSON.stringify({ ...ISSUE_COMMENT_PAYLOAD, comment: { body: "/anakin-search pwned" } })),
    });
    results.push(["tampered body invalidates prior signature", tamperedRes.status === 401, { status: tamperedRes.status }]);

    // Give the fire-and-forget async handlers a moment to run (and fail
    // loudly against the fake credentials) so stderr output below reflects
    // real handler execution, not just the synchronous HTTP layer.
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    console.error("smoke test crashed:", err);
    exitCode = 1;
  } finally {
    child.kill();
  }

  console.log("--- results ---");
  for (const [label, pass, detail] of results) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}  (status=${detail.status})`);
    if (!pass) exitCode = 1;
  }

  console.log("\n--- server stdout ---\n" + stdout.trim());
  console.log("\n--- server stderr (expected: fake-credential errors from async GitHub/Anakin calls) ---\n" + stderr.trim());

  process.exit(exitCode);
}

main();
