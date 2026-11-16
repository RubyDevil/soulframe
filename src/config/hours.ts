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
const SCHOOL_WORDS = /\b(?:school|homework|lectures?|exams?|campus|students?|college|university|uni|teachers?|tutors?|(?<!evening )class(?:es)?)\b/i;
/**
 * What a busy block is, completing "you're ...": at work, at the gym, out with friends. The prompts use it word for word
 * (prompts.ts dayPrompt). Never sleep ("bed" in any sense); for 18+ conversations, nothing of school either (refuseSchool).
 */
const BusyReason = z
	.string()
	.trim()
	.min(2)
	.max(40)
	.refine((reason) => !SLEEP_WORDS.test(reason), 'sleep is never a busy reason (the night is simply offline)');

/**
 * For personas in 18+ conversations (`parsePersona`'s `adult`): no busy reason about school, each refused at its path
 * (every "class" but "evening class").
 */
export const refuseSchool = ({ schedule }: { schedule?: { days: Record<string, { busy: { reason: string }[] }> } }, ctx: z.RefinementCtx) => {
	for (const [key, plan] of Object.entries(schedule?.days ?? {})) {
		plan.busy.forEach(({ reason }, index) => {
			if (SCHOOL_WORDS.test(reason)) ctx.addIssue({ code: 'custom', path: ['schedule', 'days', key, 'busy', index, 'reason'], message: 'no school or student framing (personas are adults); "at an evening class" at most' });
		});
	}
};

/** Words of time spent talking: a busy plan is time away from the phone, never time with them in the chat it came from (dinner with them is a plan; chatting with them is not). */
const TALK_WORDS = /\b(?:online|chat(?:ting)?|text(?:ing)?|messag(?:e|es|ing))\b/i;

/**
 * The words a plan's own words may call the person it was made with by, in their chat ("at your party", "at ur place"):
 * calendar.ts `toOthers` names them for anyone else who may hear them. Only the second person, which means them there.
 */
export const ADDRESSED = /\b(?:you|your|yours|yourself|u|ur|ya)\b/gi;
/** Words that point at someone of the conversation a plan came from, but not surely at whom (their party: theirs, or another's). */
const THIRD_PERSON = /\b(?:them|their|theirs|themselves)\b/i;

/**
 * A plan's words as its checks read them: look-alike letters as the plain ones (fullwidth, bold), accents off, so "ｓｃｈｏｏｌ"
 * and "école" are read as "school" and "ecole".
 */
const plainOf = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '');
/**
 * What a plan of its own may never be, held to the strictest, as the model wrote it: sleep and school joined to other
 * words ("highschool", "sleepover", "bedtime"), in the few other languages most likely, and school's other words.
 */
const PLAN_SLEEP_WORDS = /sleep|\bbed|\bnap(?:s|ped|ping)?\b|\bdoz(?:e|ed|ing)\b|snooz|slumber|schlaf|\bdorm|\bdurm|sommeil|sueno|slaap/i;
const PLAN_SCHOOL_WORDS =
	/school|schul|ecole|escuel|escola|scuol|colegio|lycee|liceo|colleg|univers|\buni\b|homework|\blectures?\b|\bexams?\b|campus|student|teacher|\btutor|detention|\bprom\b|homeroom|\bgrade\b|\brecess\b|semester|classmate|\bpupils?\b|\b(?:clases?|classe|klassen?)\b/i;

/**
 * Why the reason of a plan the persona made itself (calendar.ts) is refused, or null: it completes "you're ..." as a
 * busy reason does, never sleep and never school (in any conversation: what the model writes is held to the strictest),
 * never talking with them (`online`: a busy plan is offline time), never "them" or "their" (`person`: whom they meant
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
	if (SCHOOL_WORDS.test(plain) || PLAN_SCHOOL_WORDS.test(plain)) return 'school';
	if (TALK_WORDS.test(plain)) return 'online';
	if (THIRD_PERSON.test(plain) || (!addressed && new RegExp(ADDRESSED.source, 'i').test(plain))) return 'person';
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
