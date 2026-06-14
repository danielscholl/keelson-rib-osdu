---
applyTo: "test/**"
---

Bun's test runner (`bun:test`). Tests run with stubs; CI sets `KEELSON_USE_STUBS=1`.
Most coverage is the pure builders fed by recorded CLI output under
`test/fixtures/`.

Do NOT flag in this directory:

- Missing docstrings or comments on test helpers.
- Mock-vs-real tradeoffs, or the JSON fixtures under `test/fixtures/`.
- A test that reads another part of the package's source as a drift guard.

Do flag a test that asserts nothing, or one that loosens a security-sensitive
expectation — e.g. accepting a secret in a built view, or a cluster action passing
without the identity guard.
