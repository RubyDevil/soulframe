/**
 * A persona's hours as written: a `window` (the same every day) or a `schedule` by weekday. What they mean, and the
 * checks that span blocks (overlaps, lengths, every weekday planned once), are in schedule.ts.
 */

import { z } from 'zod';
import { boundsIssues, CLOCK, scheduleIssues, type HoursIssue } from '../schedule.js';
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
 * For personas in 18+ conversations (the loader's `adult`): no busy reason about school, each refused at its path
 * (every "class" but "evening class").
 */
export const refuseSchool = ({ schedule }: { schedule?: { days: Record<string, { busy: { reason: string }[] }> } }, ctx: z.RefinementCtx) => {
	for (const [key, plan] of Object.entries(schedule?.days ?? {})) {
		plan.busy.forEach(({ reason }, index) => {
			if (SCHOOL_WORDS.test(reason)) ctx.addIssue({ code: 'custom', path: ['schedule', 'days', key, 'busy', index, 'reason'], message: 'no school or student framing (personas are adults); "at an evening class" at most' });
		});
	}
};

const addHoursIssues = (issues: HoursIssue[], ctx: z.RefinementCtx) => {
	for (const { path, message } of issues) addQuietIssue(ctx, path, message);
};

/** The same hours every day: a start and an end picked in their ranges each day (an end at or before the start is the next day). */
export const WindowSchema = z.object({ start: ClockRange, end: ClockRange, skipDayChance: SkipDayChance.default(0) }).superRefine((window, ctx) => addHoursIssues(boundsIssues(window), ctx));

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

export type WindowConfig = z.output<typeof WindowSchema>;
export type ScheduleConfig = z.output<typeof ScheduleFields>;
/** One day's plan, or a day group's: { skipDayChance?, online, breaks, busy }. */
export type DayPlan = ScheduleConfig['days'][string];
