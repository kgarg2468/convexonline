#!/usr/bin/env node
/**
 * Provision the @convex-dev/auth signing keys (JWT_PRIVATE_KEY + JWKS) on a
 * Convex deployment. Idempotent and non-rotating:
 *
 *   - both present  -> "already configured", exit 0, nothing changed
 *   - exactly one   -> refuse (exit 2); the manager must resolve by hand
 *   - neither       -> generate a fresh RS256 key pair and set both
 *
 * Usage:
 *   node scripts/configure-auth.mjs
 *   node scripts/configure-auth.mjs --prod
 *   node scripts/configure-auth.mjs --deployment-name X
 *
 * Key format matches @convex-dev/auth's own `npx @convex-dev/auth` initializer
 * (dist/bin.cjs generateKeys): PKCS8 PEM, trailing whitespace trimmed, every
 * newline replaced with a single space; JWKS = {"keys":[{"use":"sig",...jwk}]}.
 * The runtime re-imports it with jose importPKCS8(..., "RS256"), which accepts
 * the space-joined form.
 *
 * Existing configuration is detected via `npx convex env list --names-only`,
 * so no value ever leaves the deployment. Values are sent over stdin; child
 * stdout/stderr are captured and discarded.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const PRIVATE_KEY_NAME = "JWT_PRIVATE_KEY";
const JWKS_NAME = "JWKS";

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

function fail(msg, code = 1) {
  console.error(`configure-auth: ${msg}`);
  process.exit(code);
}

function deploymentArgs(opts) {
  if (opts.prod) return ["--prod"];
  if (opts.deploymentName) return ["--deployment-name", opts.deploymentName];
  return [];
}

function runConvex(args, input) {
  return spawnSync("npx", ["convex", ...args], {
    input,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
}

/** Returns the Set of env var names on the deployment. Never touches values. */
function listEnvNames(opts) {
  const r = runConvex(["env", "list", "--names-only", ...deploymentArgs(opts)], "");
  if (r.error) fail(`could not run convex env list (${r.error.code ?? "unknown"})`);
  if (r.status !== 0) fail(`convex env list exited ${r.status}; check deployment access`);
  // --names-only prints one bare name per line on stdout; only keep tokens
  // that look like env var names so any stray CLI chatter is ignored.
  const names = new Set();
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) names.add(t);
  }
  return names;
}

/** Generates keys exactly as @convex-dev/auth's initializer does. */
function generateAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" });
  return {
    [PRIVATE_KEY_NAME]: pkcs8.trimEnd().replace(/\n/g, " "),
    [JWKS_NAME]: JSON.stringify({ keys: [{ use: "sig", ...jwk }] }),
  };
}

function setEnv(name, value, opts) {
  const r = runConvex(["env", "set", ...deploymentArgs(opts), name], `${value}\n`);
  // Never print r.stdout / r.stderr: they may contain the value.
  if (r.error) return { ok: false, why: `spawn failed (${r.error.code ?? "unknown"})` };
  if (r.status !== 0) return { ok: false, why: `exit ${r.status}` };
  return { ok: true };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = opts.prod ? "prod" : opts.deploymentName ? `deployment ${opts.deploymentName}` : "dev";
  console.log(`configure-auth: target = ${target}`);

  const names = listEnvNames(opts);
  const hasPriv = names.has(PRIVATE_KEY_NAME);
  const hasJwks = names.has(JWKS_NAME);

  if (hasPriv && hasJwks) {
    console.log(`configure-auth: ${PRIVATE_KEY_NAME} and ${JWKS_NAME} already configured; not rotating`);
    return;
  }
  if (hasPriv !== hasJwks) {
    const present = hasPriv ? PRIVATE_KEY_NAME : JWKS_NAME;
    const absent = hasPriv ? JWKS_NAME : PRIVATE_KEY_NAME;
    fail(
      `incomplete auth config: ${present} is set but ${absent} is missing. ` +
        "Refusing to guess or rotate. Either unset the present variable to re-provision both, " +
        "or set the missing one from the same key pair.",
      2,
    );
  }

  const keys = generateAuthKeys();
  let failures = 0;
  for (const name of [PRIVATE_KEY_NAME, JWKS_NAME]) {
    const r = setEnv(name, keys[name], opts);
    if (r.ok) console.log(`  ${name}: set`);
    else {
      failures += 1;
      console.log(`  ${name}: FAILED (${r.why})`);
    }
  }
  if (failures > 0) {
    fail("auth key provisioning incomplete; inspect the deployment env names and re-run (script refuses partial state)");
  }
  console.log("configure-auth: RS256 key pair provisioned");
}

main();
