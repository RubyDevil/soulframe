/**
 * A persona's hours as written: a `schedule` by weekday. What it means, and the checks that span blocks (overlaps,
 * lengths, every weekday planned once), are in schedule.ts.
 */

import { z } from 'zod';
import { CLOCK, scheduleIssues, type HoursIssue } from '../schedule.js';
import { addQuietIssue } from './issues.js';

const Clock = z.string().regex(CLOCK, 'a time as HH:MM');

/** [earliest, latest], local "HH:MM"; a latest before the earliest is on the next day. */
const ClockRange = z.tuple([Clock, Clock]);
export type ClockRange = z.infer<typeof ClockRange>;
/** Chance of a day with no online time at all. */
const SkipDayChance = z.number().min(0).max(0.9);
/** Chance that a block happens on a given day. */
const Chance = z.number().min(0).max(1).default(1);
/** The channels a span counts on, each one of the persona's (checked where they are known); left out, every channel it has. */
const On = z.array(z.string().min(1)).min(1).optional();
const BreakMinutes = z.number().int().min(2).max(30);

const SLEEP_WORDS = /\b(?:sleep(?:ing)?|asleep|bed|nap(?:ping)?)\b/i;
/**
 * What a busy block is, completing "you're ...": at work, at the gym, at a lecture, out with friends. The prompts use it
 * word for word (prompts.ts dayPrompt). Never sleep ("bed" in any sense).
 */
const BusyReason = z
	.string()
	.trim()
	.min(2)
	.max(40)
	.refine((reason) => !SLEEP_WORDS.test(reason), 'sleep is never a busy reason (the night is simply offline)');

/** Words of time spent talking: a busy plan is time away from the phone, never time with them in the chat it came from (dinner with them is a plan; chatting with them is not). */
const TALK_WORDS = /\b(?:online|chat(?:ting)?|text(?:ing)?|messag(?:e|es|ing))\b/i;

/**
 * The words a plan's own words may call the person it was made with by, in their chat ("at your party", "you're in"),
 * which prompts.ts `toOthers` says by their name in every prompt: the second person, which means them there, lowercase,
 * all in capitals, or capitalized but next to a capitalized word ("Yours Truly", "Thank You" are names); and texting's "u", "ur" and "ya"
 * (`TEXTED`), in lowercase and on their own only, never the "U" of "U.S." or "U-Haul", nor "Ya Ya's". A word's edges are
 * any letter's or mark's, accented ones too ("Céu" holds no "u"); "you" after a hyphen is no one ("thank-you"), before
 * one is them ("you-and-me"), and before an apostrophe a contraction (`toOthers` says those).
 */
export const ADDRESSED =
	/(?<![\p{L}\p{M}\p{N}_-])(?:you(?:rs|rself|rselves|r)?(?![\p{L}\p{M}\p{N}_'’])|(?<!\p{Lu}\p{L}*\s+)You(?:rs|rself|rselves|r)?(?![\p{L}\p{M}\p{N}_'’-])(?!\s+\p{Lu})|YOU(?:RS|RSELF|RSELVES|R)?(?![\p{L}\p{M}\p{N}_'’]))/gu;
export const TEXTED = /(?<![\p{L}\p{M}\p{N}_.'’-])(?:u|ur|ya)(?![\p{L}\p{M}\p{N}_'’-])(?!\.\p{L})/gu;
/**
 * Whether words may speak to someone, held to the strictest (whatever their case or what stands next to them: "at Your
 * party", "helping U move", "with u."), as calendar.ts reads a plan's words before telling them to others.
 */
const SPEAKS_TO = /(?<![\p{L}\p{M}\p{N}_])(?:you(?:rs|rself|rselves|r)?|u|ur|ya)(?![\p{L}\p{M}\p{N}_])/iu;
/** Words that point at someone of the conversation a plan came from, but not surely at whom (their party: theirs, or another's). */
const THIRD_PERSON = /\b(?:them|their|theirs|themselves)\b/i;

/**
 * A plan's words as its checks read them: look-alike letters as the plain ones (fullwidth, bold), accents off, so "ｓｃｈｏｏｌ"
 * and "école" are read as "school" and "ecole".
 */
const plainOf = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '');
/**
 * What a plan of its own may never be, held to the strictest, as the model wrote it: sleep joined to other words
 * ("sleepover", "bedtime"), and in the few other languages most likely.
 */
const PLAN_SLEEP_WORDS = /sleep|\bbed|\bnap(?:s|ped|ping)?\b|\bdoz(?:e|ed|ing)\b|snooz|slumber|schlaf|\bdorm|\bdurm|sommeil|sueno|slaap/i;

/** Whether a plan's words may speak to the person it was made with ("at your party", `SPEAKS_TO`), as written and read plain (`plainOf`). */
export const addresses = (words: string) => SPEAKS_TO.test(words) || SPEAKS_TO.test(plainOf(words));

/**
 * Why the reason of a plan the persona made itself (calendar.ts) is refused, or null: it completes "you're ..." as a
 * busy reason does, never sleep (held to the strictest: joined to other words, in other languages), never talking with them (`online`: a busy plan is offline time), never "them" or "their" (`person`: whom they meant
 * is not sure), nor, in words for anyone (`addressed` false: its public words), "you" or "your" (`ADDRESSED`), and only
 * words, in one short line (Latin letters once read plain, `plainOf`, digits, spaces, and , . ' ’ & -): a few plain
 * words at most, which every prompt quotes as data (prompts.ts busyText).
 */
export const planReasonProblem = (reason: string, { addressed = false }: { addressed?: boolean } = {}): string | null => {
	const text = reason.trim();
	if (text.length < 2 || text.length > 40) return 'length';
	const plain = plainOf(text);
	if (!/^[A-Za-z0-9 ,.'’&-]+$/.test(plain)) return 'characters';
	if (SLEEP_WORDS.test(plain) || PLAN_SLEEP_WORDS.test(plain)) return 'sleep';
	if (TALK_WORDS.test(plain)) return 'online';
	if (THIRD_PERSON.test(plain) || (!addressed && addresses(plain))) return 'person';
	return null;
};

const addHoursIssues = (issues: HoursIssue[], ctx: z.RefinementCtx) => {
	for (const { path, message } of issues) addQuietIssue(ctx, path, message);
};

/** One day's plan, or a day group's: full online time, short breaks for DMs only, and busy blocks with a reason. */
const DayPlanSchema = z.object({
	/** Replaces the schedule's on these days. */
	skipDayChance: SkipDayChance.optional(),
	online: z.array(z.object({ start: ClockRange, end: ClockRange, chance: Chance, on: On })).default([]),
	breaks: z.array(z.object({ start: ClockRange, minutes: z.tuple([BreakMinutes, BreakMinutes]), chance: Chance, on: On })).default([]),
	busy: z.array(z.object({ reason: BusyReason, start: ClockRange, end: ClockRange, chance: Chance })).default([]),
});

/** Hours that differ by weekday: `days` keyed by a day or a day group (schedule.ts daysOf), every weekday in exactly one. */
const ScheduleFields = z.object({ skipDayChance: SkipDayChance.default(0), days: z.record(z.string(), DayPlanSchema) });
export const ScheduleSchema = ScheduleFields.superRefine((schedule, ctx) => addHoursIssues(scheduleIssues(schedule), ctx));

export type ScheduleConfig = z.output<typeof ScheduleFields>;
/** One day's plan, or a day group's: { skipDayChance?, online, breaks, busy }. */
export type DayPlan = ScheduleConfig['days'][string];
