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

That variable belongs to the harness, not the rib.

## Configure the rib

The defaults target the OSDU community instance, so a normal install needs
none of these. Each is read from the server process's environment:

| Variable | Default | Changes |
|---|---|---|
| `KEELSON_OSDU_GITLAB_HOST` | `community.opengroup.org` | The GitLab instance the activity CLIs query. |
| `KEELSON_OSDU_GITLAB_GROUP` | `osdu/platform` | The group the Features, Release, Events, and Security reads scope to. |
| `KEELSON_OSDU_PMC_URL` | the PMC dashboard's Pages site | The base URL behind the Release Train's PMC link grid. |
| `KEELSON_OSDU_BUNDLE_TTL_MS` | `600000` (10 min) | How long the shared activity fetch is cached before a re-fetch. |
| `CIMPL_CONTEXT_PREFIXES` | `cimpl-,kind-cimpl,k3d-cimpl,cimpl_` | Which kubectl context prefixes count as cimpl-managed. A non-empty value **replaces** the default set. |

`CIMPL_CONTEXT_PREFIXES` is the load-bearing one. A context outside the
prefix set is treated as a real (non-managed) cluster and is refused for
write actions, so widening it widens what the rib will act on.

## Put the toolchain on PATH

Live data needs the OSDU toolchain on `PATH` for the server process:

| CLI | Feeds |
|---|---|
| `cimpl` | Cluster board (info, lifecycle verbs) |
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

The **CIMPL** tab appears in the nav, with the Cluster board as its collapsed
header strip. Run the workflows that feed it, from the UI or the CLI:

```bash
keelson workflow run osdu-cluster    # Cluster
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

The rib keeps almost nothing of its own. It writes two things, neither of
which holds cluster state or secrets:

- a `cluster-create.json` dispatch marker in its harness data dir, which
  exists only while a create is in flight and is cleared when the run
  settles;
- a cached activity fetch (`rib-osdu-cache`, beside the harness DB when
  `KEELSON_DB` is set, otherwise in the OS temp dir), shared so that
  collectors on staggered cadences reuse one GitLab read.

Both are disposable: delete them and the next collect rebuilds them.
Snapshots are the harness's to keep or expire.

## Related

- [Run the collectors](../run-the-collectors/): prove the data layer works
  against your toolchain before blaming the harness.
- [Surface](../../reference/surface/): the full CIMPL layout this guide
  confirms is wired.
- [Tools and actions](../../reference/tools-and-actions/): the chat tools
  the rib registers once active.
