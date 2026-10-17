#!/usr/bin/env node
/** Deploy the mapped Plaid integration using the installed CLI. Secrets enter through private files. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".local", "plaid-deployment");
mkdirSync(work, { recursive: true, mode: 0o700 });
chmodSync(work, 0o700);
const config = JSON.parse(readFileSync(join(root, "rational.config.json"), "utf8"));
const tenant = ["--profile", process.env.MAKO_PROFILE ?? "robinlab", "--project", config.projectId, "--env", config.environmentId, "--endpoint", config.endpoint];
function cli(args) {
  return JSON.parse(execFileSync(process.env.MAKO_CLI ?? "mako-cloud", [...args, ...tenant, "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}
function privateFile(name, contents) {
  const path = join(work, name); writeFileSync(path, contents, { mode: 0o600 }); chmodSync(path, 0o600); return path;
}
function putSecret(name, path) {
  let exists = false;
  try { cli(["functions", "secrets", "get", name]); exists = true; } catch (error) { if (error.status !== 4) throw error; }
  cli(["functions", "secrets", exists ? "rotate" : "create", name, "--value-file", path, "--yes"]);
  console.log(`Stored ${name} (value omitted).`);
}

for (const name of ["production-secret", "production-client-id"]) {
  if (!existsSync(join(work, name))) throw new Error(`Provide ${join(work, name)} privately before deploying.`);
}
// Validate before making any cloud changes.
if (!/^[a-zA-Z0-9_-]{20,200}$/.test(readFileSync(join(work, "production-secret"), "utf8").trim())) throw new Error("Invalid secret file format.");
if (!/^[a-zA-Z0-9_-]{20,100}$/.test(readFileSync(join(work, "production-client-id"), "utf8").trim())) throw new Error("Invalid client id file format.");

const model = JSON.parse(readFileSync(join(root, "mako/collections.json"), "utf8"));
const item = model.collections.find(collection => collection.id === "plaid_items");
const existing = cli(["collections", "get", "plaid_items"]);
if (existing.schemaVersion < item.schemaVersion) {
  const result = cli(["collections", "schema", "publish", "plaid_items", "--schema", `@${privateFile("plaid-items.schema.json", JSON.stringify(item.jsonSchema))}`, "--primary-key", "id", "--schema-version", String(item.schemaVersion)]);
  if (result.status === "migration_required" || result.migrationRequired) throw new Error("Private credential schema requires a migration; deployment stopped.");
} else if (existing.schemaVersion !== item.schemaVersion || !isDeepStrictEqual(existing.jsonSchema, item.jsonSchema)) {
  throw new Error("The cloud private schema differs from this deployment; inspect it before proceeding.");
}
console.log("Private Plaid schema is current.");
// Service-side reconciliation and overlap matching page a single account ledger.
const transactionIndexes = cli(["indexes", "list", "transactions"]);
const activeTransactionIndexes = Array.isArray(transactionIndexes) ? transactionIndexes : transactionIndexes.items ?? transactionIndexes.indexes ?? [];
if (!activeTransactionIndexes.some(index => index.name === "account_id" && index.state === "active")) {
  cli(["indexes", "create", "transactions", "--name", "account_id", "--version", "1", "--field", "account_id"]);
}

const imports = model.collections.find(collection => collection.id === "import_records");
let importCollection = null;
try { importCollection = cli(["collections", "get", imports.id]); } catch(error) { if(error.status !== 4) throw error; }
if (!importCollection) cli(["collections", "create", imports.id, "--schema", `@${privateFile("import-records.schema.json", JSON.stringify(imports.jsonSchema))}`, "--primary-key", "id", "--schema-version", "3"]);
else if (!isDeepStrictEqual(importCollection.jsonSchema, imports.jsonSchema)) throw new Error("Import storage schema differs; inspect before deploying.");
const indexesAnswer = cli(["indexes", "list", imports.id]);
const indexes = Array.isArray(indexesAnswer) ? indexesAnswer : indexesAnswer.items ?? indexesAnswer.indexes ?? [];
for (const index of imports.indexes) if (!indexes.some(existing => existing.name === index.name && existing.state !== "failed")) cli(["indexes", "create", imports.id, "--name", index.name, "--version", "1", ...index.fields.flatMap(field => ["--field", field])]);
let policy = null;
try { policy = cli(["policies", "get", imports.id]); } catch(error) { if(error.status !== 4) throw error; }
if (policy?.policy?.state !== "active") {
  cli(["policies", "draft", imports.id, "--input", `@${privateFile("import-records.policy.json", JSON.stringify({version:1,rules:[]}))}`]);
  cli(["policies", "activate", imports.id, "1", "--yes"]);
} else if (policy.policy.rules.length !== 0) throw new Error("Import staging must have no application-user grants.");
const importServicePath = join(work, "import-sync-service-key");
if (!existsSync(importServicePath)) cli(["keys", "service", "create", "--id", `sk_rational_import_${Date.now().toString(36)}`, "--collection", "connections,transactions,accounts,plaid_items,alerts,taxonomy,import_records", "--operation", "read,create,update,delete", "--secret-file", importServicePath]);
putSecret("IMPORT_SYNC_SERVICE_KEY", importServicePath);
console.log("Private import storage and dedicated function credential are ready.");


const servicePath = join(work, "sync-service-key");
if (!existsSync(servicePath)) {
  cli(["keys", "service", "create", "--id", `sk_rational_plaid_${Date.now().toString(36)}`,
    "--collection", "connections,transactions,accounts,plaid_items,alerts", "--operation", "read,create,update,delete", "--secret-file", servicePath]);
}
putSecret("SYNC_SERVICE_KEY", servicePath);
putSecret("PLAID_PRODUCTION_CLIENT_ID", join(work, "production-client-id"));
putSecret("PLAID_PRODUCTION_SECRET", join(work, "production-secret"));
putSecret("PLAID_ENVIRONMENT", privateFile("environment", "production"));

const source = join(work, "bundle");
mkdirSync(source, { recursive: true });
cpSync(join(root, "functions", "institution-sync"), source, { recursive: true });
cpSync(join(root, "functions", "shared"), join(source, "shared"), { recursive: true });
for (const entry of readdirSync(source)) {
  if (!entry.endsWith(".ts")) continue;
  const path = join(source, entry);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll('from "../shared/', 'from "./shared/'));
}
const current = cli(["functions", "get", "institution-sync"]);
privateFile("previous-function.json", JSON.stringify(current, null, 2));
const secretNames = ["IMPORT_SYNC_SERVICE_KEY", "SYNC_SERVICE_KEY", "RATIONAL_RUN_KEY", "PLAID_PRODUCTION_CLIENT_ID", "PLAID_PRODUCTION_SECRET", "PLAID_ENVIRONMENT"];
const functionConfig = { ...current.configuration, secretNames, allowedHosts: ["production.plaid.com"],
  limits: { ...current.configuration.limits, concurrency: 1, cpuMilliseconds: 10000, wallMilliseconds: 60000 } };
cli(["functions", "update", "institution-sync", "--config", `@${privateFile("function-config.json", JSON.stringify(functionConfig))}`]);
console.log("Deploying mapped Plaid function…");
const deployed = cli(["functions", "deploy", source, "--name", "institution-sync", "--cpu-ms", "10000", "--wall-ms", "60000", "--concurrency", "1",
  "--allow-host", "production.plaid.com", ...secretNames.flatMap(name => ["--secret", name]), "--yes"]);
privateFile("deployment-result.json", JSON.stringify(deployed, null, 2));
console.log("Mapped Plaid function deployed. Verify /plaid/status and set the dispatcher schedule to hourly.");
