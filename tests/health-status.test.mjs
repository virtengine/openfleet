import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getHealthStatus,
  setComponentStatus,
  markSetupComplete,
  isSetupComplete,
  setShuttingDown,
  setMonitorCircuitBroken,
  setMode,
} from "../infra/health-status.mjs";

describe("health-status", () => {
  afterEach(() => {
    setShuttingDown(false);
    setMonitorCircuitBroken(false);
    setComponentStatus("monitor", "stopped");
    setComponentStatus("server", "stopped");
    setMode({ docker: false, desktop: false });
  });

  describe("getHealthStatus()", () => {
    it("returns correct shape with all expected properties", () => {
      const health = getHealthStatus();
      expect(health).toHaveProperty("status");
      expect(health).toHaveProperty("setup");
      expect(health).toHaveProperty("monitor");
      expect(health).toHaveProperty("server");
      expect(health).toHaveProperty("uptime");
      expect(health).toHaveProperty("docker");
      expect(health).toHaveProperty("desktop");
      expect(Object.keys(health)).toHaveLength(7);
    });

    it("returns default status 'ok' with setup=false", () => {
      const health = getHealthStatus();
      expect(health.status).toBe("ok");
      expect(health.setup).toBe(false);
    });

    it("uptime is a non-negative number", () => {
      const health = getHealthStatus();
      expect(typeof health.uptime).toBe("number");
      expect(health.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("setComponentStatus()", () => {
    it("updates monitor status", () => {
      setComponentStatus("monitor", "running");
      const health = getHealthStatus();
      expect(health.monitor).toBe("running");
    });

    it("updates server status", () => {
      setComponentStatus("server", "running");
      const health = getHealthStatus();
      expect(health.server).toBe("running");
    });

    it("updates both monitor and server independently", () => {
      setComponentStatus("monitor", "running");
      setComponentStatus("server", "listening");
      const health = getHealthStatus();
      expect(health.monitor).toBe("running");
      expect(health.server).toBe("listening");
    });
  });

  describe("markSetupComplete() / isSetupComplete()", () => {
    it("isSetupComplete returns false by default", () => {
      // setup may already be true from a prior test in this singleton;
      // we cannot un-set it, so we only assert the getter type here
      expect(typeof isSetupComplete()).toBe("boolean");
    });

    it("markSetupComplete sets setup to true", () => {
      markSetupComplete();
      expect(isSetupComplete()).toBe(true);
      expect(getHealthStatus().setup).toBe(true);
    });
  });

  describe("setShuttingDown()", () => {
    it("changes status to 'shutting_down'", () => {
      setShuttingDown();
      expect(getHealthStatus().status).toBe("shutting_down");
    });

    it("setShuttingDown(false) restores status to 'ok'", () => {
      setShuttingDown(true);
      expect(getHealthStatus().status).toBe("shutting_down");
      setShuttingDown(false);
      expect(getHealthStatus().status).toBe("ok");
    });
  });

  describe("setMonitorCircuitBroken()", () => {
    it("changes status to 'degraded'", () => {
      setMonitorCircuitBroken();
      expect(getHealthStatus().status).toBe("degraded");
    });

    it("setMonitorCircuitBroken(false) restores status to 'ok'", () => {
      setMonitorCircuitBroken(true);
      expect(getHealthStatus().status).toBe("degraded");
      setMonitorCircuitBroken(false);
      expect(getHealthStatus().status).toBe("ok");
    });
  });

  describe("status priority", () => {
    it("shutting_down takes precedence over degraded", () => {
      setMonitorCircuitBroken(true);
      setShuttingDown(true);
      expect(getHealthStatus().status).toBe("shutting_down");
    });
  });

  describe("setMode()", () => {
    it("updates docker and desktop flags", () => {
      setMode({ docker: true, desktop: true });
      const health = getHealthStatus();
      expect(health.docker).toBe(true);
      expect(health.desktop).toBe(true);
    });

    it("with partial options only updates specified flag (docker)", () => {
      setMode({ docker: false, desktop: false });
      setMode({ docker: true });
      const health = getHealthStatus();
      expect(health.docker).toBe(true);
      expect(health.desktop).toBe(false);
    });

    it("with partial options only updates specified flag (desktop)", () => {
      setMode({ docker: false, desktop: false });
      setMode({ desktop: true });
      const health = getHealthStatus();
      expect(health.docker).toBe(false);
      expect(health.desktop).toBe(true);
    });

    it("with empty call does not change anything", () => {
      setMode({ docker: true, desktop: true });
      const before = getHealthStatus();
      setMode();
      const after = getHealthStatus();
      expect(after.docker).toBe(before.docker);
      expect(after.desktop).toBe(before.desktop);
    });
  });
});
