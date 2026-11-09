import type { ClockRange, DayPlan, ScheduleConfig } from './config/hours.js';
import { between, seededRng, type Rng } from './rng.js';
import { DAY, HOUR, MINUTE } from './settings.js';
import type { ChannelId } from './channel.js';

/**
 * A persona's agenda: for each local date, the exact online spans and busy blocks drawn from its hours (config/hours.ts
 * `schedule`), in its own time zone. Each day is seeded by the persona and the date, so a restart draws the same agenda.
 * A block belongs to the day whose plan made it, past midnight too.
 */

/** 0 = Monday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface LocalDate {
	year: number;
	month: number;
	day: number;
}
/** What the agenda needs of a persona (a PersonaConfig satisfies it). */
export interface Hours {
	id: string;
	timezone: string;
	schedule: ScheduleConfig;
}
/** Online time: `online` allows everything, `break` only DMs. `on` undefined = every channel. `day` = the agenda day it belongs to. */
export interface Span {
	kind: 'online' | 'break';
	start: number;
	end: number;
	on?: readonly ChannelId[];
	day: LocalDate;
}
/** Offline time with a reason that completes "you're ...". */
export interface Busy {
	reason: string;
	start: number;
	end: number;
	day: LocalDate;
}
export interface DayAgenda {
	day: LocalDate;
	skipped: boolean;
	spans: readonly Span[];
	busy: readonly Busy[];
}
/** Facts for the prompt while online: the span, what a break interrupts, the next busy block (36 h; null on a break from one), the next full span on this channel. */
export interface Situation {
	/** The moment it describes. */
	at: number;
	span: Span;
	busy: Busy | null;
	nextBusy: Busy | null;
	nextOnline: Span | null;
}
export interface HoursIssue {
	path: (string | number)[];
	message: string;
}

const DAY_MINUTES = 24 * 60;

/** "HH:MM" on a 24-hour clock. */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export const parseClock = (clock: string) => {
	const [hours, minutes] = clock.split(':').map(Number);
	return hours! * 60 + minutes!;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterOf = (timeZone: string) => {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
			hourCycle: 'h23',
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
};

const partsAt = (ms: number, timeZone: string) => {
	const parts = Object.fromEntries(formatterOf(timeZone).formatToParts(ms).map((part) => [part.type, Number(part.value)]));
	return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
};

/** The zone's offset from UTC at `ms`, in milliseconds. */
const offsetAt = (ms: number, timeZone: string) => {
	const p = partsAt(ms, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/** The first minute after `before` with the offset `after` has: where the clocks jumped between them. */
const jumpBetween = (before: number, after: number, timeZone: string) => {
	const offset = offsetAt(after, timeZone);
	while (after - before > MINUTE) {
		const middle = before + Math.floor((after - before) / (2 * MINUTE)) * MINUTE;
		if (offsetAt(middle, timeZone) === offset) after = middle;
		else before = middle;
	}
	return after;
};

/**
 * The instant of a local date and minute of day (minutes past 1440 roll into the next day). A time a spring-forward
 * jump skips maps to the moment of the jump, so a later local time never maps to an earlier instant.
 */
export function zonedToUtc(date: LocalDate, minutes: number, timeZone: string): number {
	const wall = Date.UTC(date.year, date.month - 1, date.day, 0, Math.round(minutes));
	const first = wall - offsetAt(wall, timeZone);
	// Across a daylight saving change the offset at the result can differ from the guess's
	const at = wall - offsetAt(first, timeZone);
	// In the skipped hour neither reads back as `wall`: the jump lies between them
	return at + offsetAt(at, timeZone) === wall ? at : jumpBetween(Math.min(first, at), Math.max(first, at), timeZone);
}

export const localDateOf = (ms: number, timeZone: string): LocalDate => {
	const p = partsAt(ms, timeZone);
	return { year: p.year, month: p.month, day: p.day };
};

export const addDays = (date: LocalDate, days: number): LocalDate => {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

// ---------------------------------------------------------------------------------------------------
// Days and ranges
// ---------------------------------------------------------------------------------------------------

/** The day tokens of `schedule.days` keys, by Weekday. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const weekdayOf = (date: LocalDate) => ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7) as Weekday;

/** The weekdays of a day key: "mon", "mon-fri", "fri-mon" (wrapping), "sat,sun", "mon-wed,fri"; null when it isn't one. */
export function daysOf(key: string): Weekday[] | null {
	const days: Weekday[] = [];
	for (const part of key.split(',')) {
		const tokens = part.split('-').map((token) => (WEEKDAYS as readonly string[]).indexOf(token));
		const first = tokens[0]!;
		const last = tokens[1] ?? first;
		if (tokens.length > 2 || first === -1 || last === -1) return null;
		for (let day = first; ; day = (day + 1) % 7) {
			days.push(day as Weekday);
			if (day === last) break;
		}
	}
	return days;
}

/** The `days` key that plans a weekday (the first, if two do). */
const keyFor = (schedule: ScheduleConfig, weekday: Weekday) => Object.keys(schedule.days).find((key) => daysOf(key)?.includes(weekday));
const planFor = (schedule: ScheduleConfig, weekday: Weekday) => {
	const key = keyFor(schedule, weekday);
	return key === undefined ? undefined : schedule.days[key];
};

/** A range in minutes of the day: a latest before the earliest is on the next day. */
const rangeOf = ([earliest, latest]: ClockRange): [number, number] => {
	const from = parseClock(earliest);
	const to = parseClock(latest);
	return [from, to < from ? to + DAY_MINUTES : to];
};

/**
 * A block's start and end ranges in minutes of its day, and the `offset` that puts the end at its first occurrence
 * after the start: the next day when its earliest is at or before the earliest start.
 */
const boundsOf = (block: { start: ClockRange; end: ClockRange }) => {
	const start = rangeOf(block.start);
	const end = rangeOf(block.end);
	return { start, end, offset: end[0] <= start[0] ? DAY_MINUTES : 0 };
};

const pick = (rng: Rng, [from, to]: [number, number], offset = 0) => between(rng, from, to) + offset;

/** A block's start and end in minutes of its day: the start drawn first. */
const timesOf = (rng: Rng, block: { start: ClockRange; end: ClockRange }): [number, number] => {
	const { start, end, offset } = boundsOf(block);
	return [pick(rng, start), pick(rng, end, offset)];
};

/** "HH:MM" of minutes: a length. */
const hoursText = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** "HH:MM" of minutes of a day: a time on the clock, past midnight too. */
const clockOf = (minutes: number) => hoursText(minutes % DAY_MINUTES);

const MAX_SPREAD = 12 * 60;
const MAX_LENGTH = 20 * 60;

const clocksValid = (...ranges: ClockRange[]) => ranges.flat().every((clock) => CLOCK.test(clock));

/** A range over 12 hours, at `key`: likely its earliest and latest swapped. */
const spreadIssues = (key: 'start' | 'end', [from, to]: [number, number]): HoursIssue[] =>
	to - from > MAX_SPREAD ? [{ path: [key], message: `a range of ${hoursText(to - from)} hours: are earliest and latest swapped? (a latest before the earliest is the next day)` }] : [];

/**
 * What is wrong with a block's start and end ranges: a range over 12 hours (likely swapped), an end that can come before
 * its start, or a block that can last over 20 hours. Clocks that aren't "HH:MM" are left to the schema.
 */
export function boundsIssues(block: { start: ClockRange; end: ClockRange }): HoursIssue[] {
	if (!clocksValid(block.start, block.end)) return [];
	const { start, end, offset } = boundsOf(block);
	const issues = [...spreadIssues('start', start), ...spreadIssues('end', end)];
	if (issues.length) return issues;
	if (end[0] + offset <= start[1]) issues.push({ path: ['end'], message: `can end before it starts (start up to ${clockOf(start[1])}, end from ${clockOf(end[0])})` });
	const longest = end[1] + offset - start[0];
	if (longest > MAX_LENGTH) issues.push({ path: ['end'], message: `lasts up to ${hoursText(longest)} hours (at most 20)` });
	return issues;
}

/** A block of a day plan as the overlap checks see it: the most it can cover, in minutes of its day. */
interface Extent {
	path: ['online' | 'breaks' | 'busy', number];
	/** How messages name it: 'online.0', 'busy.1 "at the gym"'. */
	name: string;
	from: number;
	to: number;
	/** A busy block's core, the time it always covers: from its latest start to its earliest end. */
	core?: [number, number];
}

const under = (prefix: (string | number)[], issues: HoursIssue[]) => issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] }));

/** A plan's bounds problems, and the extents of its blocks that have none (the others are left out of the overlap checks). */
function extentsOf(plan: DayPlan): { issues: HoursIssue[]; extents: Extent[] } {
	const issues: HoursIssue[] = [];
	const extents: Extent[] = [];
	const ranged = (kind: 'online' | 'busy', index: number, block: { start: ClockRange; end: ClockRange }, name: string) => {
		if (!clocksValid(block.start, block.end)) return;
		const found = boundsIssues(block);
		issues.push(...under([kind, index], found));
		if (found.length) return;
		const { start, end, offset } = boundsOf(block);
		extents.push({ path: [kind, index], name, from: start[0], to: end[1] + offset, ...(kind === 'busy' && { core: [start[1], end[0] + offset] as [number, number] }) });
	};
	plan.online.forEach((block, index) => ranged('online', index, block, `online.${index}`));
	plan.busy.forEach((block, index) => ranged('busy', index, block, `busy.${index} "${block.reason}"`));
	plan.breaks.forEach((block, index) => {
		if (!clocksValid(block.start)) return;
		const start = rangeOf(block.start);
		const [fewest, most] = block.minutes;
		const found = [...spreadIssues('start', start), ...(fewest > most ? [{ path: ['minutes'], message: 'the first number must not be above the second' }] : [])];
		issues.push(...under(['breaks', index], found));
		if (!found.length) extents.push({ path: ['breaks', index], name: `breaks.${index}`, from: start[0], to: start[1] + most });
	});
	return { issues, extents };
}

/** An extent of the next day, in minutes of this one. */
const nextDay = (extent: Extent): Extent => ({
	...extent,
	from: extent.from + DAY_MINUTES,
	to: extent.to + DAY_MINUTES,
	...(extent.core && { core: [extent.core[0] + DAY_MINUTES, extent.core[1] + DAY_MINUTES] }),
});

/**
 * Whether two blocks can't both happen as planned: null when they can, else 'overlap', or for a break neither inside a
 * busy block's core nor clear of it, the break and that block.
 */
const clash = (a: Extent, b: Extent) => {
	if (a.to <= b.from || b.to <= a.from) return null;
	const pause = a.path[0] === 'breaks' ? a : b;
	const busy = pause === a ? b : a;
	if (pause.path[0] !== 'breaks' || !busy.core) return 'overlap';
	return busy.core[0] <= pause.from && pause.to <= busy.core[1] ? null : { pause, busy, core: busy.core };
};

const BAD_KEY = 'not a day or day group (mon tue wed thu fri sat sun, "mon-fri", "sat,sun")';

/** The `days` keys: each must read as days, and every weekday be in exactly one of them. */
function keyIssues(keys: string[]): HoursIssue[] {
	const issues: HoursIssue[] = [];
	const owners = new Map<Weekday, string>();
	for (const key of keys) {
		const days = daysOf(key);
		if (!days) {
			issues.push({ path: ['days', key], message: BAD_KEY });
			continue;
		}
		const taken = new Map<string, string[]>();
		for (const day of new Set(days)) {
			const owner = owners.get(day);
			if (owner === undefined) owners.set(day, key);
			else taken.set(owner, [...(taken.get(owner) ?? []), WEEKDAYS[day]]);
		}
		for (const [owner, tokens] of taken) issues.push({ path: ['days', key], message: `${tokens.join(', ')} ${tokens.length === 1 ? 'is' : 'are'} also in "${owner}"` });
	}
	const missing = WEEKDAYS.filter((_, day) => !owners.has(day as Weekday));
	// A key that doesn't read may be meant for the missing days: only that is said
	if (missing.length && keys.every((key) => daysOf(key))) {
		issues.push({ path: ['days'], message: `no plan for ${missing.join(', ')} (add ${missing.length === 1 ? 'it' : 'them'}, or "${missing.join(',')}: {}" for days with nothing)` });
	}
	return issues;
}

/**
 * What is wrong with a schedule, beyond its schema: day keys and coverage, each block's bounds, and blocks that can
 * overlap on some date, within a day and into the next one (sun into mon too). Checked on the widest times the ranges
 * allow, chances and skips aside, so a valid schedule is valid on every date. Blocks may touch; a break is inside one
 * busy block's core (a break from it) or clear of it.
 */
export function scheduleIssues(schedule: ScheduleConfig): HoursIssue[] {
	const issues = keyIssues(Object.keys(schedule.days));
	const plans = new Map(Object.entries(schedule.days).map(([key, plan]) => [key, extentsOf(plan)]));
	const at = (key: string, extent: Extent, message: string) => issues.push({ path: ['days', key, ...extent.path], message });
	const span = (extent: Extent) => `${clockOf(extent.from)} to ${clockOf(extent.to)}`;
	for (const [key, { issues: bounds, extents }] of plans) {
		issues.push(...under(['days', key], bounds));
		// At the block that starts later, naming the other one
		const byFrom = [...extents].sort((a, b) => a.from - b.from);
		byFrom.forEach((later, index) => {
			for (const earlier of byFrom.slice(0, index)) {
				const found = clash(earlier, later);
				if (found === 'overlap') at(key, later, `can overlap ${earlier.name} (${span(earlier)})`);
				else if (found) {
					const { pause, busy, core } = found;
					at(key, pause, `can cross ${busy.name} (${span(busy)}); a break is inside one busy block (${clockOf(core[0])} to ${clockOf(core[1])} here) or clear of it`);
				}
			}
		});
	}
	// Into the next day, at the block that runs past midnight; once per pair of blocks, whichever weekdays repeat it
	const seen = new Set<string>();
	for (const day of WEEKDAYS.keys()) {
		const next = ((day + 1) % 7) as Weekday;
		const key = keyFor(schedule, day as Weekday);
		const nextKey = keyFor(schedule, next);
		if (key === undefined || nextKey === undefined) continue;
		for (const late of plans.get(key)!.extents.filter((extent) => extent.to > DAY_MINUTES)) {
			for (const early of plans.get(nextKey)!.extents.map(nextDay)) {
				const pair = `${key}.${late.path.join('.')}>${nextKey}.${early.path.join('.')}`;
				if (seen.has(pair) || !clash(late, early)) continue;
				seen.add(pair);
				at(key, late, `runs until ${clockOf(late.to)} ${WEEKDAYS[next]}, into days.${nextKey}.${early.name} (from ${clockOf(early.from)})`);
			}
		}
	}
	return issues;
}

// ---------------------------------------------------------------------------------------------------
// The agenda
// ---------------------------------------------------------------------------------------------------

const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;

/** Blocks in order, without one a spring-forward jump skipped whole. */
const tidy = <B extends { start: number; end: number }>(blocks: B[]) => blocks.filter((block) => block.start < block.end).sort(byStart);

function drawAgenda({ id, timezone, schedule }: Hours, day: LocalDate): DayAgenda {
	const daySeed = `${id}:${day.year}-${day.month}-${day.day}`;
	const plan = planFor(schedule, weekdayOf(day));
	// The day seed draws the skip roll, then online[0]'s times, as it always has: hours drawn before stay the same
	const dayRng = seededRng(daySeed);
	const skipped = dayRng() < (plan?.skipDayChance ?? schedule.skipDayChance);
	/** A block's own draws, or null when its chance leaves it out that day. */
	const drawsOf = (kind: string, index: number, chance: number) => {
		const rng = seededRng(`${daySeed}:${kind}${index}`);
		return chance < 1 && rng() >= chance ? null : rng;
	};
	/** Local minutes as instants: blocks that don't overlap on the clock don't overlap as instants, across daylight saving too. */
	const instants = ([start, end]: [number, number]) => ({ start: zonedToUtc(day, start, timezone), end: zonedToUtc(day, end, timezone) });
	const spans: Span[] = [];
	if (plan && !skipped) {
		for (const [index, block] of plan.online.entries()) {
			const rng = drawsOf('online', index, block.chance);
			if (rng) spans.push({ kind: 'online', ...instants(timesOf(index ? rng : dayRng, block)), ...(block.on && { on: block.on }), day });
		}
		for (const [index, block] of plan.breaks.entries()) {
			const rng = drawsOf('break', index, block.chance);
			if (!rng) continue;
			const start = pick(rng, rangeOf(block.start));
			spans.push({ kind: 'break', ...instants([start, start + between(rng, ...block.minutes)]), ...(block.on && { on: block.on }), day });
		}
	}
	// Busy blocks are drawn on a skipped day too: work happens on days it doesn't come online
	const busy: Busy[] = [];
	for (const [index, block] of (plan?.busy ?? []).entries()) {
		const rng = drawsOf('busy', index, block.chance);
		if (rng) busy.push({ reason: block.reason, ...instants(timesOf(rng, block)), day });
	}
	return { day, skipped, spans: tidy(spans), busy: tidy(busy) };
}

const agendas = new WeakMap<ScheduleConfig, Map<string, DayAgenda>>();
const CACHED_DAYS = 16;

/** The persona's agenda for one local date: drawn once, then kept (the newest 16 days per schedule). */
export function agendaOn(hours: Hours, date: LocalDate): DayAgenda {
	let days = agendas.get(hours.schedule);
	if (!days) agendas.set(hours.schedule, (days = new Map()));
	const key = `${hours.id}|${hours.timezone}|${date.year}-${date.month}-${date.day}`;
	let agenda = days.get(key);
	if (!agenda) {
		agenda = drawAgenda(hours, date);
		days.set(key, agenda);
		if (days.size > CACHED_DAYS) days.delete(days.keys().next().value!);
	}
	return agenda;
}

// ---------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------

/** The agendas of the local date of `at`, from `from` days before or after it to `to`. */
const agendasNear = (hours: Hours, at: number, [from, to]: [number, number]) => {
	const today = localDateOf(at, hours.timezone);
	return Array.from({ length: to - from + 1 }, (_, index) => agendaOn(hours, addDays(today, from + index)));
};

const holds = (block: { start: number; end: number }, at: number) => block.start <= at && at < block.end;
/** Whether a span, or a block of a day plan, counts on `channel` (any, when left out): `on` left out is every channel. */
export const isOn = (span: { on?: readonly ChannelId[] }, channel?: ChannelId) => !channel || !span.on || span.on.includes(channel);

/** The span open at `at` on `channel` (on any when left out), else null. A block lies within its day and the next, so yesterday's may still run. */
export function spanAt(hours: Hours, at: number, channel?: ChannelId): Span | null {
	return agendasNear(hours, at, [-1, 0]).flatMap((agenda) => agenda.spans).find((span) => holds(span, at) && isOn(span, channel)) ?? null;
}

/** The busy block at `at`, else null. */
export function busyAt(hours: Hours, at: number): Busy | null {
	return agendasNear(hours, at, [-1, 0]).flatMap((agenda) => agenda.busy).find((busy) => holds(busy, at)) ?? null;
}

/** Whether a full online span is open on `channel`: group chats and posts need one, a break only allows DMs. */
export const fullyOnline = (hours: Hours, channel: ChannelId, at: number) => spanAt(hours, at, channel)?.kind === 'online';

/** The first span starting at or after `from` (up to 14 days ahead), only on `channel` and of `kind` when given. */
export function nextSpan(hours: Hours, from: number, only: { channel?: ChannelId; kind?: Span['kind'] } = {}): Span | null {
	const today = localDateOf(from, hours.timezone);
	const firstOn = (days: number) =>
		agendaOn(hours, addDays(today, days)).spans.find((span) => span.start >= from && isOn(span, only.channel) && (!only.kind || span.kind === only.kind));
	// From yesterday's agenda: its spans can start after midnight
	for (let days = -1; days <= 14; days++) {
		const found = firstOn(days);
		if (!found) continue;
		// The next day's first span may still start earlier than this day's late one
		const next = firstOn(days + 1);
		return next && next.start < found.start ? next : found;
	}
	return null;
}

/** What the persona's day looks like at `now` on `channel`, or null when no span is open there. */
export function situationAt(hours: Hours, now: number, channel: ChannelId): Situation | null {
	const span = spanAt(hours, now, channel);
	if (!span) return null;
	const busy = span.kind === 'break' ? busyAt(hours, now) : null;
	const upcoming = agendasNear(hours, now, [-1, 2])
		.flatMap((agenda) => agenda.busy)
		.filter((block) => block.start > now && block.start <= now + 36 * HOUR)
		.sort(byStart);
	const nextOnline = nextSpan(hours, span.end, { channel, kind: 'online' });
	return {
		at: now,
		span,
		busy,
		nextBusy: busy ? null : (upcoming[0] ?? null),
		nextOnline: nextOnline && nextOnline.start <= now + 7 * DAY ? nextOnline : null,
	};
}

/** Always the middle of a range. */
const MIDDLE: Rng = () => 0.5;

/** Online minutes on each weekday (0 = Monday), from the middle of every range, chances and skips aside: for a config check's warnings. */
export function onlineMinutesByWeekday(schedule: ScheduleConfig): number[] {
	return WEEKDAYS.map((_, weekday) => {
		const plan = planFor(schedule, weekday as Weekday);
		const online = (plan?.online ?? []).reduce((sum, block) => {
			const [start, end] = timesOf(MIDDLE, block);
			return sum + end - start;
		}, 0);
		return (plan?.breaks ?? []).reduce((sum, block) => sum + between(MIDDLE, ...block.minutes), online);
	});
}
