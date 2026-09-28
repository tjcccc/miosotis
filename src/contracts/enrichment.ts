import { z } from "zod";
import { IdempotencyKey } from "./common.js";

export const ENRICHMENT_SCHEMA_VERSION = 1;
export const ENRICHMENT_PIPELINE_VERSION = "enrichment.v1";

const ShortText = (max: number) => z.string().trim().min(1).max(max);

export const Assertion = z
  .object({
    text: ShortText(300).describe("The claim, briefly, in the source's own terms"),
    holder: z
      .enum(["user", "quoted_author", "group", "unknown"])
      .describe("Who asserts it. A quoted article's claim is not the user's belief."),
    modality: z
      .enum(["explicit", "tentative", "quoted", "inferred"])
      .describe("How strongly and directly it is asserted"),
  })
  .strict();

const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Local calendar date, YYYY-MM-DD");
const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local 24-hour time, HH:MM");

const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

/** How a plan repeats. Only common patterns; anything else stays a plain note. */
export const RepeatInput = z
  .object({
    every: z.enum(["day", "week", "month"]),
    interval: z.number().int().min(1).max(99).default(1).describe("Every N days/weeks/months (default 1)"),
    on: z.array(Weekday).min(1).max(7).optional().describe("Weekly: the weekdays (default: start.date's weekday)"),
    month_day: z
      .number()
      .int()
      .min(-1)
      .max(31)
      .refine((value) => value !== 0, "month_day is 1–31, or -1 for the last day")
      .optional()
      .describe("Monthly: the day of the month (-1 = last day; default: start.date's day)"),
    month_weekday: z
      .object({
        nth: z
          .number()
          .int()
          .min(-1)
          .max(5)
          .refine((value) => value !== 0, "nth is 1–5, or -1 for the last"),
        weekday: Weekday,
      })
      .strict()
      .optional()
      .describe("Monthly: e.g. the first Monday ({nth: 1, weekday: monday}) or the last Friday (nth: -1)"),
    until: LocalDate.optional().describe("Last possible date (inclusive)"),
    count: z.number().int().min(1).max(1000).optional().describe("Number of occurrences"),
  })
  .strict();

/** A dated arrangement stated in the source (a meeting, appointment, trip). */
export const EventInput = z
  .object({
    title: ShortText(200).describe("What it is, in the user's words (e.g. 'Roadmap discussion')"),
    start: z
      .object({
        date: LocalDate,
        time: LocalTime.optional().describe("Only when the source states a clock time"),
        part_of_day: z
          .enum(["morning", "afternoon", "evening", "night"])
          .optional()
          .describe("When the source says e.g. 'morning' but no clock time; never invent a time"),
      })
      .strict(),
    end: z
      .object({ date: LocalDate.optional(), time: LocalTime.optional() })
      .strict()
      .optional()
      .describe("Only when the source states an end"),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("IANA zone of the stated times; defaults to the zone the source was saved in"),
    location: ShortText(200).optional(),
    phrase: ShortText(300).optional().describe("The words in the source that state the time, copied exactly"),
    repeat: RepeatInput.optional().describe(
      "Only when the source states a repeating plan ('every Monday'); start.date is the first possible date",
    ),
    replaces: z.string().min(1).optional().describe("V-… of an earlier event this one reschedules"),
    occurrence: LocalDate.optional().describe(
      "With replaces on a repeating event: the one date this event replaces. Without it, the series is replaced from this event's start on",
    ),
  })
  .strict();

export const CancelInput = z.union([
  z.string().min(1).describe("V-…: the whole event (or series)"),
  z
    .object({
      event: z.string().min(1),
      date: LocalDate.optional().describe("Only this occurrence"),
      from: LocalDate.optional().describe("This and every later occurrence"),
    })
    .strict(),
]);

export const EnrichmentRequest = z
  .object({
    schema: z.literal("miosotis.enrichment.v1").optional(),
    idempotency_key: IdempotencyKey.optional(),
    source_ref: z
      .object({
        id: z.string().min(1),
        version: z.number().int().min(1),
        input_digest: z.string().min(1).describe("Copy from `enrich prepare`; binds this result to the exact revision"),
      })
      .strict(),
    title: ShortText(120).optional(),
    abstract: ShortText(600).optional().describe("What the source says, not what it proves"),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .optional()
      .describe("BCP-47 tag of the main language"),
    terms: z
      .array(ShortText(64))
      .max(24)
      .default([])
      .describe("Retrieval terms. Include useful synonyms and translations in other languages the user may search in."),
    entities: z
      .array(z.object({ name: ShortText(120), type: ShortText(40).optional() }).strict())
      .max(24)
      .default([]),
    project_suggestions: z
      .array(z.string().min(1))
      .max(5)
      .default([])
      .describe("IDs (P-…) of existing projects only; stored as inferred, never overriding explicit membership"),
    assertions: z.array(Assertion).max(10).default([]),
    coverage: z
      .object({
        read_chars: z.number().int().min(0),
        total_chars: z.number().int().min(0),
      })
      .strict()
      .optional()
      .describe("How much of the text was actually read"),
    interpretations: z
      .array(
        z
          .object({
            payload_sha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .describe("sha256 of the image payload you looked at (from source get)"),
            description: ShortText(2000).describe("What the image shows, factually"),
            transcription: z
              .string()
              .trim()
              .max(20_000)
              .optional()
              .describe("Visible text, transcribed verbatim; omit what you cannot read"),
            observations: z
              .array(
                z
                  .object({
                    text: ShortText(500),
                    legibility: z
                      .enum(["clear", "uncertain"])
                      .describe("uncertain = partly unreadable; never guess numbers"),
                  })
                  .strict(),
              )
              .max(30)
              .default([]),
          })
          .strict(),
      )
      .max(20)
      .default([])
      .describe("Image interpretations by a vision-capable host, each bound to the exact image bytes"),
    events: z
      .array(EventInput)
      .max(20)
      .default([])
      .describe(
        "Dated arrangements the source states (meetings, appointments). Resolve relative dates from received_at and timezone in `enrich prepare`. Send them again on every re-enrichment.",
      ),
    cancels: z
      .array(CancelInput)
      .max(20)
      .default([])
      .describe(
        'Events this source cancels: "V-…", {event, date} for one occurrence, or {event, from} to end a series',
      ),
    warnings: z.array(ShortText(300)).max(10).default([]),
    model: ShortText(120)
      .nullable()
      .optional()
      .describe("Model name only if the host reports it reliably; otherwise omit"),
  })
  .strict();

export type EventRequestInput = z.input<typeof EventInput>;
export type CancelRequestInput = z.input<typeof CancelInput>;
export type EnrichmentRequest = z.infer<typeof EnrichmentRequest>;
export type EnrichmentRequestInput = z.input<typeof EnrichmentRequest>;
