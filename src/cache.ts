// Cross-process JSON file cache shared by the collectors' expensive CLI
// fetches. Each collector is a separate subprocess on its own cadence, so reuse
// rides a small versioned file co-located with the harness DB (KEELSON_DB) or
// under the user's cache dir — never a world-writable temp dir, so another
// local user can't poison an entry or plant a symlink where we write.
// Best-effort throughout: a miss, a stale entry, or a failed write just means
// the caller refetches.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CacheEntry<T> {
  version: number;
  fetchedAt: number;
  value: T;
}

export function defaultCacheDir(): string {
  const db = process.env.KEELSON_DB;
  const base = db ? dirname(db) : join(homedir(), ".cache");
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry: CacheEntry<T> = { version, fetchedAt: now, value };
    // Unpredictable name + wx so the write can't be steered through a
    // pre-planted symlink; the rename publishes it atomically.
    const tmp = join(dir, `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry), { flag: "wx" });
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs >= staleMs) {
        // Atomic takeover: rename the stale lock to a name only this process
        // uses — exactly one contender's rename succeeds, so a fresh lock is
        // never deleted out from under a live holder.
        const claimed = `${path}.${process.pid}.stale`;
        renameSync(path, claimed);
        rmSync(claimed, { force: true });
        writeFileSync(path, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // Lost the race to a live holder or another claimant; wait instead.
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
