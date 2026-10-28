import { describe, expect, test } from "bun:test";
import {
  collectSystemUsage,
  cpuPercent,
  formatBytes,
  parseCgroupCpu,
  parseCgroupCpuV1,
  parseCgroupMemory,
} from "../src/utils/systemUsage.js";

describe("system usage parsing", () => {
  test("parses cgroup v2 memory usage and limit", () => {
    expect(parseCgroupMemory("524288", "1048576")).toEqual({ used: 524288, limit: 1048576 });
  });

  test("treats unlimited cgroup memory as an unknown limit", () => {
    expect(parseCgroupMemory("524288", "max")).toEqual({ used: 524288, limit: null });
  });

  test("parses cgroup v2 CPU time and quota", () => {
    expect(parseCgroupCpu("usage_usec 250000\nuser_usec 150000", "200000 100000"))
      .toEqual({ usageUs: 250000, quotaCores: 2 });
  });

  test("parses cgroup v1 CPU time and quota", () => {
    expect(parseCgroupCpuV1("500000000", "50000", "100000"))
      .toEqual({ usageUs: 500000, quotaCores: 0.5 });
  });

  test("calculates CPU share relative to the assigned cores", () => {
    expect(cpuPercent(50000, 100000, 1)).toBe(50);
    expect(cpuPercent(50000, 100000, 0.5)).toBe(100);
    expect(cpuPercent(1, 0, 1)).toBeNull();
  });

  test("formats byte counts without changing units unexpectedly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1048576n)).toBe("1.0 MB");
  });
});

test("collects a real Bun process and filesystem snapshot", async () => {
  const usage = await collectSystemUsage(50, process.cwd());
  expect(usage.processMemory.rss).toBeGreaterThan(0);
  expect(usage.processCpuPercent).not.toBeNull();
  expect(usage.sampleMs).toBeGreaterThan(0);
  expect(usage.disk === null || usage.disk.total > 0n).toBe(true);
  expect(usage.network === null || typeof usage.network.rx === "bigint").toBe(true);
});
