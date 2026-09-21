#!/usr/bin/env node
/**
 * Register (or reuse) the product-scoped AgentMail `message.received` webhook
 * for a Convex deployment and store BOTH its id and its signing secret on that
 * deployment (AGENTMAIL_WEBHOOK_ID, AGENTMAIL_WEBHOOK_SECRET). `inbox.provision`
 * later appends each new inn inbox to this hook; without these two variables
 * provisioning refuses with `webhook_not_configured`.
 *
 * Usage:
 *   node scripts/register-webhook.mjs --site-url https://<name>.convex.site --inbox a@agentmail.to [--inbox b@agentmail.to]
 *   node scripts/register-webhook.mjs --site-url ... --inbox ... --prod            # store on prod
 *   node scripts/register-webhook.mjs --site-url ... --inbox ... --deployment X    # named deployment
 *
 * Behaviour:
 *   - Every --inbox must be an inbox this account owns: verified with
 *     GET /v0/inboxes/:id (never trusted from the command line alone).
 *   - client_id is derived from the site name (`frontdesk-<name>`), exactly as
 *     convex/lib/inboxWebhook.ts expects; the caller cannot choose it.
 *   - Existing webhooks are listed. A hook that already targets this
 *     deployment's /api/agentmail/webhook is reused only if it carries this
 *     client_id, subscribes to message.received and is scoped to a non-empty
 *     inbox list; otherwise the script stops and explains. Hooks with other
 *     urls (e.g. the PoC hook) are never touched.
 *   - Missing target inboxes are appended with PATCH { add_inbox_ids } (never
 *     a list replacement); the provider limit of 10 inboxes per hook is
 *     enforced before the call.
 *   - No hook is ever created or left with an empty inbox list: an empty list
 *     means organization-wide delivery, which this product refuses.
 *
 * Safety properties (same discipline as configure-secrets.mjs):
 *   - .env.local is read only through process.loadEnvFile; it is never opened,
 *     parsed, printed or written. AGENTMAIL_API_KEY is used for the
 *     Authorization header only. No secret is written to any local file.
 *   - The hook id and secret go straight to `npx convex env set` over stdin
 *     with child stdout/stderr discarded. The secret and raw provider JSON are
 *     never printed; only the hook id, target url, counts and statuses are.
 */
import { spawnSync } from "node:child_process";

const ENV_FILE = ".env.local";
const AGENTMAIL_BASE_URL = "https://api.agentmail.to";
const WEBHOOK_PATH = "/api/agentmail/webhook";
const EVENT_TYPE = "message.received";
const MAX_INBOXES_PER_WEBHOOK = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const ID_VAR = "AGENTMAIL_WEBHOOK_ID";
const SECRET_VAR = "AGENTMAIL_WEBHOOK_SECRET";

function fail(msg, code = 1) {
  console.error(`register-webhook: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { siteUrl: undefined, inboxes: [], prod: false, deploymentName: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} requires a value`);
      return v;
    };
    if (a === "--site-url") opts.siteUrl = next();
    else if (a.startsWith("--site-url=")) opts.siteUrl = a.slice("--site-url=".length);
    else if (a === "--inbox") opts.inboxes.push(next());
    else if (a.startsWith("--inbox=")) opts.inboxes.push(a.slice("--inbox=".length));
    else if (a === "--prod") opts.prod = true;
    else if (a === "--deployment" || a === "--deployment-name") opts.deploymentName = next();
    else if (a.startsWith("--deployment=")) opts.deploymentName = a.slice("--deployment=".length);
    else if (a.startsWith("--deployment-name=")) opts.deploymentName = a.slice("--deployment-name=".length);
    else fail(`unknown argument: ${a}`);
  }
  if (opts.prod && opts.deploymentName) fail("--prod and --deployment are mutually exclusive");
  if (!opts.siteUrl) fail("--site-url https://<name>.convex.site is required");
  let site;
  try {
    site = new URL(opts.siteUrl);
  } catch {
    fail("--site-url is not a valid URL");
  }
  if (site.protocol !== "https:" || !site.hostname.endsWith(".convex.site") || site.username || site.password) {
    fail("--site-url must be an https://<name>.convex.site URL");
  }
  if (site.pathname !== "/" || site.search || site.hash) fail("--site-url must be the bare deployment origin");
  opts.siteUrl = site.origin;
  opts.siteName = site.hostname.slice(0, -".convex.site".length).toLowerCase();
  if (opts.inboxes.length === 0) fail("at least one --inbox <address> is required (the hook must be scoped to owned inboxes)");
  for (const inbox of opts.inboxes) {
    if (!/^[^\s@]+@[^\s@]+$/.test(inbox)) fail(`--inbox ${inbox} is not an address`);
  }
  opts.inboxes = [...new Set(opts.inboxes.map((x) => x.toLowerCase()))];
  if (opts.inboxes.length > MAX_INBOXES_PER_WEBHOOK) fail(`a webhook covers at most ${MAX_INBOXES_PER_WEBHOOK} inboxes`);
  return opts;
}

function deploymentArgs(opts) {
  if (opts.prod) return ["--prod"];
  // The Convex CLI flag is `--deployment` (see `npx convex env --help`).
  if (opts.deploymentName) return ["--deployment", opts.deploymentName];
  return [];
}

/** Bounded provider call. Non-2xx bodies are discarded unread; nothing is printed. */
async function agentmail(apiKey, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${AGENTMAIL_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, ok: false, json: undefined };
    let json;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: true, json };
  } catch (e) {
    const aborted = controller.signal.aborted || (e && e.name === "AbortError");
    return { status: 0, ok: false, json: undefined, kind: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

const isRecord = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x) => (typeof x === "string" && x.length > 0 ? x : undefined);
const describe = (r) => (r.status ? `HTTP ${r.status}` : (r.kind ?? "network error"));

/** Normalizes the list endpoint's shape to an array of webhook records. */
function webhookList(json) {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of ["webhooks", "data", "items"]) if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function inboxIdsOf(hook) {
  return Array.isArray(hook.inbox_ids) ? hook.inbox_ids.filter((x) => typeof x === "string" && x.length > 0).map((x) => x.toLowerCase()) : [];
}

function setEnv(name, value, opts) {
  const result = spawnSync("npx", ["convex", "env", "set", ...deploymentArgs(opts), name], {
    input: `${value}\n`,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
  // Child output is deliberately discarded: the CLI may echo the value.
  if (result.error) return { ok: false, why: `spawn failed (${result.error.code ?? "unknown"})` };
  if (result.status !== 0) return { ok: false, why: `exit ${result.status}` };
  return { ok: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof process.loadEnvFile !== "function") fail("Node >= 20.12 with process.loadEnvFile is required");
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    fail(`could not load ${ENV_FILE}`);
  }
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) fail(`AGENTMAIL_API_KEY is missing from ${ENV_FILE}`);

  const targetUrl = `${opts.siteUrl}${WEBHOOK_PATH}`;
  const clientId = `frontdesk-${opts.siteName}`;
  const targetLabel = opts.prod ? "prod" : (opts.deploymentName ?? "dev");

  // 1. Every target inbox must actually be owned by this account.
  for (const inbox of opts.inboxes) {
    const r = await agentmail(apiKey, "GET", `/v0/inboxes/${encodeURIComponent(inbox)}`);
    if (!r.ok) fail(`inbox ${inbox} is not owned by this AgentMail account or could not be verified (${describe(r)})`);
    const id = isRecord(r.json) ? str(r.json.inbox_id) : undefined;
    if (id && id.toLowerCase() !== inbox) fail(`inbox ${inbox} resolved to a different id at the provider; refusing`);
  }
  console.log(`register-webhook: ${opts.inboxes.length} owned inbox(es) verified`);

  // 2. Find the product hook for this deployment, if any.
  const listed = await agentmail(apiKey, "GET", "/v0/webhooks");
  if (!listed.ok) fail(`could not list webhooks (${describe(listed)})`);
  const sameTarget = webhookList(listed.json).filter((w) => isRecord(w) && w.url === targetUrl);
  if (sameTarget.length > 1) {
    fail(`${sameTarget.length} webhooks target ${targetUrl}; delete the extras in the AgentMail dashboard so exactly one remains`, 2);
  }

  let webhookId;
  let secret;
  let inboxIds;
  if (sameTarget.length === 1) {
    const found = sameTarget[0];
    webhookId = str(found.webhook_id);
    if (!webhookId) fail("existing webhook has no id; refusing to guess");
    if (found.client_id !== clientId) {
      fail(`webhook ${webhookId} targets this deployment but was not registered by this product (client_id mismatch); it is left untouched`, 2);
    }
    const events = Array.isArray(found.event_types) ? found.event_types : [];
    if (!events.includes(EVENT_TYPE)) fail(`webhook ${webhookId} does not subscribe to ${EVENT_TYPE}; it is left untouched`, 2);
    if (inboxIdsOf(found).length === 0) {
      fail(`webhook ${webhookId} is not scoped to inboxes (organization-wide); it is left untouched. Delete it and re-run`, 2);
    }
    if (found.enabled === false) fail(`webhook ${webhookId} is disabled at the provider; enable it in the dashboard and re-run`, 2);
    // The signing secret is only readable on the single-hook endpoint.
    const got = await agentmail(apiKey, "GET", `/v0/webhooks/${encodeURIComponent(webhookId)}`);
    if (!got.ok || !isRecord(got.json)) fail(`could not read webhook ${webhookId} (${describe(got)})`);
    secret = str(got.json.secret);
    inboxIds = inboxIdsOf(got.json);
    if (!secret) fail(`webhook ${webhookId} exists but the provider returned no signing secret; delete it in the dashboard and re-run`, 2);
    console.log(`register-webhook: reusing ${webhookId} -> ${targetUrl} (${inboxIds.length} inbox(es) scoped)`);

    // 3. Append only the inboxes not yet covered; never replace the list.
    const missing = opts.inboxes.filter((x) => !inboxIds.includes(x));
    if (missing.length > 0) {
      if (inboxIds.length + missing.length > MAX_INBOXES_PER_WEBHOOK) {
        fail(`webhook ${webhookId} covers ${inboxIds.length} inboxes; adding ${missing.length} would exceed the provider limit of ${MAX_INBOXES_PER_WEBHOOK}`, 2);
      }
      const patched = await agentmail(apiKey, "PATCH", `/v0/webhooks/${encodeURIComponent(webhookId)}`, { add_inbox_ids: missing });
      if (!patched.ok) fail(`could not add ${missing.length} inbox(es) to webhook ${webhookId} (${describe(patched)})`);
      const after = isRecord(patched.json) ? inboxIdsOf(patched.json) : [];
      if (after.length > 0 && missing.some((x) => !after.includes(x))) fail(`provider did not confirm the appended inboxes on ${webhookId}`);
      inboxIds = after.length > 0 ? after : [...inboxIds, ...missing];
      console.log(`register-webhook: appended ${missing.length} inbox(es); ${inboxIds.length} now scoped`);
    } else {
      console.log("register-webhook: all target inboxes already scoped");
    }
  } else {
    // 4. Create the product hook, scoped from the start.
    const created = await agentmail(apiKey, "POST", "/v0/webhooks", {
      url: targetUrl,
      event_types: [EVENT_TYPE],
      inbox_ids: opts.inboxes,
      client_id: clientId,
    });
    if (!created.ok) fail(`webhook creation failed (${describe(created)})`);
    webhookId = isRecord(created.json) ? str(created.json.webhook_id) : undefined;
    secret = isRecord(created.json) ? str(created.json.secret) : undefined;
    inboxIds = isRecord(created.json) ? inboxIdsOf(created.json) : [];
    if (!webhookId) fail("webhook was created but no webhook_id came back; check the dashboard before retrying");
    if (!secret) fail(`webhook ${webhookId} was created but no signing secret came back; delete it and retry`);
    if (inboxIds.length === 0) inboxIds = opts.inboxes;
    console.log(`register-webhook: created ${webhookId} -> ${targetUrl} (${inboxIds.length} inbox(es) scoped)`);
  }
  if (!secret.startsWith("whsec_")) fail(`webhook ${webhookId} returned a secret in an unexpected format; not stored`);

  // 5. Store id + secret on the deployment (stdin only, outputs discarded).
  const idSet = setEnv(ID_VAR, webhookId, opts);
  if (!idSet.ok) fail(`webhook ${webhookId} is ready but ${ID_VAR} could not be set on ${targetLabel} (${idSet.why}); re-run`);
  const secretSet = setEnv(SECRET_VAR, secret, opts);
  if (!secretSet.ok) fail(`${ID_VAR} set but ${SECRET_VAR} could not be set on ${targetLabel} (${secretSet.why}); re-run`);
  console.log(`register-webhook: ${ID_VAR} and ${SECRET_VAR} set on ${targetLabel}`);
  console.log(`register-webhook: client_id ${clientId}; inn provisioning will append new inboxes to ${webhookId}`);
}

main().catch((e) => fail(e instanceof Error ? e.name : "unexpected failure"));
