"use strict";

const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

/**
 * GitHub App authentication: JWT (signed with the App's private key) ->
 * installation access token -> an Octokit instance authenticated as that
 * installation.
 *
 * `@octokit/auth-app` is GitHub's own recommended library for this flow
 * (referenced directly from docs.github.com's GitHub App auth docs). It
 * implements, internally:
 *
 *  1. A JWT signed with RS256, claims `iat` (issued-at, backdated 60s for
 *     clock drift), `exp` (expiry, <= 10 minutes from `iat`), and `iss`
 *     (the App ID) — per
 *     https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *  2. Exchanging that JWT for an installation access token via
 *     `POST /app/installations/{installation_id}/access_tokens`
 *     (`Authorization: Bearer <jwt>`, `Accept: application/vnd.github+json`),
 *     which returns a short-lived (1 hour) `token` — per
 *     https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 *
 * We call `createAppAuth` ourselves (rather than only relying on Octokit's
 * built-in `authStrategy` option) so the same authenticator can be unit
 * tested and reused outside of an Octokit instance if needed.
 */
function buildAppAuth({ appId, privateKey, webhookSecret } = {}) {
  if (!appId) throw new Error("GITHUB_APP_ID is not set");
  if (!privateKey) throw new Error("GITHUB_PRIVATE_KEY is not set");

  return createAppAuth({
    appId,
    privateKey,
    webhookSecret,
  });
}

/**
 * Returns an Octokit client authenticated as a specific installation
 * (i.e. able to act on the repos that installation was granted access to).
 *
 * @param {object} opts
 * @param {string|number} opts.appId
 * @param {string} opts.privateKey - PEM, newlines preserved (not escaped `\n`).
 * @param {string|number} opts.installationId
 */
async function getInstallationOctokit({ appId, privateKey, installationId }) {
  if (!installationId) throw new Error("installationId is required");

  const auth = buildAppAuth({ appId, privateKey });
  const installationAuth = await auth({ type: "installation", installationId });

  return new Octokit({ auth: installationAuth.token });
}

module.exports = { buildAppAuth, getInstallationOctokit };
