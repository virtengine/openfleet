import "./runtime-bootstrap.mjs";


import { vi } from "vitest";

const originalEnv = { ...process.env };

if (typeof vi.stubEnv !== "function") {
  vi.stubEnv = (name, value) => {
    if (value === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = String(value);
  };
}

if (typeof vi.unstubAllEnvs !== "function") {
  vi.unstubAllEnvs = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  };
}
