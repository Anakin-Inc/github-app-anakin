"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  handleEvent,
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
} = require("../server");

test("ignores workflow_run events that are not a completed failure", async () => {
  const result = await handleEvent("workflow_run", {
    action: "in_progress",
    workflow_run: { conclusion: null },
  });
  assert.equal(result, null);
});

test("ignores workflow_run completed with a non-failure conclusion", async () => {
  const result = await handleEvent("workflow_run", {
    action: "completed",
    workflow_run: { conclusion: "success" },
  });
  assert.equal(result, null);
});

test("ignores issue_comment events that don't match the slash command", async () => {
  const result = await handleEvent("issue_comment", {
    action: "created",
    comment: { body: "just a normal comment, not a command" },
  });
  assert.equal(result, null);
});

test("ignores unrelated event types entirely", async () => {
  const result = await handleEvent("star", { action: "created" });
  assert.equal(result, null);
});

test("SLASH_COMMAND_RE parses the query out of a matching comment body", () => {
  const match = SLASH_COMMAND_RE.exec("/anakin-search why does npm ci fail with ERESOLVE");
  assert.ok(match);
  assert.equal(match[1], "why does npm ci fail with ERESOLVE");
});

test("SLASH_COMMAND_RE does not match plain text", () => {
  assert.equal(SLASH_COMMAND_RE.exec("anakin-search without the slash"), null);
});

test("SLASH_COMMAND_RE matches case-insensitively and mid-multiline comments", () => {
  const match = SLASH_COMMAND_RE.exec("thanks!\n/Anakin-Search flaky test root cause\nmore text");
  assert.ok(match);
  assert.equal(match[1], "flaky test root cause");
});

// ─── New slash command regexes ─────────────────────────────────────────
//
// Same two things SLASH_COMMAND_RE is tested for above: (1) the regex
// captures the right argument group(s), and (2) commands sharing a prefix
// (e.g. /anakin-wire vs /anakin-wire-catalog) never cross-match — each
// requires whitespace/end-of-line immediately after its own command word.

test("WIRE_DISCOVER_RE captures the natural-language query", () => {
  const match = WIRE_DISCOVER_RE.exec("/anakin-wire top phones on walmart");
  assert.ok(match);
  assert.equal(match[1], "top phones on walmart");
});

test("WIRE_DISCOVER_RE does not match /anakin-wire-catalog or /anakin-wire-run (prefix collision)", () => {
  assert.equal(WIRE_DISCOVER_RE.exec("/anakin-wire-catalog amazon"), null);
  assert.equal(WIRE_DISCOVER_RE.exec("/anakin-wire-run amazon.get_product"), null);
});

test("WIRE_CATALOG_RE captures an optional slug", () => {
  const withSlug = WIRE_CATALOG_RE.exec("/anakin-wire-catalog amazon");
  assert.ok(withSlug);
  assert.equal(withSlug[1], "amazon");

  const noSlug = WIRE_CATALOG_RE.exec("/anakin-wire-catalog");
  assert.ok(noSlug);
  assert.equal(noSlug[1], undefined);
});

test("WIRE_RUN_RE captures action_id and an optional single-line JSON params blob", () => {
  const withParams = WIRE_RUN_RE.exec('/anakin-wire-run amazon.search_products {"query":"mouse"}');
  assert.ok(withParams);
  assert.equal(withParams[1], "amazon.search_products");
  assert.equal(withParams[2], '{"query":"mouse"}');

  const noParams = WIRE_RUN_RE.exec("/anakin-wire-run amazon.get_categories");
  assert.ok(noParams);
  assert.equal(noParams[1], "amazon.get_categories");
  assert.equal(noParams[2], undefined);
});

test("AI_VISIBILITY_SOURCES_RE matches only the bare command", () => {
  assert.ok(AI_VISIBILITY_SOURCES_RE.exec("/anakin-ai-visibility-sources"));
  assert.equal(AI_VISIBILITY_SOURCES_RE.exec("/anakin-ai-visibility-sources extra text"), null);
});

test("AI_VISIBILITY_SEARCH_RE captures the query and does not match the -sources command", () => {
  const match = AI_VISIBILITY_SEARCH_RE.exec("/anakin-ai-visibility what is your return policy?");
  assert.ok(match);
  assert.equal(match[1], "what is your return policy?");
  assert.equal(AI_VISIBILITY_SEARCH_RE.exec("/anakin-ai-visibility-sources"), null);
});

test("MONITORS_RE captures an optional monitor id", () => {
  const withId = MONITORS_RE.exec("/anakin-monitors mon_123");
  assert.ok(withId);
  assert.equal(withId[1], "mon_123");

  const noId = MONITORS_RE.exec("/anakin-monitors");
  assert.ok(noId);
  assert.equal(noId[1], undefined);
});

test("MONITORS_RE does not match /anakin-monitor-changes (prefix collision)", () => {
  assert.equal(MONITORS_RE.exec("/anakin-monitor-changes mon_123"), null);
});

test("MONITOR_CHANGES_RE requires a monitor id", () => {
  const match = MONITOR_CHANGES_RE.exec("/anakin-monitor-changes mon_123");
  assert.ok(match);
  assert.equal(match[1], "mon_123");
  assert.equal(MONITOR_CHANGES_RE.exec("/anakin-monitor-changes"), null);
});

test("SESSIONS_RE captures an optional domain filter", () => {
  const withDomain = SESSIONS_RE.exec("/anakin-sessions amazon.com");
  assert.ok(withDomain);
  assert.equal(withDomain[1], "amazon.com");

  const noDomain = SESSIONS_RE.exec("/anakin-sessions");
  assert.ok(noDomain);
  assert.equal(noDomain[1], undefined);
});

test("MAP_RE and CRAWL_RE capture the target URL and are case-insensitive", () => {
  const mapMatch = MAP_RE.exec("/ANAKIN-MAP https://example.com/docs");
  assert.ok(mapMatch);
  assert.equal(mapMatch[1], "https://example.com/docs");

  const crawlMatch = CRAWL_RE.exec("/anakin-crawl https://example.com/docs");
  assert.ok(crawlMatch);
  assert.equal(crawlMatch[1], "https://example.com/docs");
});

// ─── Routing (handleEvent) for the new commands ────────────────────────
//
// Mirrors the existing "ignores ... missing installation.id" style: these
// exercise handleEvent's dispatch through to the new handler's own
// authenticateForIssueComment() guard, confirming the whole chain resolves
// safely (no throw, no unhandled rejection) when there's nothing to
// authenticate with — without requiring real GitHub/Anakin credentials.
// (Success-path behavior against a live server is covered by
// scripts/smoke-test.js.)

const BASE_REPO_ISSUE = {
  repository: { name: "example-repo", full_name: "octocat/example-repo", owner: { login: "octocat" } },
  issue: { number: 7 },
};

test("handleEvent routes /anakin-map to its handler and resolves safely without installation.id", async () => {
  const result = await handleEvent("issue_comment", {
    action: "created",
    ...BASE_REPO_ISSUE,
    comment: { body: "/anakin-map https://example.com" },
  });
  assert.equal(result, undefined);
});

test("handleEvent routes /anakin-wire-run (with JSON params) to its handler and resolves safely without installation.id", async () => {
  const result = await handleEvent("issue_comment", {
    action: "created",
    ...BASE_REPO_ISSUE,
    comment: { body: '/anakin-wire-run amazon.search_products {"query":"mouse"}' },
  });
  assert.equal(result, undefined);
});

test("handleEvent routes /anakin-monitors (no id) to its handler and resolves safely without installation.id", async () => {
  const result = await handleEvent("issue_comment", {
    action: "created",
    ...BASE_REPO_ISSUE,
    comment: { body: "/anakin-monitors" },
  });
  assert.equal(result, undefined);
});

test("handleEvent routes /anakin-ai-visibility-sources to its handler and resolves safely without installation.id", async () => {
  const result = await handleEvent("issue_comment", {
    action: "created",
    ...BASE_REPO_ISSUE,
    comment: { body: "/anakin-ai-visibility-sources" },
  });
  assert.equal(result, undefined);
});
