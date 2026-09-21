#!/usr/bin/env node
/**
 * Push provider secrets from .env.local to a Convex deployment.
 *
 * Usage:
 *   node scripts/configure-secrets.mjs                       # dev deployment
 *   node scripts/configure-secrets.mjs --prod                # production deployment
 *   node scripts/configure-secrets.mjs --deployment-name X   # named deployment
 *
 * Safety properties:
 *   - Reads .env.local only through Node's process.loadEnvFile; the file is
 *     never opened, parsed or printed by this script.
 *   - Every value is piped to `npx convex env set NAME` over stdin (no value on
 *     the command line, no shell), so nothing lands in shell history or `ps`.
 *   - Child stdout/stderr are captured and discarded; only key names and a
 *     success/failure status are printed.
 *   - A missing key is a hard failure. No placeholder or substitute is set.
 */
import { spawnSync } from "node:child_process";

const REQUIRED_KEYS = ["OPENAI_API_KEY", "FIRECRAWL_API_KEY", "AGENTMAIL_API_KEY", "AGENTMAIL_WEBHOOK_SECRET"];
const ENV_FILE = ".env.local";

function parseArgs(argv) {
  const opts = { prod: false, deploymentName: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prod") opts.prod = true;
    else if (a === "--deployment-name") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail("--deployment-name requires a value");
      opts.deploymentName = v;
    } else if (a.startsWith("--deployment-name=")) opts.deploymentName = a.slice("--deployment-name=".length);
    else fail(`unknown argument: ${a}`);
  }
  if (opts.prod && opts.deploymentName) fail("--prod and --deployment-name are mutually exclusive");
  return opts;
}

function fail(msg) {
  console.error(`configure-secrets: ${msg}`);
  process.exit(1);
}

function deploymentArgs(opts) {
  if (opts.prod) return ["--prod"];
  if (opts.deploymentName) return ["--deployment-name", opts.deploymentName];
  return [];
}

/** Sets one env var on the deployment via stdin. Returns true on success. */
function setSecret(name, value, opts) {
  const args = ["convex", "env", "set", ...deploymentArgs(opts), name];
  // stdin is a pipe (not a TTY), so the Convex CLI reads the value from it and
  // strips exactly one trailing newline.
  const result = spawnSync("npx", args, {
    input: `${value}\n`,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
  // Deliberately never surface result.stdout / result.stderr: the CLI may echo
  // values or provider-shaped errors.
  if (result.error) return { ok: false, why: `spawn failed (${result.error.code ?? "unknown"})` };
  if (result.status !== 0) return { ok: false, why: `exit ${result.status}` };
  return { ok: true };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof process.loadEnvFile !== "function") fail("Node >= 20.12 with process.loadEnvFile is required");

  // loadEnvFile populates process.env in-process only; it never writes back
  // to disk or to the parent shell. No value is read or printed here.
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    fail(`could not load ${ENV_FILE}`);
  }

  const missing = REQUIRED_KEYS.filter((k) => !process.env[k] || process.env[k].trim().length === 0);
  if (missing.length > 0) {
    console.error(`configure-secrets: missing in ${ENV_FILE}: ${missing.join(", ")}`);
    console.error("configure-secrets: obtain the real values (tokenstash) before re-running; nothing was set.");
    process.exit(1);
  }

  const target = opts.prod ? "prod" : opts.deploymentName ? `deployment ${opts.deploymentName}` : "dev";
  console.log(`configure-secrets: target = ${target}`);
  let failures = 0;
  for (const name of REQUIRED_KEYS) {
    const r = setSecret(name, process.env[name], opts);
    if (r.ok) console.log(`  ${name}: set`);
    else {
      failures += 1;
      console.log(`  ${name}: FAILED (${r.why})`);
    }
  }
  if (failures > 0) fail(`${failures} of ${REQUIRED_KEYS.length} secrets failed; re-run after fixing deployment access`);
  console.log(`configure-secrets: ${REQUIRED_KEYS.length} secrets set`);
}

main();
