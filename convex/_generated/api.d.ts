/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as corrections from "../corrections.js";
import type * as demo from "../demo.js";
import type * as demoContent from "../demoContent.js";
import type * as drafts from "../drafts.js";
import type * as facts from "../facts.js";
import type * as http from "../http.js";
import type * as inns from "../inns.js";
import type * as lib_claimLocks from "../lib/claimLocks.js";
import type * as lib_quotes from "../lib/quotes.js";
import type * as lib_sourceChange from "../lib/sourceChange.js";
import type * as lib_tenant from "../lib/tenant.js";
import type * as pages from "../pages.js";
import type * as providers_agentmail from "../providers/agentmail.js";
import type * as providers_firecrawl from "../providers/firecrawl.js";
import type * as providers_index from "../providers/index.js";
import type * as providers_openai from "../providers/openai.js";
import type * as providers_shared from "../providers/shared.js";
import type * as threads from "../threads.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  corrections: typeof corrections;
  demo: typeof demo;
  demoContent: typeof demoContent;
  drafts: typeof drafts;
  facts: typeof facts;
  http: typeof http;
  inns: typeof inns;
  "lib/claimLocks": typeof lib_claimLocks;
  "lib/quotes": typeof lib_quotes;
  "lib/sourceChange": typeof lib_sourceChange;
  "lib/tenant": typeof lib_tenant;
  pages: typeof pages;
  "providers/agentmail": typeof providers_agentmail;
  "providers/firecrawl": typeof providers_firecrawl;
  "providers/index": typeof providers_index;
  "providers/openai": typeof providers_openai;
  "providers/shared": typeof providers_shared;
  threads: typeof threads;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
