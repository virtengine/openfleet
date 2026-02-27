import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
const homedirMock = vi.hoisted(() => vi.fn(() => "/home/tester"));
const isAppConfiguredMock = vi.hoisted(() => vi.fn());
const getInstallationTokenForRepoMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

vi.mock("../github-app-auth.mjs", () => ({
  isAppConfigured: isAppConfiguredMock,
  getInstallationTokenForRepo: getInstallationTokenForRepoMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { getGitHubToken } = await import("../github-auth-manager.mjs");
const { isAppConfigured, getInstallationTokenForRepo } = await import("../github-app-auth.mjs");
const { execFileSync } = await import("node:child_process");
const { readFile } = await import("node:fs/promises");

const originalFetch = globalThis.fetch;

const envKeys = [
  "BOSUN_GITHUB_USER_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
];

const originalEnv = envKeys.reduce(
  (acc, key) => ({ ...acc, [key]: process.env[key] }),
  {},
);

function clearAuthEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthEnv();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  homedirMock.mockReturnValue("/home/tester");
  readFileMock.mockRejectedValue(new Error("missing"));
  isAppConfiguredMock.mockReturnValue(false);
  getInstallationTokenForRepoMock.mockResolvedValue({ token: null });
  execFileSyncMock.mockImplementation(() => {
    throw new Error("gh missing");
  });
});

afterAll(() => {
  for (const key of envKeys) {
    if (originalEnv[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  globalThis.fetch = originalFetch;
});

describe("github-auth-manager getGitHubToken", () => {
  it("prefers OAuth env override and returns verified login when requested", async () => {
    process.env.BOSUN_GITHUB_USER_TOKEN = "oauth-env-token";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ login: "octo-env" }),
    });

    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockResolvedValue({ token: "app-token" });
    execFileSyncMock.mockReturnValue("gh-token");

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun", verify: true });

    expect(result).toEqual({ token: "oauth-env-token", type: "oauth", login: "octo-env" });
    expect(readFile).not.toHaveBeenCalled();
    expect(getInstallationTokenForRepo).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to installation token when verify rejects OAuth token", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ accessToken: "file-oauth-token" }));
    fetchMock.mockResolvedValue({ ok: false });

    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockResolvedValue({ token: "install-token" });

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun", verify: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ token: "install-token", type: "installation" });
    expect(getInstallationTokenForRepo).toHaveBeenCalledWith("virtengine", "bosun");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("uses gh CLI token after installation lookup fails", async () => {
    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockRejectedValue(new Error("no installation"));
    execFileSyncMock.mockReturnValue("gh-cli-token");

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun" });

    expect(result).toEqual({ token: "gh-cli-token", type: "gh-cli" });
    expect(execFileSync).toHaveBeenCalled();
  });

  it("uses env token after gh CLI token is unavailable", async () => {
    process.env.GITHUB_TOKEN = "env-fallback-token";
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh missing");
    });

    const result = await getGitHubToken();

    expect(result).toEqual({ token: "env-fallback-token", type: "env" });
  });

  it("throws when no authentication sources are available", async () => {
    await expect(getGitHubToken()).rejects.toThrow("No GitHub auth available");
  });
});
