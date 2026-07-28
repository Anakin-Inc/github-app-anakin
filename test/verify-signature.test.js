"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifySignature } = require("../lib/verify-signature");

const SECRET = "test-webhook-secret";

function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("accepts a correctly-computed signature", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const sig = sign(body, SECRET);
  assert.equal(verifySignature(body, sig, SECRET), true);
});

test("rejects a signature computed with the wrong secret", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const sig = sign(body, "wrong-secret");
  assert.equal(verifySignature(body, sig, SECRET), false);
});

test("rejects a signature for a different body (tamper detection)", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const sig = sign(body, SECRET);
  const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test("rejects a missing signature header", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(verifySignature(body, undefined, SECRET), false);
});

test("rejects when no webhook secret is configured", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const sig = sign(body, SECRET);
  assert.equal(verifySignature(body, sig, undefined), false);
});

test("rejects a non-Buffer body", () => {
  const sig = sign(Buffer.from("{}"), SECRET);
  assert.equal(verifySignature("{}", sig, SECRET), false);
});

test("rejects a signature missing the sha256= prefix", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const digest = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal(verifySignature(body, digest, SECRET), false);
});
