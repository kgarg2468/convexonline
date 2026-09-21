import { ConvexError } from "convex/values";

export function describeError(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: string; message?: string; heldByName?: string | null; reason?: string };
    if (data?.code === "claimed") {
      return `Already claimed by ${data.heldByName ?? "another staff member"}.`;
    }
    if (data?.code === "unauthenticated") return "Please sign in.";
    if (data?.code === "forbidden") return data.message ?? "You do not have access to that.";
    if (data?.message) return data.message;
    return data?.code ?? "Something went wrong.";
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
