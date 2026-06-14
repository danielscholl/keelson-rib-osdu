<!--
Title must be a conventional commit — squash-merge uses it as the commit subject,
and pr-title.yml validates it.
  <type>[(scope)][!]: <subject>   (subject one sentence, under ~70 chars)
  types: feat fix perf refactor docs chore style test build ci revert
  e.g.  fix(cluster): re-verify CIMPL context before delete
-->

## What

<!-- The functional change in 1–3 sentences, grouped by behavior (not file). The
diff shows the what; lead with the problem it solves. Name the issue/slice if
there is one, and note anything deliberately left OUT of scope. -->

## Why now

<!-- The motivation: what this fixes or unblocks, and what drove the timing. -->

## Test plan

<!-- A record of what you actually ran and the result (counts, "green") — not a
checklist of intent. Add live/manual verification beyond CI where it matters
(e.g. a `collect:*` smoke test against a real cluster). -->

- [ ] `bun run check`
- [ ] `bun run typecheck`
- [ ] `bun test`

## Risk & rollback

<!-- OPTIONAL — delete this whole section if the change is trivial. Otherwise one
line each:
- Blast radius: which views/collectors/actions this can affect (esp. cluster lifecycle).
- Compatibility: contract/env/toolchain or breaking change (else "none").
- Rollback: how to back it out fast (revert, flag, config). -->

<!-- Closes #
Keep the PR scoped to one thing; split refactors out of feature work. -->
