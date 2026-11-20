import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const CONFIG = ".oxlintrc.json";
const PROBE = ".oxlintrc.landmines-probe.json";
const PLUGIN = { name: "landmines-testing", specifier: "@interfere/landmines/testing" };
const COUNTED = ["no-fixed-sleep", "no-flake-masking", "no-unsignaled-poll"];
const RULES = [...COUNTED, "no-test-doubles", "strict-msw"];
const EXEMPT_RULE = `${PLUGIN.name}/no-test-doubles`;

const config = JSON.parse(readFileSync(CONFIG, "utf8"));

writeFileSync(PROBE, JSON.stringify({
  plugins: [],
  categories: { correctness: "off" },
  ignorePatterns: [...config.ignorePatterns, "examples/**"],
  jsPlugins: [PLUGIN],
  rules: Object.fromEntries(RULES.map((rule) => [`${PLUGIN.name}/${rule}`, "error"])),
}));

let output;
try {
  output = execFileSync("npx", ["oxlint", "-c", PROBE, "-f", "json", "."], { encoding: "utf8", maxBuffer: 1 << 28 });
} catch (error) {
  if (typeof error.stdout !== "string" || !error.stdout.startsWith("{")) throw error;
  output = error.stdout;
} finally {
  rmSync(PROBE, { force: true });
}

const counts = Object.fromEntries(RULES.map((rule) => [rule, {}]));
for (const { code, filename } of JSON.parse(output).diagnostics) {
  const rule = /\(([a-z-]+)\)$/.exec(code)?.[1];
  if (!rule || !counts[rule]) throw new Error(`unexpected diagnostic ${code} in ${filename}`);
  counts[rule][filename] = (counts[rule][filename] ?? 0) + 1;
}

const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

config.jsPlugins = [...(config.jsPlugins ?? []).filter((plugin) => plugin.name !== PLUGIN.name), PLUGIN];
for (const rule of RULES) {
  const allow = counts[rule];
  config.rules[`${PLUGIN.name}/${rule}`] = COUNTED.includes(rule) && Object.keys(allow).length > 0
    ? ["error", { allow: sorted(allow) }]
    : "error";
}
config.overrides = [
  ...(config.overrides ?? []).filter((override) => !(EXEMPT_RULE in (override.rules ?? {}))),
  { files: Object.keys(counts["no-test-doubles"]).sort(), rules: { [EXEMPT_RULE]: "off" } },
];

writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
for (const rule of RULES) {
  const files = Object.keys(counts[rule]).length;
  const total = Object.values(counts[rule]).reduce((sum, count) => sum + count, 0);
  console.log(`${rule}: ${total} in ${files} files`);
}
