---
description: Prime understanding of the OSDU rib — the Rib surface, the collector→builder pipeline, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working mental model of @keelson/rib-osdu — the OSDU / CIMPL bridge
    that turns a live cluster into Keelson canvas views — fast enough to navigate
    it and respect its invariants before making a change.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below in full; for
      everything else, LIST and skim — don't deep-read.</rule>
    <rule>DO NOT read test files — note their existence and count only.</rule>
    <rule>DO NOT read every collector or builder — read one of each as the pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>CLAUDE.md / AGENTS.md are already project context; build on them, don't re-read.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough size, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <extract>The pitch: a CIMPL surface of views, each fed by a workflow whose
        collector shells a domain CLI and shapes it with a pure builder; zero React.</extract>
    </step>
  </phase>

  <phase number="2" name="the-contract-surface">
    <intent>This rib is one Rib object plus its pipeline. Read these.</intent>
    <step name="rib">
      <action>Read src/index.ts.</action>
      <extract>The exported `Rib`: the eight views + the CIMPL surface;
        contributeWorkflows (one per view, each running a bin/collect-*.ts);
        onAction (cluster lifecycle verbs + reveal-credential); registerTools;
        and the fail-closed wiring (output_schema + expectView).</extract>
    </step>
    <step name="pipeline">
      <action>Read ONE collector and its builder as the pattern.</action>
      <points>
        <point>bin/collect-topology.ts — a thin script that shells kubectl and prints a view.</point>
        <point>src/topology.ts — the pure builder it shapes output with. The others
          (quality, features, security, …) follow the same collector→builder split.</point>
      </points>
    </step>
    <step name="cluster">
      <action>Skim src/cluster.ts and src/cluster-actions.ts.</action>
      <extract>The security-sensitive surface: the identity guard (actionGuardError),
        the live-context re-verification before Delete (verifyCimplContext), and the
        loopback-only credential handling (hasRealSecret, reveal).</extract>
    </step>
  </phase>

  <phase number="3" name="inventory">
    <step name="tests">
      <action>Count test files; report the count only.</action>
      <command>git ls-files 'test/**/*.test.ts' | wc -l</command>
    </step>
    <step name="commands"><command>ls .claude/commands/ 2>/dev/null</command></step>
  </phase>

  <phase number="4" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR.</action>
    <points>
      <point>Green before a PR: `bun run check`, `bun run typecheck`, `bun test`.</point>
      <point>Invariants: zero React; attach only via the Rib contract; no domain
        logic in glue; secrets never in a snapshot; cluster actions identity-guarded;
        async + timeout-bounded exec; fail closed.</point>
      <point>Comments: default to none; capture non-obvious why; no narration.</point>
    </points>
  </phase>

  <phase number="5" name="summarize">
    <format>Concise markdown — no multi-page dump:</format>
    <sections>
      <section>Project: 1–2 sentences (a Keelson rib; the OSDU/CIMPL bridge).</section>
      <section>The Rib surface: views/surface, workflows, actions, tools.</section>
      <section>The pipeline: workflow → collector (shell CLI) → pure builder → fail-closed view.</section>
      <section>Commands: test / typecheck / check / link:keelson / collect:*.</section>
      <section>Invariants to respect for the change at hand (esp. secrets + cluster identity).</section>
      <section>Where to start: which file to open first.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Reading every collector/builder/test to "understand patterns" — read one of each, list the rest.</avoid>
    <avoid>Launching subagents.</avoid>
    <avoid>A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>
