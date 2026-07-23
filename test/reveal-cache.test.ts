import { beforeEach, describe, expect, test } from "bun:test";
import type { RibAction, RibContext, RibExec } from "@keelson/shared";
import { resetRevealCache, revealCredential } from "../src/index.ts";

// Canned `cimpl info --json --show-secrets` output. The real call is a ~3s
// cluster round-trip that returns EVERY credential; the cache exists so only the
// first copy pays it. Passwords appear ONLY in this test fixture — the board
// never carries them.
const SECRETS = JSON.stringify({
  credentials: [
    { service: "Keycloak Admin", password: "kc-secret" },
    { service: "Redis", password: "redis-secret" },
  ],
});

// A RibExec that counts how many times the secrets call is made, so a test can
// assert a cache hit skipped the round-trip.
function makeExec(secretsJson: string = SECRETS) {
  let secretsCalls = 0;
  const exec = {
    async runText(cmd: string, args: string[]) {
      if (cmd === "cimpl" && args.join(" ") === "info --json --show-secrets") {
        secretsCalls++;
        return { ok: true, data: secretsJson };
      }
      return { ok: false, error: `unexpected ${cmd} ${args.join(" ")}`, code: 1 };
    },
    async runJSON() {
      return { ok: false, error: "no json handler", code: null };
    },
  } as unknown as RibExec;
  return { exec, calls: () => secretsCalls };
}

const ctxWith = (exec: RibExec): RibContext => ({ getExec: () => exec }) as RibContext;

function reveal(
  service: string,
  stamp: { context?: string; fingerprint?: string },
  ctx: RibContext,
  now: number,
) {
  return revealCredential(
    { type: "reveal-credential", payload: { service, ...stamp } } as unknown as RibAction,
    ctx,
    now,
  );
}

describe("revealCredential cache", () => {
  beforeEach(() => resetRevealCache());

  test("the first reveal fetches; a second within the window is served from cache", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    const first = await reveal(
      "Keycloak Admin",
      { context: "cimpl-a", fingerprint: "uid-1" },
      ctx,
      1_000,
    );
    expect(first).toEqual({ ok: true, data: "kc-secret" });
    expect(calls()).toBe(1);
    // A different credential on the same cluster still hits the cache — the one
    // round-trip fetched every secret.
    const second = await reveal("Redis", { context: "cimpl-a", fingerprint: "uid-1" }, ctx, 2_000);
    expect(second).toEqual({ ok: true, data: "redis-secret" });
    expect(calls()).toBe(1);
  });

  test("a different cluster (new fingerprint) misses rather than serving another's secret", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    await reveal("Keycloak Admin", { context: "cimpl-a", fingerprint: "uid-1" }, ctx, 0);
    await reveal("Keycloak Admin", { context: "cimpl-b", fingerprint: "uid-2" }, ctx, 100);
    expect(calls()).toBe(2);
  });

  test("the cache expires after the TTL and re-fetches", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    await reveal("Keycloak Admin", { context: "cimpl-a", fingerprint: "uid-1" }, ctx, 0);
    expect(calls()).toBe(1);
    // Just inside the 45s window: still a hit.
    await reveal("Keycloak Admin", { context: "cimpl-a", fingerprint: "uid-1" }, ctx, 44_000);
    expect(calls()).toBe(1);
    // Past it: re-fetch.
    await reveal("Keycloak Admin", { context: "cimpl-a", fingerprint: "uid-1" }, ctx, 46_000);
    expect(calls()).toBe(2);
  });

  test("falls back to the context as the cache key when no fingerprint was captured", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    await reveal("Keycloak Admin", { context: "cimpl-a" }, ctx, 0);
    await reveal("Redis", { context: "cimpl-a" }, ctx, 1_000);
    expect(calls()).toBe(1);
  });

  test("a stampless reveal never caches — no key to scope a secret to a cluster", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    await reveal("Keycloak Admin", {}, ctx, 0);
    await reveal("Keycloak Admin", {}, ctx, 100);
    expect(calls()).toBe(2);
  });

  test("an unknown service errors even off a warm cache (no extra round-trip)", async () => {
    const { exec, calls } = makeExec();
    const ctx = ctxWith(exec);
    await reveal("Keycloak Admin", { fingerprint: "uid-1" }, ctx, 0);
    const miss = await reveal("Nope", { fingerprint: "uid-1" }, ctx, 1_000);
    expect(miss.ok).toBe(false);
    expect(calls()).toBe(1);
  });

  test("a failed cimpl call is not cached — the next reveal retries", async () => {
    const failing = {
      async runText() {
        return { ok: false, error: "cimpl not on PATH", code: null };
      },
      async runJSON() {
        return { ok: false, error: "no", code: null };
      },
    } as unknown as RibExec;
    const result = await reveal("Keycloak Admin", { fingerprint: "uid-1" }, ctxWith(failing), 0);
    expect(result).toEqual({ ok: false, error: "cimpl not on PATH" });
    // A later good call still fetches (the failure left nothing cached).
    const { exec, calls } = makeExec();
    await reveal("Keycloak Admin", { fingerprint: "uid-1" }, ctxWith(exec), 1_000);
    expect(calls()).toBe(1);
  });
});
