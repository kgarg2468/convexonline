import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Watched pages of real inns are re-read hourly through the same store path
// as a staff crawl, so a changed passage re-checks every sent claim citing it.
crons.interval("rescrape watched pages", { hours: 1 }, internal.ingest.rescrapeDue, {});

export default crons;
