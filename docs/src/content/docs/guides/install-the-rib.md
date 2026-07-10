---
title: Install the rib
description: Add the OSDU rib to a running Keelson, put the toolchain on PATH, and confirm the CIMPL surface is live.
sidebar:
  order: 2
---

The OSDU rib installs into a
[Keelson](https://danielscholl.github.io/keelson/) you already run, the same
way the harness loads any rib. This guide adds it, wires the toolchain it
shells, and confirms the CIMPL surface is live.

## Add the rib

Into an installed Keelson (the managed home at `~/.keelson`):

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-osdu
keelson restart
```

The harness discovers installed `@keelson/rib-*` packages at boot, so the
install is all the wiring the rib needs. `@keelson/shared` arrives from the
harness as a peer dependency; you do not install it separately.

## Choose which ribs activate

The harness reads `KEELSON_RIBS` to decide which discovered ribs activate.
Leave it unset and every discovered rib activates. To narrow the set, list
rib ids; this rib's id is `osdu`:

```bash
KEELSON_RIBS=osdu keelson start
```

That variable belongs to the harness, not the rib. The rib has no env-based
configuration of its own.

## Put the toolchain on PATH

Live data needs the OSDU toolchain on `PATH` for the server process:

| CLI | Feeds |
|---|---|
| `cimpl` | Cluster ICC (info, lifecycle verbs) |
| `kubectl` | Topology, cluster readiness, jobs |
| `osdu-quality` | Quality and Security lanes |
| `osdu-activity` | Features, Release Train, Current Events |
| `glab` | Security vuln data, Waiting on You (and GitLab auth for the `osdu-*` CLIs) |

The CLIs own their auth: kubectl uses your kubeconfig, and the GitLab-backed
CLIs fall back to your `glab` login, so there is no token wrangling in the
common case. You also need a reachable CIMPL cluster as the kubectl
current-context for the cluster surfaces.

Without the toolchain the rib still loads; its lanes just render empty. A
missing CLI is a degraded collect, never a crash.

## Confirm it is active

Open the harness in a browser:

```text
http://127.0.0.1:7878
```

The **CIMPL** tab appears in the nav, with the Cluster ICC as its collapsed
header strip. Run the workflows that feed it, from the UI or the CLI:

```bash
keelson workflow run osdu-cluster    # Cluster ICC
keelson workflow run osdu-topology   # dependency graph
keelson workflow run osdu-quality    # quality board
```

The rib also reports auth status from the live kubectl context; a missing
context shows as unauthenticated on the Ribs page rather than an error.

## Remove the rib

```bash
keelson rib remove osdu
keelson restart
```

The rib persists nothing of its own, so removal leaves no data home behind;
snapshots are the harness's to keep or expire.

## Related

- [Run the collectors](../run-the-collectors/): prove the data layer works
  against your toolchain before blaming the harness.
- [Surface](../../reference/surface/): the full CIMPL layout this guide
  confirms is wired.
- [Tools and actions](../../reference/tools-and-actions/): the chat tools
  the rib registers once active.
