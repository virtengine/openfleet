import { normalizeProviderDefinitionId } from "../providers/index.mjs";
import { ANTHROPIC_API_KEY_AUTH_ADAPTER } from "./anthropic-api-key.mjs";
import { AZURE_OPENAI_AUTH_ADAPTER } from "./azure-openai.mjs";
import { CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER } from "./chatgpt-codex-subscription.mjs";
import { CLAUDE_SUBSCRIPTION_AUTH_ADAPTER } from "./claude-subscription.mjs";
import { COPILOT_OAUTH_AUTH_ADAPTER } from "./copilot-oauth.mjs";
import { OLLAMA_AUTH_ADAPTER } from "./ollama.mjs";
import { OPENAI_API_KEY_AUTH_ADAPTER } from "./openai-api-key.mjs";
import { OPENAI_COMPATIBLE_AUTH_ADAPTER } from "./openai-compatible.mjs";

export {
  ANTHROPIC_API_KEY_AUTH_ADAPTER,
  AZURE_OPENAI_AUTH_ADAPTER,
  CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER,
  CLAUDE_SUBSCRIPTION_AUTH_ADAPTER,
  COPILOT_OAUTH_AUTH_ADAPTER,
  OLLAMA_AUTH_ADAPTER,
  OPENAI_API_KEY_AUTH_ADAPTER,
  OPENAI_COMPATIBLE_AUTH_ADAPTER,
};

const BUILTIN_PROVIDER_AUTH_ADAPTERS = Object.freeze([
  OPENAI_API_KEY_AUTH_ADAPTER,
  CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER,
  AZURE_OPENAI_AUTH_ADAPTER,
  ANTHROPIC_API_KEY_AUTH_ADAPTER,
  CLAUDE_SUBSCRIPTION_AUTH_ADAPTER,
  OPENAI_COMPATIBLE_AUTH_ADAPTER,
  OLLAMA_AUTH_ADAPTER,
  COPILOT_OAUTH_AUTH_ADAPTER,
]);

export function listProviderAuthAdapters() {
  return BUILTIN_PROVIDER_AUTH_ADAPTERS.slice();
}

export function getProviderAuthAdapter(providerId) {
  const normalized = normalizeProviderDefinitionId(providerId, "");
  if (!normalized) return null;
  return BUILTIN_PROVIDER_AUTH_ADAPTERS.find((entry) => entry.providerId === normalized) || null;
}

export default BUILTIN_PROVIDER_AUTH_ADAPTERS;
