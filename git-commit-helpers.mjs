/**
 * git-commit-helpers.mjs — Git commit utilities for Bosun
 *
 * Ensures Bosun Bot is credited in commits and PRs via GitHub's
 * Co-authored-by trailer convention.
 *
 * GitHub App bot user ID: 262908237
 * Noreply email: 262908237+bosun-ve[bot]@users.noreply.github.com
 * GitHub appearance: https://github.com/apps/bosun-ve
 */

const BOSUN_BOT_TRAILER =
  "Co-authored-by: bosun-ve[bot] <262908237+bosun-ve[bot]@users.noreply.github.com>";

const BOSUN_PR_CREDIT =
  "\n\n---\n*Created by [Bosun Bot](https://github.com/apps/bosun-ve)*";

// ── Commit message helpers ────────────────────────────────────────────────────

/**
 * Appends the Bosun bot Co-authored-by trailer to a commit message.
 *
 * GitHub displays the bot in the Contributors graph when this trailer is present.
 * The Co-authored-by line must be separated from the message body by a blank line.
 *
 * @param {string} message - original commit message
 * @returns {string} commit message with trailer appended
 */
export function appendBosunCoAuthor(message) {
  if (message.includes("Co-authored-by: bosun-ve")) return message;
  const trimmed = message.trimEnd();
  return `${trimmed}\n\n${BOSUN_BOT_TRAILER}`;
}

/**
 * Builds a complete commit message with an optional Bosun bot credit trailer.
 *
 * @param {string} title - commit title (first line / summary)
 * @param {string} [body] - commit body (optional extended description)
 * @param {Object} [opts]
 * @param {boolean} [opts.addBosunCredit=true] - whether to append the co-author trailer
 * @returns {string} full commit message
 */
export function buildCommitMessage(title, body = "", { addBosunCredit = true } = {}) {
  const parts = [title.trimEnd()];
  if (body && body.trim()) {
    parts.push(""); // blank line
    parts.push(body.trimEnd());
  }
  const base = parts.join("\n");
  return addBosunCredit ? appendBosunCoAuthor(base) : base;
}

// ── PR body helpers ───────────────────────────────────────────────────────────

/**
 * Appends the Bosun Bot credit footer to a PR body.
 *
 * @param {string} body - original PR description
 * @returns {string} PR body with Bosun Bot credit appended
 */
export function appendBosunPrCredit(body) {
  if (body.includes("Bosun Bot") || body.includes("bosun-ve")) return body;
  return body.trimEnd() + BOSUN_PR_CREDIT;
}

/**
 * Returns the Bosun bot Co-authored-by trailer string (for direct use).
 *
 * @returns {string}
 */
export function getBosunCoAuthorTrailer() {
  return BOSUN_BOT_TRAILER;
}

/**
 * Returns the Bosun bot PR credit footer markdown (for direct use).
 *
 * @returns {string}
 */
export function getBosunPrCredit() {
  return BOSUN_PR_CREDIT;
}
