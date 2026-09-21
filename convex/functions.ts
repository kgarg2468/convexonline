/**
 * App-owned function builders. Every mutation that can touch `threads`,
 * `sentReplies` or `corrections` (directly or through a shared helper) must be
 * defined with these so the aggregate triggers in `aggregates.ts` run in the
 * same transaction as the row write. Queries and actions keep the generated
 * builders; Convex Auth's own functions keep the generated roots as well.
 */
import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import { internalMutation as rawInternalMutation, mutation as rawMutation } from "./_generated/server";
import { triggers } from "./aggregates";

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB));
