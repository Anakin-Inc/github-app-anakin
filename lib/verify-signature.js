"use strict";

/**
 * GitHub webhook delivery signature verification.
 *
 * GitHub signs every webhook delivery with HMAC-SHA256 over the raw request
 * body, using the webhook secret configured on the App, and sends the result
 * in the `X-Hub-Signature-256` header as `sha256=<hex digest>`.
 *
 * Source: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * ("Validating webhook deliveries") — confirmed live, including the explicit
 * warning to use a constant-time comparison (`crypto.timingSafeEqual`)
 * rather than `===`/`==` to avoid leaking timing information about the
 * expected signature.
 *
 * @param {Buffer} rawBody - the exact, unparsed request body bytes GitHub sent.
 *   Must be the raw bytes, not a re-serialized JSON.stringify of the parsed
 *   object — any difference in whitespace/key order breaks the HMAC.
 * @param {string | undefined} signatureHeader - the `X-Hub-Signature-256` header value.
 * @param {string | undefined} secret - the webhook secret configured on the GitHub App.
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader, secret) {
  const crypto = require("node:crypto");

  if (!secret) return false;
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  if (!Buffer.isBuffer(rawBody)) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws on length mismatch, so check that first — this
  // early return leaks only length, never digest content, which is the
  // standard accepted tradeoff (see the docs page's own example).
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = { verifySignature };
