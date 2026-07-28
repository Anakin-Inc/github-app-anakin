"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleEvent, SLASH_COMMAND_RE } = require("../server");

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
