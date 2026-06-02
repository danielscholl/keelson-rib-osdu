# @keelson/rib-osdu

The OSDU CIMPL "bridge" as a [Keelson](https://github.com/danielscholl/keelson) **rib** —
a discovery-based extension that contributes deterministic workflows whose structured
output drives live canvas views. The harness stays domain-free; all OSDU/cluster
knowledge lives here, and the rib ships **zero React** into the trusted SPA.

> Status: **alpha**. Slice 1 ships a live cluster/**Flux topology graph** sourced purely
> from `kubectl` — no sidecar, no LLM in the data path. Platform-health lanes
> (Features / Quality / Security) follow.

![Cluster topology rendering in Keelson's canvas](docs/topology.png)

## How it works

```
osdu-topology workflow            (contributed by this rib)
  └─ bash node: bun bin/collect-topology.ts   →  prints a graph-view JSON object
        │  (declares output_schema, so the executor promotes stdout to structured output)
        ▼
  publish bridge  →  snapshot key  rib:osdu:topology   (fail-closed: canvasViewSchema)
        ▼
  Ribs page  →  "Cluster Topology" view  →  canvas graph renderer (live)
```

- **`src/topology.ts`** — pure `buildTopologyGraph(kustomizations)`: one node per Flux
  Kustomization (health in the node `kind`: `ready` / `blocked` / `suspended` / `failed`
  / `unknown`), edges from `spec.dependsOn`, dependency-free nodes rooted under the cluster.
- **`src/kubectl.ts` / `bin/collect-topology.ts`** — the deterministic collector. Reads
  `kubectl get kustomizations -n flux-system -o json`; degrades to a valid one-node graph
  when no cluster is reachable.
- **`src/index.ts`** — the `Rib`: one `views` descriptor bound to `rib:osdu:topology`, one
  contributed workflow that publishes to it, and an `authStatus` probe for the kubectl context.

No data is produced in rib code — the UI's data comes from running a workflow.

## Develop against a local Keelson

```bash
bun install
bun link @keelson/shared        # resolves the contract from your local keelson checkout
                                # (or rely on the symlink dev/link.ts manages)

bun test            # pure topology builder coverage
bun run typecheck
bun run check       # biome lint + format

# Wire the rib into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

Then open `http://127.0.0.1:5173` → **Ribs** → run the `osdu-topology` workflow (from the
Workflows surface or `keelson workflow run osdu-topology`) → open **Cluster Topology**.

Smoke-test the collector directly:

```bash
bun run collect:topology | jq .
```

## Distribution

For a real install (`bun add @keelson/rib-osdu`), both this package and `@keelson/shared`
must be published to a registry. `@keelson/shared` is already configured to publish; the
dev loop above needs no registry.

## Roadmap

- **Slice 2+** — Quality / Security / Features lanes as live tables, sourced by a
  `script (runtime: uv)` workflow node invoking the OSDU analyzers as a one-shot CLI
  (no resident sidecar). Each lane is its own `rib:osdu:*` snapshot key + view.

## License

Apache-2.0.
