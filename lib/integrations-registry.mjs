/**
 * Integrations Registry — catalog of supported integration types and their field schemas.
 *
 * Each integration definition has:
 *   id          — unique string key
 *   name        — display name
 *   description — short description
 *   icon        — emoji icon for UI
 *   fields      — array of field descriptors for the secrets form
 *   docsUrl     — optional documentation link
 */

/** @typedef {{ id: string, label: string, type: "text"|"password"|"url"|"select", required?: boolean, placeholder?: string, options?: string[], helpText?: string }} FieldDef */
/** @typedef {{ id: string, name: string, description: string, icon: string, fields: FieldDef[], docsUrl?: string }} IntegrationDef */

/** @type {IntegrationDef[]} */
export const INTEGRATIONS = [
  {
    id: "github",
    name: "GitHub",
    description: "GitHub personal access tokens and App credentials",
    icon: "🐙",
    fields: [
      {
        id: "token",
        label: "Personal Access Token",
        type: "password",
        required: false,
        placeholder: "ghp_...",
        helpText: "Classic or fine-grained PAT with repo scope",
      },
      {
        id: "appId",
        label: "App ID",
        type: "text",
        required: false,
        placeholder: "123456",
        helpText: "GitHub App ID (optional, for App-based auth)",
      },
      {
        id: "privateKey",
        label: "App Private Key (PEM)",
        type: "password",
        required: false,
        placeholder: "-----BEGIN RSA PRIVATE KEY-----",
        helpText: "GitHub App private key for JWT signing",
      },
      {
        id: "installationId",
        label: "Installation ID",
        type: "text",
        required: false,
        placeholder: "45678901",
        helpText: "GitHub App installation ID",
      },
    ],
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Telegram Bot API token",
    icon: "✈️",
    fields: [
      {
        id: "botToken",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "1234567890:ABCdef...",
        helpText: "From @BotFather — used for sending notifications",
      },
      {
        id: "chatId",
        label: "Default Chat ID",
        type: "text",
        required: false,
        placeholder: "-100123456789",
        helpText: "Default channel or group chat ID",
      },
    ],
    docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  },
  {
    id: "azure",
    name: "Azure",
    description: "Azure service principal or OpenAI endpoint credentials",
    icon: "☁️",
    fields: [
      {
        id: "tenantId",
        label: "Tenant ID",
        type: "text",
        required: false,
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        id: "clientId",
        label: "Client ID",
        type: "text",
        required: false,
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        id: "clientSecret",
        label: "Client Secret",
        type: "password",
        required: false,
        placeholder: "~xxxxxxxx",
      },
      {
        id: "openAiEndpoint",
        label: "Azure OpenAI Endpoint",
        type: "url",
        required: false,
        placeholder: "https://my-resource.openai.azure.com/",
      },
      {
        id: "openAiApiKey",
        label: "Azure OpenAI API Key",
        type: "password",
        required: false,
        placeholder: "xxxxxxxx...",
      },
    ],
    docsUrl: "https://learn.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack bot or webhook token",
    icon: "💬",
    fields: [
      {
        id: "botToken",
        label: "Bot Token",
        type: "password",
        required: false,
        placeholder: "xoxb-...",
        helpText: "OAuth bot token with chat:write scope",
      },
      {
        id: "webhookUrl",
        label: "Incoming Webhook URL",
        type: "url",
        required: false,
        placeholder: "https://hooks.slack.com/services/...",
        helpText: "Alternative to bot token for simple notifications",
      },
    ],
    docsUrl: "https://api.slack.com/authentication/token-types",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Linear API key for issue tracking",
    icon: "📐",
    fields: [
      {
        id: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "lin_api_...",
        helpText: "Personal API key from Linear settings",
      },
    ],
    docsUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api#personal-api-keys",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Jira Cloud API token",
    icon: "🔷",
    fields: [
      {
        id: "baseUrl",
        label: "Base URL",
        type: "url",
        required: true,
        placeholder: "https://your-org.atlassian.net",
      },
      {
        id: "email",
        label: "Account Email",
        type: "text",
        required: true,
        placeholder: "you@example.com",
      },
      {
        id: "apiToken",
        label: "API Token",
        type: "password",
        required: true,
        placeholder: "ATATT3x...",
        helpText: "Generate at id.atlassian.com/manage-profile/security/api-tokens",
      },
    ],
    docsUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI API key",
    icon: "🤖",
    fields: [
      {
        id: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "sk-...",
      },
      {
        id: "organization",
        label: "Organization ID",
        type: "text",
        required: false,
        placeholder: "org-...",
      },
    ],
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic Claude API key",
    icon: "🧠",
    fields: [
      {
        id: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "sk-ant-...",
      },
    ],
    docsUrl: "https://docs.anthropic.com/en/api/getting-started",
  },
  {
    id: "env",
    name: "Environment Variable",
    description: "Generic environment variable secret",
    icon: "🔑",
    fields: [
      {
        id: "key",
        label: "Variable Name",
        type: "text",
        required: true,
        placeholder: "MY_API_KEY",
      },
      {
        id: "value",
        label: "Value",
        type: "password",
        required: true,
        placeholder: "secret-value",
      },
    ],
  },
  {
    id: "custom",
    name: "Custom",
    description: "Custom key-value credential set",
    icon: "🛠️",
    fields: [
      {
        id: "key",
        label: "Key",
        type: "text",
        required: true,
        placeholder: "field-name",
      },
      {
        id: "value",
        label: "Value",
        type: "password",
        required: true,
        placeholder: "secret-value",
      },
    ],
  },
];

/** @returns {IntegrationDef | undefined} */
export function getIntegration(id) {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** @returns {string[]} */
export function getIntegrationIds() {
  return INTEGRATIONS.map((i) => i.id);
}
