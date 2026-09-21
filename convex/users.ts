import { query } from "./_generated/server";
import { currentUser } from "./access";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      isAnonymous: user.isAnonymous === true,
    };
  },
});
