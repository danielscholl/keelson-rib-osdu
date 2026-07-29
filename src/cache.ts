// Cross-process JSON file cache shared by the collectors' expensive CLI
// fetches. Each collector is a separate subprocess on its own cadence, so reuse
// rides a small versioned file co-located with the harness DB (KEELSON_DB) or
// in the OS temp dir. Best-effort throughout: a miss, a stale entry, or a
// failed write just means the caller refetches.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface CacheEntry<T> {
  version: number;
  fetchedAt: number;
  value: T;
}

export function defaultCacheDir(): string {
  const db = process.env.KEELSON_DB;
  const base = db ? dirname(db) : tmpdir();
  return join(base, "rib-osdu-cache");
}

export function readCacheEntry<T>(
  dir: string,
  file: string,
  version: number,
  now: number,
  ttlMs: number,
): T | null {
  try {
    const path = join(dir, file);
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
    if (entry.version !== version) return null;
    if (now - entry.fetchedAt >= ttlMs) return null;
    return entry.value;
  } catch {
    return null;
  }
}

export function writeCacheEntry<T>(
  dir: string,
  file: string,
  version: number,
  value: T,
  now: number,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const entry: CacheEntry<T> = { version, fetchedAt: now, value };
    const tmp = join(dir, `${file}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, join(dir, file));
  } catch {
    // Best-effort; a failed write just means the next run refetches.
  }
}

export function ttlFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

// Single-flight lock so concurrent collectors (Quality and Security both fetch
// the release report when a stale surface opens) collapse to one CLI sweep:
// the loser waits for the winner's cache write instead of duplicating it.
// Returns true when this process should fetch. A lock older than staleMs
// belongs to a crashed holder and is broken rather than honored.
export function tryClaimLock(dir: string, file: string, staleMs: number): boolean {
  const path = join(dir, file);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs >= staleMs) {
        rmSync(path, { force: true });
        writeFileSync(path, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // Lost the race to a live holder (or it just released); wait instead.
    }
    return false;
  }
}

export function releaseLock(dir: string, file: string): void {
  try {
    rmSync(join(dir, file), { force: true });
  } catch {
    // A leftover lock goes stale and gets broken by the next claimant.
  }
}
