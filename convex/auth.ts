import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import type { DataModel } from "./_generated/dataModel";

/**
 * Staff sign in with email + password. Judges use the Anonymous provider,
 * which creates an isolated user with `isAnonymous: true`; such users only
 * ever see per-user demo inns and can never send live mail (see access.ts).
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      profile(params) {
        const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error("A valid email address is required");
        }
        const name = typeof params.name === "string" ? params.name.trim() : "";
        return { email, name: name || email.split("@")[0], isAnonymous: false };
      },
      validatePasswordRequirements(password) {
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters");
        }
      },
    }),
    Anonymous({
      profile() {
        return { isAnonymous: true, name: "Demo visitor" };
      },
    }),
  ],
});
