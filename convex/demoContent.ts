/**
 * Canned content for the per-visitor demo inn. Everything here is fictional.
 * The policies page has two versions so a judge can trigger a source change:
 * the pet fee and the check-in window move, the cancellation rule does not.
 */

export const DEMO_INN = {
  name: "Harbor Light Inn (demo)",
  siteUrl: "https://harborlight.example",
  timezone: "America/Los_Angeles",
};

export const POLICIES_V1 = `# Policies

## Check-in and check-out

Check-in is from 3:00 PM to 8:00 PM. Check-out is by 11:00 AM. Please email us if you expect to arrive after 8:00 PM so we can leave a lockbox code.

## Pets

Well-behaved dogs are welcome in the Garden Rooms for a **$25 per night pet fee**. Dogs may not be left unattended in the room.

## Cancellation

Reservations cancelled at least 7 days before arrival receive a full refund. Cancellations within 7 days forfeit the first night.

## Smoking

The inn is entirely non-smoking, including balconies and the garden.
`;

export const POLICIES_V2 = `# Policies

## Check-in and check-out

Check-in is from 4:00 PM to 9:00 PM. Check-out is by 11:00 AM. Please email us if you expect to arrive after 9:00 PM so we can leave a lockbox code.

## Pets

Well-behaved dogs are welcome in the Garden Rooms for a **$40 per night pet fee**, limited to one dog per room. Dogs may not be left unattended in the room.

## Cancellation

Reservations cancelled at least 7 days before arrival receive a full refund. Cancellations within 7 days forfeit the first night.

## Smoking

The inn is entirely non-smoking, including balconies and the garden.
`;

export const ROOMS_V1 = `# Rooms

## Garden Rooms

Four ground-floor rooms opening onto the garden. Each has a queen bed, a private bath with a walk-in shower, and a small patio. Garden Rooms are our pet-friendly rooms.

## Harbor View Rooms

Three second-floor rooms with a king bed, a soaking tub, and a balcony facing the harbor. Maximum occupancy is two adults.

## Amenities

All rooms include complimentary Wi-Fi, a Nespresso machine, robes, and a hair dryer. A full breakfast is served from 8:00 AM to 10:00 AM in the dining room.
`;

export const RATES_V1 = `# Rates

Garden Rooms are $189 per night midweek and $229 per night on Friday and Saturday. Harbor View Rooms are $259 per night midweek and $299 per night on Friday and Saturday.

A two-night minimum applies on weekends from May through October. Rates include breakfast and parking. Rates do not include the 10.5% lodging tax.
`;

export type DemoClaim = {
  statement: string;
  page: "policies" | "rooms" | "rates";
  quote: string;
};

export type DemoThread = {
  guestEmail: string;
  subject: string;
  inbound: string;
  hoursAgo: number;
  stay?: { checkIn?: string; checkOut?: string; party?: number; status: "inquiry" | "booked" };
  draft:
    | {
        kind: "sent";
        answer: string;
        claims: DemoClaim[];
      }
    | { kind: "ready"; answer: string; claims: DemoClaim[] }
    | { kind: "gap"; gapQuestion: string };
};

export const DEMO_THREADS: DemoThread[] = [
  {
    guestEmail: "dana.ruiz@example.com",
    subject: "Bringing our dog in October",
    inbound:
      "Hi! We're hoping to stay two nights the second weekend of October with our 30 lb dog, Biscuit. Is that OK and what does it cost?",
    hoursAgo: 70,
    stay: { checkIn: "2026-10-09", checkOut: "2026-10-11", party: 2, status: "inquiry" },
    draft: {
      kind: "sent",
      answer:
        "Hi Dana, Biscuit is very welcome. Well-behaved dogs stay in our Garden Rooms for a $25 per night pet fee, and we only ask that dogs are not left unattended in the room. Garden Rooms open straight onto the garden, which Biscuit will like. Let us know if you'd like us to hold one for October 9 to 11.",
      claims: [
        {
          statement: "Dogs are allowed in the Garden Rooms for a $25 per night pet fee.",
          page: "policies",
          quote: "Well-behaved dogs are welcome in the Garden Rooms for a $25 per night pet fee",
        },
        {
          statement: "Garden Rooms are the pet-friendly rooms.",
          page: "rooms",
          quote: "Garden Rooms are our pet-friendly rooms.",
        },
      ],
    },
  },
  {
    guestEmail: "m.okafor@example.com",
    subject: "Late arrival on Friday",
    inbound: "Our flight lands at 7pm so we probably won't reach you until 9:30. Is that a problem for check-in?",
    hoursAgo: 52,
    stay: { checkIn: "2026-10-02", checkOut: "2026-10-04", party: 2, status: "booked" },
    draft: {
      kind: "sent",
      answer:
        "Hi, thanks for letting us know. Check-in is from 3:00 PM to 8:00 PM, and since you'll arrive after 8:00 PM we'll leave a lockbox code for you. We'll send it the morning of your arrival.",
      claims: [
        {
          statement: "Check-in runs from 3:00 PM to 8:00 PM.",
          page: "policies",
          quote: "Check-in is from 3:00 PM to 8:00 PM.",
        },
        {
          statement: "Guests arriving after 8:00 PM get a lockbox code.",
          page: "policies",
          quote: "Please email us if you expect to arrive after 8:00 PM so we can leave a lockbox code.",
        },
      ],
    },
  },
  {
    guestEmail: "priya.n@example.com",
    subject: "Pet fee question",
    inbound: "Quick one: how much is the pet fee per night? Planning a midweek stay in November.",
    hoursAgo: 30,
    stay: { checkIn: "2026-11-10", checkOut: "2026-11-12", party: 1, status: "inquiry" },
    draft: {
      kind: "sent",
      answer:
        "Hi Priya, the pet fee is $25 per night, and dogs stay in our Garden Rooms. Midweek Garden Rooms are $189 per night.",
      claims: [
        {
          statement: "The pet fee is $25 per night.",
          page: "policies",
          quote: "$25 per night pet fee",
        },
        {
          statement: "Garden Rooms are $189 per night midweek.",
          page: "rates",
          quote: "Garden Rooms are $189 per night midweek",
        },
      ],
    },
  },
  {
    guestEmail: "theo.b@example.com",
    subject: "Cancellation policy",
    inbound: "If our plans change, how far in advance do we need to cancel to get a refund?",
    hoursAgo: 26,
    draft: {
      kind: "sent",
      answer:
        "Hi Theo, reservations cancelled at least 7 days before arrival receive a full refund. Within 7 days, the first night is forfeited.",
      claims: [
        {
          statement: "Cancellations at least 7 days before arrival are fully refunded.",
          page: "policies",
          quote: "Reservations cancelled at least 7 days before arrival receive a full refund.",
        },
      ],
    },
  },
  {
    guestEmail: "lin.family@example.com",
    subject: "Breakfast and Wi-Fi?",
    inbound: "Is breakfast included, and is there Wi-Fi in the rooms? Traveling with a laptop, sadly.",
    hoursAgo: 20,
    draft: {
      kind: "sent",
      answer:
        "Hi! Yes on both. A full breakfast is served from 8:00 AM to 10:00 AM in the dining room, and every room has complimentary Wi-Fi.",
      claims: [
        {
          statement: "Breakfast is served 8:00 to 10:00 AM.",
          page: "rooms",
          quote: "A full breakfast is served from 8:00 AM to 10:00 AM in the dining room.",
        },
        {
          statement: "Rooms include complimentary Wi-Fi.",
          page: "rooms",
          quote: "All rooms include complimentary Wi-Fi",
        },
      ],
    },
  },
  {
    guestEmail: "sam.wexler@example.com",
    subject: "Weekend rates for a Harbor View room",
    inbound: "What's the Saturday rate for a Harbor View room, and does that include tax?",
    hoursAgo: 3,
    stay: { checkIn: "2026-10-17", checkOut: "2026-10-18", party: 2, status: "inquiry" },
    draft: {
      kind: "ready",
      answer:
        "Hi Sam, Harbor View Rooms are $299 per night on Friday and Saturday. Rates include breakfast and parking but not the 10.5% lodging tax. Note that a two-night minimum applies on weekends from May through October.",
      claims: [
        {
          statement: "Harbor View Rooms are $299 per night on Friday and Saturday.",
          page: "rates",
          quote: "Harbor View Rooms are $259 per night midweek and $299 per night on Friday and Saturday.",
        },
        {
          statement: "Rates exclude the 10.5% lodging tax.",
          page: "rates",
          quote: "Rates do not include the 10.5% lodging tax.",
        },
        {
          statement: "Weekends May through October have a two-night minimum.",
          page: "rates",
          quote: "A two-night minimum applies on weekends from May through October.",
        },
      ],
    },
  },
  {
    guestEmail: "j.abernathy@example.com",
    subject: "Hot tub in December?",
    inbound: "We saw a hot tub in a photo. Is it open in December, and is it shared?",
    hoursAgo: 1,
    stay: { checkIn: "2026-12-12", checkOut: "2026-12-14", party: 2, status: "inquiry" },
    draft: {
      kind: "gap",
      gapQuestion: "Is the hot tub open in December, and is it shared or private?",
    },
  },
];
