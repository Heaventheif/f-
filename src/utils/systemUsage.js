"use strict";
import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";

async function readText(file) {
  try { return (await readFile(file, "utf8")).trim(); } catch { return null; }
}
function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseCgroupMemory(usedText, limitText) {
  const used = asNumber(usedText);
  if (used === null) return null;
  const parsedLimit = limitText === "max" ? null : asNumber(limitText);
  const limit = parsedLimit !== null && parsedLimit < 1e15 ? parsedLimit : null;
  return { used, limit };
}

export function parseCgroupCpu(statText, quotaText) {
  const usage = String(statText ?? "").match(/^usage_usec\s+(\d+)$/m);
  if (!usage) return null;
  const [quota, period] = String(quotaText ?? "").trim().split(/\s+/);
  const quotaValue = quota === "max" ? null : asNumber(quota);
  const periodValue = asNumber(period);
  const quotaCores = quotaValue !== null && quotaValue > 0 && periodValue > 0
    ? quotaValue / periodValue
    : null;
  return { usageUs: Number(usage[1]), quotaCores };
}

export function parseCgroupCpuV1(usageNs, quotaUs, periodUs) {
  const usage = asNumber(usageNs);
  if (usage === null) return null;
  const quota = asNumber(quotaUs);
  const period = asNumber(periodUs);
  const quotaCores = quota !== null && quota > 0 && period > 0 ? quota / period : null;
  return { usageUs: usage / 1000, quotaCores };
}

export function cpuPercent(cpuUs, elapsedUs, cores = 1) {
  if (![cpuUs, elapsedUs, cores].every(Number.isFinite) || elapsedUs <= 0 || cores <= 0) return null;
  return cpuUs / elapsedUs / cores * 100;
}

export function formatBytes(value) {
  let bytes;
  try { bytes = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.round(Number(value) || 0))); }
  catch { return "غير متاح"; }
  if (bytes < 1024n) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let amount = Number(bytes);
  let unit = -1;
  do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(1)} ${units[unit]}`;
}

export async function readCgroupMemory() {
  const v2Used = await readText("/sys/fs/cgroup/memory.current");
  if (v2Used !== null) return parseCgroupMemory(v2Used, await readText("/sys/fs/cgroup/memory.max"));
  const v1Used = await readText("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  return v1Used === null ? null : parseCgroupMemory(v1Used, await readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
}

export async function readCgroupCpu() {
  const stat = await readText("/sys/fs/cgroup/cpu.stat");
  if (stat !== null) {
    const parsed = parseCgroupCpu(stat, await readText("/sys/fs/cgroup/cpu.max"));
    if (parsed) return parsed;
  }
  return parseCgroupCpuV1(
    await readText("/sys/fs/cgroup/cpu/cpuacct.usage"),
    await readText("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    await readText("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
  );
}

async function readNetworkCounters() {
  try {
    let rx = 0n, tx = 0n;
    const interfaces = (await readdir("/sys/class/net")).filter(name => name !== "lo");
    for (const name of interfaces) {
      const base = `/sys/class/net/${name}/statistics`;
      const inBytes = await readText(`${base}/rx_bytes`);
      const outBytes = await readText(`${base}/tx_bytes`);
      if (inBytes !== null) rx += BigInt(inBytes);
      if (outBytes !== null) tx += BigInt(outBytes);
    }
    return interfaces.length ? { rx, tx } : null;
  } catch { return null; }
}

async function readDiskUsage(target) {
  try {
    const stat = await statfs(target, { bigint: true });
    const blockSize = BigInt(stat.bsize);
    const total = BigInt(stat.blocks) * blockSize;
    const free = BigInt(stat.bavail) * blockSize;
    const used = total - BigInt(stat.bfree) * blockSize;
    return { total, free, used };
  } catch { return null; }
}

export async function collectSystemUsage(sampleMs = 250, diskPath = process.cwd()) {
  const duration = Math.max(50, Math.min(1000, Number(sampleMs) || 250));
  const processBefore = process.cpuUsage();
  const containerBefore = await readCgroupCpu();
  const networkBefore = await readNetworkCounters();
  const started = process.hrtime.bigint();
  await new Promise(resolve => setTimeout(resolve, duration));
  const elapsedUs = Math.max(1, Number(process.hrtime.bigint() - started) / 1000);
  const processDelta = process.cpuUsage(processBefore);
  const containerAfter = await readCgroupCpu();
  const networkAfter = await readNetworkCounters();
  const processCpuUs = processDelta.user + processDelta.system;
  const containerCpuUs = containerBefore && containerAfter
    ? Math.max(0, containerAfter.usageUs - containerBefore.usageUs)
    : null;
  const visibleCores = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length || 1;
  const containerCores = containerAfter?.quotaCores || visibleCores || 1;
  const networkDelta = networkBefore && networkAfter
    ? { rx: networkAfter.rx >= networkBefore.rx ? networkAfter.rx - networkBefore.rx : 0n,
        tx: networkAfter.tx >= networkBefore.tx ? networkAfter.tx - networkBefore.tx : 0n }
    : null;
  const memory = process.memoryUsage();
  return {
    sampleMs: elapsedUs / 1000,
    processMemory: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
    containerMemory: await readCgroupMemory(),
    processCpuPercent: cpuPercent(processCpuUs, elapsedUs),
    containerCpuPercent: containerCpuUs === null ? null : cpuPercent(containerCpuUs, elapsedUs, containerCores),
    disk: await readDiskUsage(diskPath),
    network: networkAfter,
    networkDelta,
  };
}
