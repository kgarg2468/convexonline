/**
 * Hosted fictional inn website: structured content, validation, hosted-path
 * helpers and the HTML renderer. Pure TypeScript (no Convex imports) so it is
 * unit-testable offline and callable from HTTP actions, mutations and the
 * crawl selection code.
 *
 * Every value that reaches the page goes through `escapeHtml`; the content
 * model is a fixed set of bounded plain-text fields and numbers, never HTML.
 */

// ---- Content model ----------------------------------------------------------

export const HOSTED_PATH_PREFIX = "/inn/";

export type HostedPage = "home" | "policies" | "rooms" | "notices";
export const HOSTED_PAGES: readonly HostedPage[] = ["home", "policies", "rooms", "notices"];

/** Path segment under the inn prefix for each page ("" is the site root). */
const PAGE_SEGMENT: Record<HostedPage, string> = { home: "", policies: "policies", rooms: "rooms", notices: "notices" };
const SEGMENT_PAGE: Record<string, HostedPage> = { "": "home", policies: "policies", rooms: "rooms", notices: "notices" };

export type InnWebsiteContent = {
  publicName: string;
  intro: string;
  checkIn: string;
  checkOut: string;
  /** USD per dog per night; whole dollars. */
  petFeePerDogPerNight: number;
  maxDogs: number;
  petPolicy: string;
  breakfastHours: string;
  wifi: string;
  roomsDescription: string;
  notice: string;
};

export const CONTENT_LIMITS = {
  publicName: { min: 1, max: 80 },
  intro: { min: 0, max: 600 },
  checkIn: { min: 1, max: 40 },
  checkOut: { min: 1, max: 40 },
  petPolicy: { min: 0, max: 800 },
  breakfastHours: { min: 1, max: 80 },
  wifi: { min: 0, max: 120 },
  roomsDescription: { min: 0, max: 1200 },
  notice: { min: 0, max: 600 },
  petFeePerDogPerNight: { min: 0, max: 500 },
  maxDogs: { min: 0, max: 6 },
} as const;

/** Illustrative defaults for a brand-new fictional inn; every value is clearly made up. */
export function defaultWebsiteContent(publicName: string): InnWebsiteContent {
  return {
    publicName,
    intro:
      "A small, fictional inn used to demonstrate front-desk software. Nothing on this site describes a real business; the policies below are illustrative only.",
    checkIn: "3:00 PM",
    checkOut: "11:00 AM",
    petFeePerDogPerNight: 25,
    maxDogs: 2,
    petPolicy: "Dogs are welcome in our designated pet-friendly rooms. Please let us know when booking so we can assign a suitable room.",
    breakfastHours: "7:00 AM to 9:00 AM",
    wifi: "Free Wi-Fi is available throughout the inn.",
    roomsDescription:
      "Six guest rooms, each with a private bathroom, a queen or king bed, and a small desk. Two ground-floor rooms are designated pet-friendly.",
    notice: "",
  };
}

const STRING_FIELDS = [
  "publicName",
  "intro",
  "checkIn",
  "checkOut",
  "petPolicy",
  "breakfastHours",
  "wifi",
  "roomsDescription",
  "notice",
] as const;
const NUMBER_FIELDS = ["petFeePerDogPerNight", "maxDogs"] as const;

/** Multi-line fields keep newlines (rendered as paragraphs); the rest collapse to one line. */
const MULTILINE: ReadonlySet<string> = new Set(["intro", "petPolicy", "roomsDescription", "notice"]);

export class InnWebsiteContentError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InnWebsiteContentError";
  }
}

/** C0 controls except tab/newline/CR, plus DEL. Matching them is the point: they are stripped from content. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS =new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

function cleanText(raw: string, multiline: boolean): string {
  // Drop control characters, then normalise whitespace.
  const stripped = raw.replace(CONTROL_CHARS, "");
  if (!multiline) return stripped.replace(/\s+/g, " ").trim();
  return stripped
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Validates and normalises an untrusted content object. Unknown keys are
 * ignored; every known field must be present with the right type and within
 * its bounds. Throws InnWebsiteContentError on the first problem.
 */
export function normalizeWebsiteContent(input: Record<string, unknown>): InnWebsiteContent {
  const out: Partial<InnWebsiteContent> = {};
  for (const field of STRING_FIELDS) {
    const raw = input[field];
    if (typeof raw !== "string") throw new InnWebsiteContentError(field, `${field} must be text`);
    const value = cleanText(raw, MULTILINE.has(field));
    const { min, max } = CONTENT_LIMITS[field];
    if (value.length < min) throw new InnWebsiteContentError(field, `${field} is required`);
    if (value.length > max) throw new InnWebsiteContentError(field, `${field} must be at most ${max} characters`);
    out[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const raw = input[field];
    const { min, max } = CONTENT_LIMITS[field];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
      throw new InnWebsiteContentError(field, `${field} must be a whole number between ${min} and ${max}`);
    }
    out[field] = raw;
  }
  return out as InnWebsiteContent;
}

// ---- Hosted URL helpers -----------------------------------------------------

/** `${origin}/inn/<innId>/` for the given site origin (any path on `origin` is discarded). */
export function hostedSiteUrl(siteOrigin: string, innId: string): string {
  return `${new URL(siteOrigin).origin}${HOSTED_PATH_PREFIX}${innId}/`;
}

export function hostedPagePath(innId: string, page: HostedPage): string {
  const segment = PAGE_SEGMENT[page];
  return `${HOSTED_PATH_PREFIX}${innId}/${segment}`;
}

/** The canonical URLs of the four public pages, used as crawl seeds. */
export function hostedPageUrls(siteUrl: string): string[] {
  const parsed = parseHostedSiteUrl(siteUrl);
  if (!parsed) return [];
  return HOSTED_PAGES.map((page) => `${parsed.origin}${hostedPagePath(parsed.innId, page)}`);
}

/** Raw, un-decoded path segments of a pathname (an encoded slash stays inside its segment). */
export function rawPathSegments(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

const INN_ID_SEGMENT = /^[A-Za-z0-9]{8,64}$/;

/**
 * Parses a request pathname under the hosted prefix. Accepts an optional
 * trailing slash on every page; anything else (extra segments, encoded
 * characters, unknown pages) is null → 404.
 */
export function parseHostedPath(pathname: string): { innId: string; page: HostedPage } | null {
  if (!pathname.startsWith(HOSTED_PATH_PREFIX)) return null;
  const rest = pathname.slice(HOSTED_PATH_PREFIX.length);
  const parts = rest.split("/");
  // "<id>" | "<id>","" | "<id>","page" | "<id>","page","" — nothing else.
  if (parts.length > 3) return null;
  if (parts.length === 3 && (parts[1] === "" || parts[2] !== "")) return null;
  const [innId, segment = ""] = parts;
  if (!INN_ID_SEGMENT.test(innId)) return null;
  const page = Object.prototype.hasOwnProperty.call(SEGMENT_PAGE, segment) ? SEGMENT_PAGE[segment] : undefined;
  if (!page) return null;
  return { innId, page };
}

/** Recognises `https://<origin>/inn/<innId>/` (trailing slash optional). */
export function parseHostedSiteUrl(siteUrl: string): { origin: string; innId: string } | null {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.search || u.hash) return null;
  const segments = rawPathSegments(u.pathname);
  if (segments.length !== 2 || segments[0] !== "inn" || !INN_ID_SEGMENT.test(segments[1])) return null;
  if (u.pathname !== `/inn/${segments[1]}` && u.pathname !== `/inn/${segments[1]}/`) return null;
  return { origin: u.origin, innId: segments[1] };
}

/**
 * True when `siteUrl` is the hosted site of exactly this inn. Only then does
 * crawl selection switch from same-origin to same-path-prefix.
 */
export function isOwnHostedSite(siteUrl: string, innId: string): boolean {
  const parsed = parseHostedSiteUrl(siteUrl);
  return parsed !== null && parsed.innId === innId;
}

/**
 * True when `url` is the hosted site root of `innId` or a descendant of it on
 * the same origin. Compared segment by segment on the raw path, so
 * `/inn/<id>x`, `/inn/<id>%2Ffoo` and `/inn/other` never match. A path that
 * needs decoding to look like the prefix is rejected rather than guessed at.
 */
export function isWithinHostedSite(url: string, siteUrl: string): boolean {
  const site = parseHostedSiteUrl(siteUrl);
  if (!site) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== site.origin) return false;
  const segments = rawPathSegments(u.pathname);
  if (segments.length < 2) return false;
  if (segments[0] !== "inn" || segments[1] !== site.innId) return false;
  for (const segment of segments) {
    if (segment.includes("%") || segment === "." || segment === "..") return false;
  }
  return true;
}

// ---- Rendering --------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return blocks.map((b) => `<p>${escapeHtml(b).replace(/\n/g, "<br>")}</p>`).join("\n");
}

function dollars(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function dogsPhrase(maxDogs: number): string {
  if (maxDogs === 0) return "no dogs";
  return maxDogs === 1 ? "one dog" : `up to ${maxDogs} dogs`;
}

/** One sentence per policy so scraped markdown carries quotable, fact-shaped lines. */
export function policySentences(c: InnWebsiteContent): Record<"checkIn" | "checkOut" | "pets" | "breakfast", string> {
  const pets =
    c.maxDogs === 0
      ? "Pets are not permitted at this time."
      : `Dogs are welcome for a fee of ${dollars(c.petFeePerDogPerNight)} per dog per night, with ${dogsPhrase(c.maxDogs)} per room in designated pet-friendly rooms.`;
  return {
    checkIn: `Check-in begins at ${c.checkIn}.`,
    checkOut: `Check-out is by ${c.checkOut}.`,
    pets,
    breakfast: `Breakfast is served from ${c.breakfastHours}.`,
  };
}

const PAGE_TITLES: Record<HostedPage, string> = { home: "Welcome", policies: "Policies", rooms: "Rooms", notices: "Notices" };

const STYLES = `
:root{--ink:#1f2a24;--muted:#5d6b64;--paper:#f7f4ee;--card:#ffffff;--line:#d9d3c7;--accent:#2f6b4f;--warn:#8a5a00;--warn-bg:#fff4dc}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Georgia,"Times New Roman",serif}
a{color:var(--accent)}
.wrap{max-width:720px;margin:0 auto;padding:24px 20px 48px}
.fictional{background:var(--warn-bg);color:var(--warn);border:1px solid #e8cf98;border-radius:6px;padding:8px 12px;font:14px/1.4 system-ui,sans-serif;margin-bottom:20px}
header h1{font-size:30px;margin:0 0 4px;letter-spacing:.2px}
header .tag{color:var(--muted);font-style:italic;margin:0 0 16px}
nav{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:10px 0;margin-bottom:24px;font:15px system-ui,sans-serif}
nav a{text-decoration:none;padding:4px 10px;border-radius:999px}
nav a[aria-current="page"]{background:var(--accent);color:#fff}
h2{font-size:22px;margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:12px 0}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
dl.facts dt{color:var(--muted);font:14px system-ui,sans-serif;padding-top:2px}
dl.facts dd{margin:0}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font:13px/1.5 system-ui,sans-serif}
@media print{nav,.fictional{display:none}body{background:#fff}}
`.trim();

export type RenderArgs = {
  innId: string;
  page: HostedPage;
  content: InnWebsiteContent;
};

function facts(c: InnWebsiteContent): string {
  const rows: Array<[string, string]> = [
    ["Check-in", c.checkIn],
    ["Check-out", c.checkOut],
    ["Dogs", c.maxDogs === 0 ? "Not permitted" : `${dollars(c.petFeePerDogPerNight)} per dog per night, ${dogsPhrase(c.maxDogs)}`],
    ["Breakfast", c.breakfastHours],
  ];
  if (c.wifi) rows.push(["Wi-Fi", c.wifi]);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
}

function body(c: InnWebsiteContent, page: HostedPage): string {
  const s = policySentences(c);
  switch (page) {
    case "home":
      return [
        c.intro ? paragraphs(c.intro) : "",
        `<h2>At a glance</h2><div class="card">${facts(c)}</div>`,
        c.notice ? `<h2>Current notice</h2><div class="card">${paragraphs(c.notice)}</div>` : "",
      ].join("\n");
    case "policies":
      return [
        `<h2>Arrival and departure</h2><p>${escapeHtml(s.checkIn)}</p><p>${escapeHtml(s.checkOut)}</p>`,
        `<h2>Pets</h2><p>${escapeHtml(s.pets)}</p>${c.petPolicy ? paragraphs(c.petPolicy) : ""}`,
        `<h2>Breakfast</h2><p>${escapeHtml(s.breakfast)}</p>`,
        c.wifi ? `<h2>Wi-Fi</h2><p>${escapeHtml(c.wifi)}</p>` : "",
      ].join("\n");
    case "rooms":
      return [
        c.roomsDescription ? paragraphs(c.roomsDescription) : "<p>Room details will be posted soon.</p>",
        `<h2>Travelling with a dog?</h2><p>${escapeHtml(s.pets)}</p>`,
      ].join("\n");
    case "notices":
      return c.notice ? paragraphs(c.notice) : "<p>There are no current notices.</p>";
  }
}

/** Full HTML document for one hosted page. Every dynamic value is escaped. */
export function renderHostedPage({ innId, page, content }: RenderArgs): string {
  const name = escapeHtml(content.publicName);
  const title = page === "home" ? `${name} (fictional inn)` : `${escapeHtml(PAGE_TITLES[page])} · ${name} (fictional inn)`;
  const nav = HOSTED_PAGES.map((p) => {
    const href = escapeHtml(hostedPagePath(innId, p));
    const current = p === page ? ' aria-current="page"' : "";
    return `<a href="${href}"${current}>${escapeHtml(p === "home" ? "Home" : PAGE_TITLES[p])}</a>`;
  }).join("");
  const heading = page === "home" ? name : escapeHtml(PAGE_TITLES[page]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<div class="fictional" role="note">Fictional inn. This website is a software demonstration; it does not describe a real business and its policies are illustrative only.</div>
<header>
<h1>${name}</h1>
<p class="tag">A fictional inn</p>
<nav aria-label="Site">${nav}</nav>
</header>
<main>
<h2 class="page-title">${heading}</h2>
${body(content, page)}
</main>
<footer>${name} is a fictional inn created for a front-desk software demonstration. Nothing here is a real offer.</footer>
</div>
</body>
</html>
`;
}

/** Plain-text 404 body; never echoes the requested path. */
export const NOT_FOUND_BODY = "Not found\n";
