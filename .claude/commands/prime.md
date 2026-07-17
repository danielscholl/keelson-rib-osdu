---
description: Prime understanding of the OSDU rib — the Rib surface, the collector→builder pipeline, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working, current mental model of @keelson/rib-osdu — the OSDU /
    CIMPL bridge that turns a live cluster into Keelson canvas views — fast
    enough to navigate it and respect its invariants before making a change.
    AGENTS.md (already in context) carries the stable contract, patterns, and
    invariants; this command's job is to discover what is true RIGHT NOW — the
    views, workflows, collectors, and guards — from the code itself. Report only
    what you derived this pass; never recall a count or name list from memory
    or from a doc.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below; for
      everything else, LIST and skim — don't deep-read.</rule>
    <rule>DO NOT read test files — count them only.</rule>
    <rule>DO NOT read every collector or builder — read ONE of each as the
      pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>AGENTS.md / CLAUDE.md are already project context; build on them, don't
      re-read them. The code is the truth. If something you read materially
      contradicts AGENTS.md or a docs/ page, note it in ONE closing line and move
      on — auditing docs is not this command's job.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough sizes, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
      <command>wc -l src/*.ts bin/*.ts | sort -rn | head -15</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <learn>The current pitch: what the surface shows, what CLIs it depends on,
        how it installs.</learn>
    </step>
  </phase>

  <phase number="2" name="the-contract-surface">
    <step name="rib">
      <action>Read src/index.ts in full.</action>
      <learn>The exported `Rib`: which views exist and where the surface layout
        places each; how contributeWorkflows binds each view to its collector;
        how onAction guards the cluster verbs and handles credential reveals;
        what registerTools exposes; how the fail-closed wiring (output_schema +
        expectView) is applied.</learn>
    </step>
    <step name="pipeline">
      <action>Read ONE collector and its builder as the pattern
        (bin/collect-topology.ts → src/topology.ts is a good pair); list the
        rest of bin/ and the builder modules.</action>
      <learn>The collector→builder split: what the thin script does (shell a
        CLI, print a view) vs what the pure builder owns (parsing, shaping),
        and how a collector degrades when its CLI is absent or fails.</learn>
    </step>
    <step name="cluster">
      <action>Skim src/cluster.ts and src/cluster-actions.ts.</action>
      <learn>The security-sensitive surface: how the identity guard works, what
        the irreversible verbs re-verify before acting, and how revealed
        credentials stay loopback-only.</learn>
    </step>
  </phase>

  <phase number="3" name="inventory">
    <intent>Derive every number you will report. These commands are the only
      legitimate source for counts — not AGENTS.md, not docs/, not memory.</intent>
    <command>grep -cE 'canvasKind:' src/index.ts             # views</command>
    <command>grep -nE 'name: "osdu-' src/index.ts            # workflows</command>
    <command>ls bin/                                          # collectors</command>
    <command>git ls-files 'test/**/*.test.ts' | wc -l         # test files</command>
    <command>ls .claude/commands/ 2>/dev/null</command>
  </phase>

  <phase number="4" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR — the required
      checks, commit/PR-title format, and architecture rules.</action>
  </phase>

  <phase number="5" name="summarize">
    <format>Concise markdown — no multi-page dump. Every count and name list
      must come from this pass's commands and reads.</format>
    <sections>
      <section>Project: 1–2 sentences.</section>
      <section>The Rib surface: the views and surface layout as currently
        defined, workflows, actions, tools.</section>
      <section>The pipeline: workflow → collector (shell CLI) → pure builder →
        fail-closed view.</section>
      <section>Commands: the package scripts that gate a PR, plus the collect:*
        smoke tests.</section>
      <section>Invariants bearing on the change at hand (esp. secrets + cluster
        identity), from AGENTS.md, confirmed against what you just read.</section>
      <section>Where to start: which file to open first for this task.</section>
      <section>Only if found: one closing line naming any material contradiction
        between the code and AGENTS.md / docs/.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Reading every collector/builder/test — one of each, list the rest.</avoid>
    <avoid>Reporting a count or name list you did not derive this pass.</avoid>
    <avoid>Turning orientation into a docs audit — one closing drift line at most.</avoid>
    <avoid>Launching subagents. A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>
