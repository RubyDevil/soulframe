/**
 * The persona's calendar (settings.calendar): plans laid over the agenda its schedule draws (schedule.ts agendaOn). A
 * DM turn may make a plan of its own (prompts.ts directMessageAnswerFormat's `plan`): somewhere it will be, busy and so
 * offline then; time it makes to chat with the person, online then; or calling one of its plans off. The model only
 * proposes: `checkPlan` decides, with guardrails no setting relaxes (the settings may only make them stricter). The
 * app may add plans of its own (store.addEvent), which are its own to check.
 */

import { planReasonProblem } from './config/hours.js';
import { addDays, agendaOn, CLOCK, localDateOf, onlineMinutesByWeekday, parseClock, zonedToUtc, type Busy, type CalendarEvent, type Hours, type LocalDate } from './schedule.js';
import { DAY, MINUTE, type Settings } from './settings.js';
import type { Store, StoredEvent } from './store.js';

/** The shortest plan, in minutes. */
const SHORTEST_MINUTES = 15;
/** Time made to chat lies from 7 AM to midnight on its day: never at night. */
const MAKE_TIME_FROM = 7 * 60;
const MAKE_TIME_TO = 24 * 60;

/** What a DM turn may answer in its `plan` field (brain.ts parseTurn), its times local "HH:MM" on its `day` (0 today). */
export type PlanProposal =
	| { day: number; from: string; to: string; busy: string }
	| { day: number; from: string; to: string; online: true }
	| { cancel: number };

/** What a refused plan clashed with: a busy block's reason ("at work"), and the event it is when a plan made it. */
export type Clash = Pick<Busy, 'reason' | 'event'>;

/**
 * What `checkPlan` decided: a plan to add (store.addEvent's), one of its own to call off, or why it was refused, with
 * the time the plan was for (once its times read) and the busy block it would have clashed with, if any.
 */
export type PlanCheck =
	| { add: Parameters<Store['addEvent']>[1] }
	| { cancel: StoredEvent }
	| { refused: string; block?: { start: number; end: number }; clash?: Clash };

/** The persona's hours with its calendar: its standing plans from the store, laid over each drawn day (schedule.ts agendaOn). */
export const calendarHours = (hours: Hours, store: Store): Hours => ({
	id: hours.id,
	timezone: hours.timezone,
	schedule: hours.schedule,
	events: (from, to) => store.events(hours.id, from, to),
});

/** An event's start and end as instants, in the persona's time zone. */
const instantsOf = (event: Pick<CalendarEvent, 'day' | 'from' | 'to'>, timeZone: string) => ({ start: zonedToUtc(event.day, event.from, timeZone), end: zonedToUtc(event.day, event.to, timeZone) });

const overlaps = (a: { start: number; end: number }) => (b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** The online time of `spans` (breaks left out; with `everywhere`, those of some channels only too), the spans that overlap as one. */
const joinedOnline = (spans: readonly { kind: string; start: number; end: number; on?: readonly unknown[] }[], { everywhere = false } = {}) =>
	spans
		.filter((span) => span.kind === 'online' && (!everywhere || !span.on))
		.sort((a, b) => a.start - b.start)
		.reduce<{ start: number; end: number }[]>((out, span) => {
			const last = out.at(-1);
			if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
			else out.push({ start: span.start, end: span.end });
			return out;
		}, []);

/** How much of `block` the `spans` cover, in ms (spans that don't overlap one another). */
const covered = (block: { start: number; end: number }, spans: readonly { start: number; end: number }[]) =>
	spans.reduce((sum, span) => sum + Math.max(0, Math.min(block.end, span.end) - Math.max(block.start, span.start)), 0);

/**
 * Whether the plan a DM turn with the person made may stand, and as what: `add` (an event for store.addEvent), `cancel`
 * (one of its own plans still ahead), or `refused` with why. Every plan: on a day from today to `plans.maxDays` ahead,
 * 15 minutes at least, starting after `now`.
 * - Busy (a plan of its own, `plans`): at most `plans.maxHours`, its reason as config/hours.ts planReasonProblem
 *   allows, over no other plan (busy, or time made to chat: a promise to someone), at most `plans.perWeek` made in any
 *   7 days.
 * - Online (time made to chat, `makeTime`): from 7 AM to midnight, at most `makeTime.maxMinutes`, over no busy block
 *   of that day, not online for every channel then already, never making the day's online time longer than its
 *   schedule's longest day and one such time (`makeTime.maxMinutes`), at most one for the person in
 *   `makeTime.perPersonDays`.
 * - Cancel: one of its own plans (`source` persona) of a kind it may make, standing and not over, only with whom it was
 *   made (a plan told to someone is theirs to hear called off).
 * `hours` must carry its calendar (`calendarHours`), so the day it checks is the one the agenda will draw.
 */
export function checkPlan(
	proposal: PlanProposal,
	{
		store,
		hours,
		settings,
		now,
		personId,
		today = localDateOf(now, hours.timezone),
	}: {
		store: Store;
		hours: Hours;
		settings: Settings['calendar'];
		now: number;
		personId: number;
		/** The date its `day` counts from: the persona's when the turn was written (a turn kept past midnight means the day it was written on); now's unless given. */
		today?: LocalDate;
	},
): PlanCheck {
	const refused = (reason: string, more: { block?: { start: number; end: number }; clash?: Clash } = {}) => ({ refused: reason, ...more });
	const { timezone } = hours;
	if ('cancel' in proposal) {
		const event = store.eventById(proposal.cancel);
		if (!event || event.persona !== hours.id || event.cancelledAt !== null) return refused('no_such_plan');
		// A plan made in a turn with someone is told to them, a promise at times: only they hear it called off
		if (event.source !== 'persona' || event.personId !== personId) return refused('not_its_own');
		if (!(event.kind === 'online' ? settings.makeTime : settings.plans).enabled) return refused('off');
		if (instantsOf(event, timezone).end <= now) return refused('over');
		return { cancel: event };
	}
	const online = 'online' in proposal;
	if (!(online ? settings.makeTime : settings.plans).enabled) return refused('off');
	if (!Number.isInteger(proposal.day) || proposal.day < 0) return refused('day');
	if (proposal.day > settings.plans.maxDays) return refused('too_far');
	if (!CLOCK.test(proposal.from) || !CLOCK.test(proposal.to)) return refused('times');
	const day = addDays(today, proposal.day);
	const from = parseClock(proposal.from);
	// An end on the clock before its start is the next day's
	const to = parseClock(proposal.to) + (parseClock(proposal.to) <= from ? 24 * 60 : 0);
	if (to - from < SHORTEST_MINUTES) return refused('too_short');
	const block = instantsOf({ day, from, to }, timezone);
	/** Refused, saying the time it was for. */
	const refusedAt = (reason: string, clash?: Clash) => refused(reason, { block, ...(clash && { clash: { reason: clash.reason, ...(clash.event !== undefined && { event: clash.event }) } }) });
	if (block.start <= now) return refusedAt('past');

	if (online) {
		const { maxMinutes, perPersonDays } = settings.makeTime;
		if (to - from > maxMinutes) return refusedAt('too_long');
		if (from < MAKE_TIME_FROM || to > MAKE_TIME_TO) return refusedAt('night');
		const agenda = agendaOn(hours, day);
		// The day before's blocks may run into it: a night shift until 8 AM
		const before = agendaOn(hours, addDays(day, -1));
		const busy = [...before.busy, ...agenda.busy].find(overlaps(block));
		if (busy) return refusedAt('busy', busy);
		// Online on one channel only is time it may still make for every channel (the person's may not be one)
		const already = covered(block, joinedOnline([...before.spans, ...agenda.spans], { everywhere: true }));
		if (already >= block.end - block.start) return refusedAt('already_online');
		// Its day's online time is that of its own spans, as its schedule's longest day counts it, and what the plan adds
		const online = joinedOnline(agenda.spans);
		const total = online.reduce((sum, span) => sum + span.end - span.start, 0) + block.end - block.start - covered(block, online);
		// One made time's worth over its longest day at most: nobody stacks a day with more
		if (total > (Math.max(...onlineMinutesByWeekday(hours.schedule)) + maxMinutes) * MINUTE) return refusedAt('too_much');
		if (store.eventsMadeSince(hours.id, now - perPersonDays * DAY, { kind: 'online', personId }) > 0) return refusedAt('too_soon');
		return { add: { kind: 'online', day, from, to, personId, source: 'persona' } };
	}

	const { maxHours, perWeek } = settings.plans;
	if (to - from > maxHours * 60) return refusedAt('too_long');
	const problem = 'busy' in proposal ? planReasonProblem(proposal.busy) : 'missing';
	if (problem) return refusedAt(`reason_${problem}`);
	const other = store.events(hours.id, addDays(day, -1), addDays(day, 1)).find((event) => overlaps(block)(instantsOf(event, timezone)));
	// Over time made to chat it would break a promise, and that time is only for the person it was made for to call off
	if (other) return other.kind === 'busy' ? refusedAt('clash', { reason: other.what, event: other.id }) : refusedAt('clash_online');
	if (store.eventsMadeSince(hours.id, now - 7 * DAY, { kind: 'busy' }) >= perWeek) return refusedAt('week_cap');
	return { add: { kind: 'busy', day, from, to, what: proposal.busy.trim(), personId, source: 'persona' } };
}

/**
 * Its coming plans as a turn with the person (`personId`) lists them (prompts.ts calendarPrompt): those standing from
 * now to `maxDays` ahead, at most `shown`, each with its instants; a busy one with its reason, time made to chat with
 * whom it is for (`them`, `someone` else, never named, or none for the app's). `id` only for one it may call off with
 * them (`checkPlan`): its own, made with them, of a kind `settings` lets it make.
 */
export function comingPlans(store: Store, hours: Hours, { now, settings, personId }: { now: number; settings: Settings['calendar']; personId: number }) {
	const today = localDateOf(now, hours.timezone);
	const cancellable = (event: StoredEvent) =>
		event.source === 'persona' && event.personId === personId && (event.kind === 'online' ? settings.makeTime : settings.plans).enabled;
	return store
		.events(hours.id, addDays(today, -1), addDays(today, settings.plans.maxDays))
		.map((event) => ({ event, ...instantsOf(event, hours.timezone) }))
		.filter(({ end }) => end > now)
		.slice(0, settings.shown)
		.map(({ event, start, end }) => ({
			id: cancellable(event) ? event.id : null,
			start,
			end,
			busy: event.kind === 'busy' ? event.what : null,
			for: event.kind === 'busy' || event.personId === null ? null : event.personId === personId ? ('them' as const) : ('someone' as const),
		}));
}
