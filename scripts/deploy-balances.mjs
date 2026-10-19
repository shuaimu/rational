#!/usr/bin/env node
/** Add source-balance storage and deploy its consumers without changing schedules or provider secrets. */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".local", "balance-deployment");
mkdirSync(work, { recursive: true, mode: 0o700 }); chmodSync(work, 0o700);
const config = JSON.parse(readFileSync(join(root, "rational.config.json"), "utf8"));
const tenant = ["--profile", process.env.MAKO_PROFILE ?? "robinlab", "--endpoint", config.endpoint,
  "--project", config.projectId, "--env", config.environmentId, "--json"];
const cli = args => JSON.parse(execFileSync("mako-cloud", [...args, ...tenant], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }));
const optional = args => { try { return cli(args); } catch (error) { if (error.status === 4) return null; throw error; } };
function save(name, value) {
  const path = join(work, name);
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); return path;
}
const items = answer => Array.isArray(answer) ? answer : answer.items ?? answer.indexes ?? [];
const model = JSON.parse(readFileSync(join(root, "mako/collections.json"), "utf8"));
const collection = model.collections.find(entry => entry.id === "account_balance_snapshots");
const existing = optional(["collections", "get", collection.id]);
if (!existing) cli(["collections", "create", collection.id, "--schema", `@${save("schema.json", collection.jsonSchema)}`,
  "--primary-key", "id", "--schema-version", String(model.schemaVersion)]);
else if (!isDeepStrictEqual(existing.jsonSchema, collection.jsonSchema)) throw new Error("Balance schema differs; inspect before deployment.");
const indexes = items(cli(["indexes", "list", collection.id]));
for (const index of collection.indexes) {
  if (!indexes.some(entry => entry.name === index.name && entry.state !== "failed"))
    cli(["indexes", "create", collection.id, "--name", index.name, "--version", "1", ...index.fields.flatMap(field => ["--field", field])]);
}
const desired = JSON.parse(readFileSync(join(root, "mako/policies/account_balance_snapshots.json"), "utf8"));
const policy = optional(["policies", "get", collection.id]);
if (policy?.policy?.state === "active") {
  if (!isDeepStrictEqual(policy.policy.rules, desired.rules)) throw new Error("Balance policy differs; inspect before deployment.");
} else {
  cli(["policies", "draft", collection.id, "--input", `@${save("policy.json", desired)}`]);
  cli(["policies", "validate", collection.id, "1"]);
  cli(["policies", "activate", collection.id, "1", "--yes"]);
}
console.log("Daily balance collection, household read policy and indexes are provisioned.");
const secretName = "BALANCE_SERVICE_KEY";
if (!optional(["functions", "secrets", "get", secretName])) {
  const keyFile = join(work, "service-key");
  if (!existsSync(keyFile)) cli(["keys", "service", "create", "--id", `sk_rational_balances_${Date.now().toString(36)}`,
    "--collection", collection.id, "--operation", "read,create,update", "--secret-file", keyFile]);
  cli(["functions", "secrets", "create", secretName, "--value-file", keyFile]);
}
const names = process.argv.length > 2 ? process.argv.slice(2) : ["institution-sync", "nightly"];
if (names.some(name => !["institution-sync", "nightly"].includes(name))) throw new Error("Choose institution-sync or nightly.");
for (const name of names) {
  const current = cli(["functions", "get", name]); save(`${name}-before.json`, current);
  const bundle = join(work, name);
  cpSync(join(root, "functions", name), bundle, { recursive: true });
  cpSync(join(root, "functions/shared"), join(bundle, "shared"), { recursive: true });
  for (const entry of readdirSync(bundle).filter(entry => entry.endsWith(".ts"))) {
    const path = join(bundle, entry); writeFileSync(path, readFileSync(path, "utf8").replaceAll('from "../shared/', 'from "./shared/'));
  }
  const conf = current.configuration;
  // For an existing function the CLI snapshots its stored configuration;
  // deploy's --secret flags alone do not change the injected secret allowlist.
  const secretNames = [...new Set([...conf.secretNames, secretName])];
  if (!isDeepStrictEqual(secretNames, conf.secretNames)) {
    cli(["functions", "update", name, "--config", `@${save(`${name}-configuration.json`, { ...conf, secretNames })}`]);
  }
  const args = ["functions", "deploy", bundle, "--name", name, "--yes"];
  for (const [flag, key] of [["cpu-ms", "cpuMilliseconds"], ["wall-ms", "wallMilliseconds"], ["concurrency", "concurrency"],
    ["memory-bytes", "memoryBytes"], ["request-bytes", "requestBytes"], ["response-bytes", "responseBytes"]]) args.push(`--${flag}`, String(conf.limits[key]));
  for (const secret of secretNames) args.push("--secret", secret);
  for (const host of conf.allowedHosts ?? []) args.push("--allow-host", host);
  if (!conf.verifyJwt) args.push("--no-verify-jwt");
  const result = cli(args); save(`${name}-deployment.json`, result);
  console.log(`${name}: version ${result.version}, ${result.health}, active ${result.activeVersion}.`);
}
