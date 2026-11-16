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

/** Words of time spent talking: a busy plan is time away from the phone, never time with them in the chat it came from. */
const TALK_WORDS = /\b(?:online|chat(?:ting)?|text(?:ing)?|messag(?:e|es|ing)|with (?:them|you))\b/i;

/**
 * Words that point at someone in the conversation a plan came from ("at your party", "at their place"): every turn with
 * anyone reads its calendar, where "your" would be whoever it talks with then.
 */
const ADDRESS_WORDS = /\b(?:you|your|yours|yourself|them|their|theirs|themselves)\b/i;

/**
 * Why the reason of a plan the persona made itself (calendar.ts) is refused, or null: it completes "you're ..." as a
 * busy reason does, never sleep and never school (in any conversation: what the model writes is held to the strictest),
 * never talking with them (`online`: a busy plan is offline time), never pointing at someone of the conversation it
 * came from (`person`: every conversation reads it), and only words, in one short line (letters, digits, spaces, and
 * , . ' ’ & -): a few plain words at most, which every prompt quotes as data (prompts.ts busyText).
 */
export const planReasonProblem = (reason: string): string | null => {
	const text = reason.trim();
	if (text.length < 2 || text.length > 40) return 'length';
	if (!/^[\p{L}\p{N} ,.'’&-]+$/u.test(text)) return 'characters';
	if (SLEEP_WORDS.test(text)) return 'sleep';
	if (SCHOOL_WORDS.test(text)) return 'school';
	if (TALK_WORDS.test(text)) return 'online';
	if (ADDRESS_WORDS.test(text)) return 'person';
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
