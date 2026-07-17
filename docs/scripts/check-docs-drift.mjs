#!/usr/bin/env node
// Guards the docs against the drift class a build alone does not catch: the rib
// grows a view, workflow, key, or tool and the docs keep describing the old set.
// Derives every set from the rib source rather than a hardcoded list, so adding
// a lane fails this check until the docs mention it. Run after `astro build`,
// against docs/dist/llms-full.txt and the rib's src/.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsDir = join(scriptDir, "..");
const repoRoot = join(docsDir, "..");
const distLlms = join(docsDir, "dist", "llms-full.txt");
const contentDir = join(docsDir, "src", "content", "docs");
const archFile = join(docsDir, "ARCHITECTURE.md");
const ribIndex = join(repoRoot, "src", "index.ts");
const ribTools = join(repoRoot, "src", "tools.ts");
const binDir = join(repoRoot, "bin");

const failures = [];
const fail = (msg) => failures.push(msg);

// --- gather inputs -----------------------------------------------------------

if (!existsSync(distLlms)) {
  console.error(
    `check-docs-drift: ${relative(repoRoot, distLlms)} missing — run \`bun run build\` first.`,
  );
  process.exit(1);
}
const llms = readFileSync(distLlms, "utf8");
const index = existsSync(ribIndex) ? readFileSync(ribIndex, "utf8") : "";
const tools = existsSync(ribTools) ? readFileSync(ribTools, "utf8") : "";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const sourceDocs = [...walk(contentDir), archFile].filter(existsSync);

const uniq = (matches) => [...new Set(matches)];
const matchAll = (text, re) => uniq([...text.matchAll(re)].map((m) => m[1]));

// --- 1. obsolete terms (source pages + generated output) ---------------------

// Names that were renamed or never shipped. A hit means a page is describing a
// rib that does not exist.
const FORBIDDEN = [
  [/rib:osdu:queue\b/, 'obsolete key "rib:osdu:queue" (shipped as "rib:osdu:waiting")'],
  [/rib:osdu:feed\b/, 'obsolete key "rib:osdu:feed" (shipped as "rib:osdu:events")'],
  [/\bosdu-queue\b/, 'obsolete workflow "osdu-queue" (shipped as "osdu-waiting")'],
  [/\bosdu-feed\b/, 'obsolete workflow "osdu-feed" (shipped as "osdu-events")'],
  [/\bCluster ICC\b/, 'retired term "Cluster ICC" (use "Cluster board")'],
];

function scanLines(label, text) {
  const lines = text.split("\n");
  for (const [re, msg] of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (re.test(line)) fail(`${label}:${i + 1}: ${msg} — ${line.trim()}`);
    });
  }
}
for (const file of sourceDocs) scanLines(relative(repoRoot, file), readFileSync(file, "utf8"));
scanLines("dist/llms-full.txt", llms);

// --- 2. documented sets match the source ------------------------------------

// Snapshot keys: every rib:osdu:* literal the rib binds.
const keys = matchAll(index, /"(rib:osdu:[a-z-]+)"/g);
for (const key of keys) {
  if (!llms.includes(key)) fail(`snapshot key "${key}" is bound in src/index.ts but is not documented.`);
}

// Workflows: every contributed workflow name.
const workflows = matchAll(index, /name:\s*"(osdu-[a-z-]+)"/g);
for (const wf of workflows) {
  if (!llms.includes(wf)) fail(`workflow "${wf}" is contributed in src/index.ts but is not documented.`);
}

// Collectors: every bin/collect-*.ts the workflows run.
const collectors = existsSync(binDir)
  ? readdirSync(binDir).filter((f) => /^collect-.+\.ts$/.test(f))
  : [];
for (const c of collectors) {
  if (!llms.includes(c)) fail(`collector "bin/${c}" exists but is not documented.`);
}

// Tools: the read tools plus the generated osdu_cluster_<verb> lifecycle tools.
const readTools = matchAll(tools, /"(osdu_[a-z_]+)"/g);
const lifecycleVerbs = matchAll(tools, /lifecycleTool\(exec,\s*"([a-z]+)"/g);
const toolNames = uniq([...readTools, ...lifecycleVerbs.map((v) => `osdu_cluster_${v}`)]);
for (const name of toolNames) {
  if (!llms.includes(name)) fail(`tool "${name}" is registered in src/tools.ts but is not documented.`);
}

// --- 3. counts stated in prose match the sets -------------------------------

// A page that says "eight views" while nine ship is the drift this catches; the
// words are what a reader trusts, so they are checked like any other claim.
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const stated = (re) => {
  const m = llms.match(re);
  return m ? WORDS.indexOf(m[1].toLowerCase()) : null;
};

const claimedKeys = stated(/rib publishes (\w+) snapshot keys/i);
if (claimedKeys !== null && claimedKeys !== keys.length) {
  fail(`docs say the rib publishes ${WORDS[claimedKeys]} snapshot keys; src/index.ts binds ${keys.length}.`);
}

// One key per view, so the key count is the view count. Checked separately
// because "declares eight views" was the original drift and a correct
// snapshot-key sentence elsewhere does not catch it.
const claimedViews = stated(/rib declares (\w+) views/i);
if (claimedViews !== null && claimedViews !== keys.length) {
  fail(`docs say the rib declares ${WORDS[claimedViews]} views; src/index.ts binds ${keys.length} view keys.`);
}

const claimedWorkflows = stated(/rib contributes (\w+) workflows/i);
if (claimedWorkflows !== null && claimedWorkflows !== workflows.length) {
  fail(`docs say the rib contributes ${WORDS[claimedWorkflows]} workflows; src/index.ts contributes ${workflows.length}.`);
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\ncheck-docs-drift: ${failures.length} issue(s) found:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log(
  `check-docs-drift: ok (${sourceDocs.length} source pages; ${keys.length} keys, ${workflows.length} workflows, ${collectors.length} collectors, ${toolNames.length} tools cross-checked against src/).`,
);
