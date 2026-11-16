/**
 * The persona's calendar (settings.calendar): plans laid over the agenda its schedule draws (schedule.ts agendaOn). A
 * DM turn may make a plan of its own (prompts.ts directMessageAnswerFormat's `plan`): somewhere it will be, busy and so
 * offline then; time it makes to chat with the person, online then; or calling one of its plans off. The model only
 * proposes: `checkPlan` decides, with guardrails no setting relaxes (the settings may only make them stricter). The
 * app may add plans of its own (store.addEvent), which are its own to check.
 */

import { addresses, ADDRESSED, planReasonProblem } from './config/hours.js';
import { addDays, agendaOn, CLOCK, localDateOf, onlineMinutesByWeekday, parseClock, zonedToUtc, type Busy, type CalendarEvent, type Hours, type LocalDate } from './schedule.js';
import { DAY, MINUTE, type Settings } from './settings.js';
import type { Store, StoredEvent } from './store.js';

/** The shortest plan, in minutes. */
const SHORTEST_MINUTES = 15;
/** Time made to chat lies from 7 AM to midnight on its day: never at night. */
const MAKE_TIME_FROM = 7 * 60;
const MAKE_TIME_TO = 24 * 60;

/**
 * How widely the words of a plan made with someone may be told to others (settings.calendar.sharing), as the model
 * ranked them when it made it: `open`, to anyone ("at the dentist"); `personal`, to those it is close enough to (it
 * names someone, their party); `confidential`, to the closest only, in confidence (something sensitive, or that they
 * asked it to keep to itself).
 */
export type Share = 'open' | 'personal' | 'confidential';

/**
 * What a DM turn may answer in its `plan` field (brain.ts parseTurn), its times local "HH:MM" on its `day` (0 today).
 * A busy plan may carry how widely its words may be told (`share`), the words anyone may hear (`public`), and whether it
 * is with or for the person (`withThem`): a promise to them, as time made to chat always is. A new plan may take the
 * place of one listed (`replaces`, its number): both or neither, the day checked without that one (`checkPlan`).
 */
export type PlanProposal =
	| { day: number; from: string; to: string; busy: string; public?: string; share?: Share; withThem?: boolean; replaces?: number }
	| { day: number; from: string; to: string; online: true; replaces?: number }
	| { cancel: number };

/** What a refused plan clashed with: a busy block's reason ("at work"), the event it is when a plan made it, with whom that was made, and what of it may be told. */
export type Clash = Pick<Busy, 'reason' | 'event' | 'madeWith' | 'share' | 'public'>;

/**
 * What `checkPlan` decided: a plan to add (store.addEvent's) with the promises to others it calls off (`bumped`: each
 * made with someone it is not less close to, to call off and tell them about), one of its plans to call off, or why it
 * was refused, with the time the plan was for (once its times read) and the busy block it would have clashed with, if
 * any. A plan in place of one (`replaces`) is added with that one to call off (`replaced`), or refused whole: the one it
 * couldn't call off said (`stands`), or the new one's reason.
 */
export type PlanCheck =
	| { add: Parameters<Store['addEvent']>[1]; bumped: StoredEvent[]; replaced?: StoredEvent }
	| { cancel: StoredEvent }
	| { refused: string; block?: { start: number; end: number }; clash?: Clash; stands?: number };

/**
 * Whom a prompt is for (a DM turn's or an opener's person; none in a group chat), at the relationship levels its prompt
 * describes: each level's `from` (affinity left out while it isn't kept). Who hears what of plans made with others
 * (`sightOf`) goes by them.
 */
export interface Viewer {
	id: number;
	familiarity: number;
	affinity?: number;
}

/**
 * What a prompt for `viewer` may tell of a plan: its own words (`full`), its words told in confidence (`confidence`), or
 * only the words anyone may hear (`public`).
 */
export type Sight = 'full' | 'confidence' | 'public';

/**
 * What a prompt for `viewer` may tell of a plan (`madeWith`: the person it was made with in a DM turn, its words
 * theirs): all of it to them, of the routine and the app's; of one made with someone else, with sharing on, its words
 * as its `share` allows at the viewer's levels (settings.calendar.sharing): an `open` one's to anyone, a group chat's
 * too (no viewer), the others' only to someone close enough; else its public words. Sharing off, nobody else ever
 * hears its own words.
 */
export function sightOf(plan: { madeWith?: number; share?: Share }, viewer: Viewer | undefined, sharing: Settings['calendar']['sharing']): Sight {
	if (plan.madeWith === undefined || plan.madeWith === viewer?.id) return 'full';
	if (!sharing.enabled) return 'public';
	const share = plan.share ?? 'personal';
	if (share === 'open') return 'full';
	const from = sharing[share];
	if (!from || !viewer) return 'public';
	const close = viewer.familiarity >= from.familiarity && (from.affinity === undefined || viewer.affinity === undefined || viewer.affinity >= from.affinity);
	return !close ? 'public' : share === 'confidential' ? 'confidence' : 'full';
}

/**
 * A plan's own words as someone other than whom it was made with hears them: "you" and "your" in them (`ADDRESSED`: the
 * person in their own chat) said by their name ("at your party" becomes "at Sam's party").
 */
export const toOthers = (words: string, name: string) => words.replace(ADDRESSED, (word) => (/^(?:your|yours|ur)$/i.test(word) ? `${name}'s` : name));

/** What a reader hears of a plan: its words (none: a plan of its own, unnamed), told in confidence or not. */
export interface Heard {
	words: string | undefined;
	confidence?: true;
}

/**
 * What `viewer` hears of a busy block (`sightOf`): its own words, told in confidence when that is how, with whom it was
 * made with by their name where they said "you" (`toOthers`, `nameOf`), to them too: in a prompt "you" is the persona,
 * and "at your party" read as its own party; else its public words (those too when whom it was made with is no longer
 * known: `nameOf` answers undefined).
 */
export function heardOf(
	busy: { reason: string; madeWith?: number; share?: Share; public?: string },
	viewer: Viewer | undefined,
	sharing: Settings['calendar']['sharing'],
	nameOf: (personId: number) => string | undefined,
): Heard {
	const sight = sightOf(busy, viewer, sharing);
	if (sight === 'public') return { words: busy.public };
	if (busy.madeWith === undefined) return sight === 'confidence' ? { words: busy.reason, confidence: true } : { words: busy.reason };
	const name = nameOf(busy.madeWith);
	if (name === undefined) return { words: busy.madeWith === viewer?.id ? busy.reason : busy.public };
	const words = toOthers(busy.reason, name);
	return sight === 'confidence' ? { words, confidence: true } : { words };
}

/** A person's name by their id in `store`, for `heardOf`; undefined for someone no longer known (forgotten). */
export const nameIn =
	(store: Store) =>
	(personId: number): string | undefined => {
		try {
			return store.personById(personId).name;
		} catch {
			return undefined;
		}
	};

/** A plan of the persona's that is a promise to someone: time made to chat with them, or a busy plan with or for them. */
export const isPromise = (event: Pick<StoredEvent, 'source' | 'personId' | 'kind' | 'withThem'>) => event.source === 'persona' && event.personId !== null && (event.kind === 'online' || event.withThem);

/** How close the persona is to the person asking (`asker`) against someone else: `closer`, `about` as close, or `less`. */
export type Closer = 'closer' | 'about' | 'less';

/** `Closer` from two closeness scores (relationship levels, summed: brain.ts closenessOf), one level of difference being about as close. */
export const closerOf = (asker: number, other: number): Closer => (asker - other > 1 ? 'closer' : other - asker > 1 ? 'less' : 'about');

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
 * Whether the plan a DM turn with the person made may stand, and as what: `add` (an event for store.addEvent, with the
 * promises to others it calls off), `cancel` (one of its plans still ahead), or `refused` with why. Every plan: on a day
 * from today to `plans.maxDays` ahead, 15 minutes at least, starting after `now`; lengths as the time passes, daylight
 * saving in it.
 * - Busy (a plan of its own, `plans`): at most `plans.maxHours`, its reason (and its public words, else left out) as
 *   config/hours.ts planReasonProblem allows, over no other plan, at most `plans.perWeek` made in any 7 days.
 * - Online (time made to chat, `makeTime`): from 7 AM to midnight, at most `makeTime.maxMinutes`, over no busy block
 *   of that day, never making the day's online time longer than its schedule's longest day and one such time
 *   (`makeTime.maxMinutes`), at most one for the person in `makeTime.perPersonDays`. At an hour it is online for every
 *   channel anyway it adds nothing, but is kept all the same, so no plan of its own breaks the promise (left out, not
 *   told, when another for them is too soon: `already_online`).
 * - Cancel: one of its own plans (`source` persona) of a kind it may make, standing and not over.
 * A promise made with someone else (`isPromise`) is no obstacle, but called off for this person, if they are not less
 * close to it than the one it was made with (`closeness`, `closerOf`), and if the persona may make that kind of plan:
 * as a person cancels for someone who matters as much or more. Less close, it is refused (`less_close` when called off
 * by its number). A plan in place of one (`replaces`): that one called off as by its number, and the new one checked on
 * the day as it will be without it, neither counted toward the limits (a plan moved is no new one); both or neither,
 * the new one alone when nothing stands to replace. `hours` must carry its calendar (`calendarHours`), so the day it
 * checks is the one the agenda will draw.
 */
export function checkPlan(proposal: PlanProposal, options: Omit<Parameters<typeof checkOne>[1], 'replacing'>): PlanCheck {
	if ('cancel' in proposal || proposal.replaces === undefined) return checkOne(proposal, options);
	const { replaces, ...plan } = proposal;
	const cancel = checkOne({ cancel: replaces }, options);
	// Nothing standing to replace (no such plan, or over): the new one alone
	if ('refused' in cancel) return cancel.refused === 'no_such_plan' || cancel.refused === 'over' ? checkOne(plan, options) : { ...cancel, stands: replaces };
	if (!('cancel' in cancel)) throw new Error('a cancel checks as one');
	const checked = checkOne(plan, { ...options, replacing: cancel.cancel });
	return 'add' in checked ? { ...checked, replaced: cancel.cancel } : checked;
}

function checkOne(
	proposal: PlanProposal,
	{
		store,
		hours,
		settings,
		now,
		personId,
		today = localDateOf(now, hours.timezone),
		closeness = () => 0,
		replacing,
	}: {
		store: Store;
		hours: Hours;
		settings: Settings['calendar'];
		now: number;
		personId: number;
		/** The date its `day` counts from: the persona's when the turn was written (a turn kept past midnight means the day it was written on); now's unless given. */
		today?: LocalDate;
		/** How close the persona is to a person (brain.ts closenessOf); everyone about as close when left out. */
		closeness?: (personId: number) => number;
		/** The plan this one takes the place of (`replaces`), checked as gone. */
		replacing?: StoredEvent;
	},
): PlanCheck {
	const refused = (reason: string, more: { block?: { start: number; end: number }; clash?: Clash } = {}) => ({ refused: reason, ...more });
	const { timezone } = hours;
	const enabled = (kind: StoredEvent['kind']) => (kind === 'online' ? settings.makeTime : settings.plans).enabled;
	/** A promise to someone else this person may have it called off for. */
	const bumpable = (event: StoredEvent) =>
		isPromise(event) && event.personId !== personId && enabled(event.kind) && closerOf(closeness(personId), closeness(event.personId!)) !== 'less';
	if ('cancel' in proposal) {
		const event = store.eventById(proposal.cancel);
		if (!event || event.persona !== hours.id || event.cancelledAt !== null) return refused('no_such_plan');
		if (event.source !== 'persona') return refused('not_its_own');
		if (!enabled(event.kind)) return refused('off');
		if (instantsOf(event, timezone).end <= now) return refused('over');
		if (isPromise(event) && event.personId !== personId && !bumpable(event)) return refused('less_close');
		return { cancel: event };
	}
	const online = 'online' in proposal;
	if (!enabled(online ? 'online' : 'busy')) return refused('off');
	if (!Number.isInteger(proposal.day) || proposal.day < 0) return refused('day');
	if (proposal.day > settings.plans.maxDays) return refused('too_far');
	if (!CLOCK.test(proposal.from) || !CLOCK.test(proposal.to)) return refused('times');
	const day = addDays(today, proposal.day);
	const from = parseClock(proposal.from);
	// An end on the clock before its start is the next day's
	const to = parseClock(proposal.to) + (parseClock(proposal.to) <= from ? 24 * 60 : 0);
	const block = instantsOf({ day, from, to }, timezone);
	// Its length as it passes, a daylight saving change in it counted: 10 PM to midnight may be three hours
	const minutes = (block.end - block.start) / MINUTE;
	if (minutes < SHORTEST_MINUTES) return refused('too_short');
	/** Refused, saying the time it was for. */
	const refusedAt = (reason: string, clash?: Clash) => refused(reason, { block, ...(clash && { clash: clashOf(clash) }) });
	if (block.start <= now) return refusedAt('past');
	/** The plans standing over it: from the day before (past midnight) to the day after, but the one it replaces. */
	const over = store
		.events(hours.id, addDays(day, -1), addDays(day, 1))
		.filter((event) => event.id !== replacing?.id && overlaps(block)(instantsOf(event, timezone)));
	/** Its plans made since `since`, as store.eventsMadeSince counts them, but the one it replaces: a plan moved is no new one. */
	const madeSince = (since: number, which: { kind: StoredEvent['kind']; personId?: number; unbroken?: boolean }) =>
		store.eventsMadeSince(hours.id, since, which) -
		(replacing && replacing.createdAt >= since && replacing.kind === which.kind && (which.personId === undefined || replacing.personId === which.personId) ? 1 : 0);

	if (online) {
		const { maxMinutes, perPersonDays } = settings.makeTime;
		if (minutes > maxMinutes) return refusedAt('too_long');
		if (from < MAKE_TIME_FROM || to > MAKE_TIME_TO) return refusedAt('night');
		// Promises to others then that this one calls off (time made with someone else is one-on-one time); one it may not, refused
		const bumped = new Map<number, StoredEvent>();
		for (const event of over.filter((event) => isPromise(event) && event.personId !== personId)) {
			if (bumpable(event)) bumped.set(event.id, event);
			else if (event.kind === 'online') return refusedAt('clash_online');
		}
		// The day as it will be once they are called off: what lay under them (work, a night shift) comes back
		const rest: Hours = { ...hours, events: (from, to) => (hours.events?.(from, to) ?? []).filter((event) => !bumped.has(event.id) && event.id !== replacing?.id) };
		const agenda = agendaOn(rest, day);
		// The day before's blocks may run into it: a night shift until 8 AM
		const before = agendaOn(rest, addDays(day, -1));
		const busy = [...before.busy, ...agenda.busy].find(overlaps(block));
		if (busy) return refusedAt('busy', busy);
		const add = { add: { kind: 'online' as const, day, from, to, personId, source: 'persona' as const }, bumped: [...bumped.values()] };
		// Time made for them lately (not that called off for someone else: making that up is no new favour)
		const soon = madeSince(now - perPersonDays * DAY, { kind: 'online', personId, unbroken: true }) > 0;
		// Online on one channel only is time it may still make for every channel (the person's may not be one)
		const already = covered(block, joinedOnline([...before.spans, ...agenda.spans], { everywhere: true }));
		// Online then anyway, it adds nothing, but keeps the promise: no plan of its own can take that time now. Too soon for
		// another, it is left as it was (nothing is broken, nothing told); but not over a promise it would break: that one
		// stands, so the time isn't theirs, and they are told
		if (already >= block.end - block.start) return soon ? refusedAt(bumped.size ? 'too_soon' : 'already_online') : add;
		// Its day's online time is that of its own spans, as its schedule's longest day counts it, and what the plan adds
		const spans = joinedOnline(agenda.spans);
		const total = spans.reduce((sum, span) => sum + span.end - span.start, 0) + block.end - block.start - covered(block, spans);
		// One made time's worth over its longest day at most
		if (total > (Math.max(...onlineMinutesByWeekday(hours.schedule)) + maxMinutes) * MINUTE) return refusedAt('too_much');
		if (soon) return refusedAt('too_soon');
		return add;
	}

	const { maxHours, perWeek } = settings.plans;
	if (minutes > maxHours * 60) return refusedAt('too_long');
	// Its own words may speak to them ("at your party"): anyone else who may hear them hears their name (`toOthers`)
	const problem = 'busy' in proposal ? planReasonProblem(proposal.busy, { addressed: true }) : 'missing';
	if (problem) return refusedAt(`reason_${problem}`);
	const bumped: StoredEvent[] = [];
	for (const event of over) {
		if (bumpable(event)) bumped.push(event);
		// Over time made to chat, or another plan: refused (a promise to someone it is less close to among them)
		else if (event.kind === 'online') return refusedAt('clash_online');
		else return refusedAt('clash', { reason: event.what, ...busyOf(event) });
	}
	if (madeSince(now - 7 * DAY, { kind: 'busy' }) >= perWeek) return refusedAt('week_cap');
	// Its public words, held to the same as its own; left out (a plan of its own, to others) when they fall short
	const shown = 'busy' in proposal && proposal.public !== undefined && !planReasonProblem(proposal.public) ? proposal.public.trim() : null;
	const { share: ranked = 'personal', withThem = false } = proposal as { share?: Share; withThem?: boolean };
	// Words that speak to them name them to anyone else (`toOthers`): never open to anyone
	const share = ranked === 'open' && addresses(proposal.busy) ? 'personal' : ranked;
	return { add: { kind: 'busy', day, from, to, what: proposal.busy.trim(), personId, source: 'persona', share, public: shown, withThem }, bumped };
}

/** A stored event's facts as a busy block carries them: its id, and of the persona's with someone, with whom and what of it may be told. */
const busyOf = (event: StoredEvent): Omit<Clash, 'reason'> => ({
	event: event.id,
	...(event.source === 'persona' && event.personId !== null && { madeWith: event.personId, share: event.share, ...(event.public && { public: event.public }) }),
});

/** A clash as a refusal keeps it: only the facts of a busy block, none of its times. */
const clashOf = (clash: Clash): Clash => ({
	reason: clash.reason,
	...(clash.event !== undefined && { event: clash.event }),
	...(clash.madeWith !== undefined && { madeWith: clash.madeWith }),
	...(clash.share !== undefined && { share: clash.share }),
	...(clash.public !== undefined && { public: clash.public }),
});

/** One of its coming plans as a turn lists it (`comingPlans`, prompts.ts calendarPrompt). */
export interface ComingPlan {
	/** Its number, when this turn may call it off; else null. */
	id: number | null;
	start: number;
	end: number;
	kind: StoredEvent['kind'];
	/** A busy one's words as this turn may hear them (`sightOf`): its own, or the words anyone may hear; null for neither. */
	words: string | null;
	/** Its words are told to this turn in confidence. */
	confidence: boolean;
	/** Time made to chat: for them (`them`), for someone named (`name`, as this turn may hear it), for `someone` else, or for nobody (the app's, `null`). */
	for: 'them' | 'someone' | { name: string } | null;
	/** A promise made with someone else: how close it is to this person against them, and how often it called plans with them off for others lately (30 days). */
	promise: { closer: Closer; calledOff: number } | null;
}

/**
 * Its coming plans as a turn with `viewer` lists them (prompts.ts calendarPrompt): those standing from now to
 * `plans.maxDays` ahead, at most `shown`, each with its instants and what that turn may hear of it (`sightOf`); a
 * promise made with someone else with how close it is to the viewer against them and how often it let them down lately.
 * `id` only for one it may call off there (`checkPlan`): its own, of a kind `settings` lets it make, and a promise made
 * with someone else only for a viewer not less close.
 */
export function comingPlans(
	store: Store,
	hours: Hours,
	{ now, settings, viewer, closeness = () => 0 }: { now: number; settings: Settings['calendar']; viewer: Viewer; closeness?: (personId: number) => number },
): ComingPlan[] {
	const today = localDateOf(now, hours.timezone);
	return store
		.events(hours.id, addDays(today, -1), addDays(today, settings.plans.maxDays))
		.map((event) => ({ event, ...instantsOf(event, hours.timezone) }))
		.filter(({ end }) => end > now)
		.slice(0, settings.shown)
		.map(({ event, start, end }) => {
			const madeWith = event.source === 'persona' && event.personId !== null ? event.personId : undefined;
			const plan = { reason: event.what, ...(madeWith !== undefined && { madeWith }), share: event.share, ...(event.public && { public: event.public }) };
			const sight = sightOf(plan, viewer, settings.sharing);
			const heard = heardOf(plan, viewer, settings.sharing, nameIn(store));
			const promised = isPromise(event) && madeWith !== viewer.id ? closerOf(closeness(viewer.id), closeness(madeWith!)) : null;
			const cancellable = event.source === 'persona' && (event.kind === 'online' ? settings.makeTime : settings.plans).enabled && promised !== 'less';
			return {
				id: cancellable ? event.id : null,
				start,
				end,
				kind: event.kind,
				words: event.kind !== 'busy' ? null : (heard.words ?? null),
				confidence: event.kind === 'busy' && heard.confidence === true,
				for:
					event.kind === 'busy' || madeWith === undefined
						? null
						: madeWith === viewer.id
							? 'them'
							: sight === 'public' || nameIn(store)(madeWith) === undefined
								? 'someone'
								: { name: nameIn(store)(madeWith)! },
				promise: promised === null ? null : { closer: promised, calledOff: store.calledOffOn(hours.id, madeWith!, now - 30 * DAY) },
			};
		});
}
