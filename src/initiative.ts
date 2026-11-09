/**
 * Texting first (settings.initiative): who the persona may send an opener to, and when a planned one may go. The code
 * decides all of this; the model only decides, as the moment comes, whether to text and what (brain.composeOpener).
 * These guardrails apply whatever the settings say: the settings may only make it rarer.
 */

import { weightedPick, type Rng } from './rng.js';
import { addDays, agendaOn, localDateOf, zonedToUtc, type Busy, type Hours, type Span } from './schedule.js';
import { DAY, HOUR, MINUTE, type Settings } from './settings.js';
import type { Opener, Person, Store } from './store.js';

/** At least this long since the last message either way: it never texts first in the middle of a conversation. */
export const REST_MS = 2 * HOUR;
/** The local time a follow-up planned for a later day may go from: never a night that only belongs to it by the date. */
const FOLLOW_UP_FROM_MINUTES = 6 * 60;
/** How many ignored openers in a row may double the wait before the next one (64 times `personGapHours` at most). */
const MAX_BACKOFF = 6;
/** How soon after a busy block it may come online and still be "just back" from it, and how soon after it comes online a share goes. */
const JUST_BACK_MS = 30 * MINUTE;

/**
 * Why no opener may go to the person now, or null when one may. `final`: it never will (they ended it, can't be
 * texted first or never wrote): the opener is dropped. Otherwise it may later: it stays pending until its expiry.
 * Checks, in order: active, no account deny-listed or flagged as possibly under 18, they wrote to it before, no reply
 * owed, nothing written either way for REST_MS, no opener of its own left unanswered, the gap since the last one
 * (`personGapHours`, doubled for each ignored in a row), the persona's `perDay`, and one a day per account for every
 * persona. A check-in (`opener`) is dropped once they talked since it was planned: they are not quiet any more. When in
 * the day is its own hours' to say (the reply queue's spans).
 */
export function openerBlock(
	store: Store,
	person: Person,
	now: number,
	initiative: Settings['initiative'],
	opener?: Pick<Opener, 'kind' | 'createdAt'>,
): { reason: string; final: boolean } | null {
	const final = (reason: string) => ({ reason, final: true });
	const later = (reason: string) => ({ reason, final: false });
	if (person.state !== 'active') return final(person.state);
	const accounts = Object.entries(person.ids);
	if (accounts.some(([channel, externalId]) => store.isDenied(channel, externalId))) return final('denied');
	if (accounts.some(([channel, externalId]) => store.isMinorCautioned(channel, externalId))) return final('minor_caution');
	if (person.incoming === 0) return final('never_wrote');
	if (person.lastInAt > person.handledAt) return later('reply_owed');
	const last = store.history(person.id, 1)[0];
	if (opener?.kind === 'checkIn' && last && last.at > opener.createdAt) return final('talked_since');
	if (last && now - last.at < REST_MS) return later('mid_conversation');
	const sent = store.sentOpeners(person.id, MAX_BACKOFF + 1);
	const newest = sent[0];
	if (newest && !(person.lastInAt > newest.closedAt!)) return later('unanswered');
	if (newest) {
		const gap = initiative.personGapHours * HOUR;
		// Ignored: they wrote only after the next opener could have gone
		let ignored = 0;
		for (const opener of sent) {
			const answeredAt = store.firstInAfter(person.id, opener.closedAt!);
			if (answeredAt !== null && answeredAt - opener.closedAt! <= gap) break;
			ignored++;
		}
		if (now - newest.closedAt! < gap * 2 ** Math.min(ignored, MAX_BACKOFF)) return later('too_soon');
	}
	if (store.openersSentSince(person.persona, now - 24 * HOUR) >= initiative.perDay) return later('day_cap');
	if (store.accountOpenedSince(person.id, now - 24 * HOUR)) return later('account_cap');
	return null;
}

/**
 * When a follow-up planned `days` ahead (0: later today) may go and when it is given up, in the persona's time zone:
 * later today from REST_MS on, or that day from 6 AM; given up at the end of the day after it.
 */
export function followUpWindow(now: number, days: number, timeZone: string): { dueAt: number; expiresAt: number } {
	const today = localDateOf(now, timeZone);
	const day = addDays(today, days);
	return {
		dueAt: days === 0 ? now + REST_MS : zonedToUtc(day, FOLLOW_UP_FROM_MINUTES, timeZone),
		expiresAt: zonedToUtc(addDays(day, 2), 0, timeZone),
	};
}

/** What the planners read: the store, the persona's hours, the settings its brain runs with, the span open now, the clock and randomness. */
export interface PlanContext {
	store: Store;
	persona: Hours;
	settings: Settings;
	/** The full online span open now. */
	span: Span;
	now: number;
	rng: Rng;
	/** Whether an opener could reach the person (a channel allowed for it); everyone when left out. */
	reachable?: (person: Person) => boolean;
}

/** Familiarity and affinity faded for `apartMs`, as a new conversation would find them (settings.relationship). */
const faded = (person: Person, apartMs: number, { familiarity, affinity }: Settings['relationship']) => {
	const fade = (value: number, halfLifeDays: number) => (halfLifeDays > 0 ? value * 0.5 ** (apartMs / (halfLifeDays * DAY)) : value);
	return { familiarity: fade(person.familiarity, familiarity.fadeHalfLifeDays), affinity: fade(person.affinity, affinity.fadeHalfLifeDays) };
};

/** Up to `count` of `items`, drawn by weight without putting back. */
const pickSome = <T>(rng: Rng, items: { weight: number; value: T }[], count: number): T[] => {
	const left = [...items];
	const picked: T[] = [];
	while (picked.length < count && left.length) {
		const value = weightedPick(rng, left) ?? left[0]!.value;
		picked.push(value);
		left.splice(left.findIndex((item) => item.value === value), 1);
	}
	return picked;
};

/**
 * Check-ins for the span open now (settings.initiative.checkIns), as it opens (the reply queue asks once per span).
 * Each of its people quiet for `quietDays`, `reachable`, with no plan pending and whom an opener may go to now (none
 * left unanswered, the gap since the last one past), whose familiarity faded for their time apart is at
 * `minFamiliarity` or more and affinity at `minAffinity` or more (while kept), is drawn at a rate of 1 to 2 in
 * `meanDays` (more the closer, over the familiarity left above the threshold) for the share of today's online time
 * this span still has. Of those drawn, at most what `perDay` leaves, by closeness. Each is planned at a random moment
 * of what is left (up to `spanEndMinutes` before it ends), given up as it ends, and audited (`check_in_planned`).
 * Answers those planned.
 */
export function planCheckIns({ store, persona, settings, span, now, rng, reachable = () => true }: PlanContext): Opener[] {
	const { initiative } = settings;
	const own = initiative.checkIns;
	if (!initiative.enabled || !own.enabled) return [];
	const until = span.end - initiative.spanEndMinutes * MINUTE;
	if (until <= now) return [];
	const today = agendaOn(persona, span.day).spans.filter((open) => open.kind === 'online').reduce((sum, open) => sum + open.end - open.start, 0);
	const share = (until - now) / Math.max(today, until - now);
	const drawn: { weight: number; value: Person }[] = [];
	for (const { person, lastAt } of store.quietPeople(persona.id, now - own.quietDays * DAY)) {
		if (!reachable(person) || store.pendingOpener(person.id) || openerBlock(store, person, now, initiative)) continue;
		const { familiarity, affinity } = faded(person, now - lastAt, settings.relationship);
		if (familiarity < own.minFamiliarity || (settings.relationship.affinity.enabled && affinity < own.minAffinity)) continue;
		const closeness = (familiarity - own.minFamiliarity) / (1 - own.minFamiliarity);
		const rate = (1 + closeness) / own.meanDays;
		if (rng() < 1 - Math.exp(-rate * share)) drawn.push({ weight: 1 + closeness, value: person });
	}
	const left = Math.max(0, initiative.perDay - store.openersSentSince(persona.id, now - DAY));
	return pickSome(rng, drawn, left).map((person) => {
		const opener = store.planOpener(persona.id, person.id, { kind: 'checkIn', about: '', dueAt: now + rng() * (until - now), expiresAt: span.end });
		store.audit(persona.id, 'check_in_planned', { personId: person.id, dueAt: opener.dueAt });
		return opener;
	});
}

/** The busy block that ended at most JUST_BACK_MS before `span` opened, if any (of its day's agenda or the day before's). */
const busyJustBefore = (persona: Hours, span: Span): Busy | null =>
	[agendaOn(persona, addDays(span.day, -1)), agendaOn(persona, span.day)]
		.flatMap((agenda) => agenda.busy)
		.filter((busy) => busy.end <= span.start && span.start - busy.end <= JUST_BACK_MS)
		.sort((a, b) => b.end - a.end)[0] ?? null;

/**
 * Sharing its day (settings.initiative.sharing), as the span open now opens: when it comes online within JUST_BACK_MS
 * of a busy block's end, and it is still within JUST_BACK_MS of the span's start, at `chance`. One of its people at
 * rest, `reachable`, whom an opener may go to now, with no plan pending, at `minFamiliarity` and `minAffinity` (faded,
 * as for check-ins), picked by closeness, is planned to hear about it (`about`: the block's reason) at a random moment
 * of the next JUST_BACK_MS, given up an hour into the span (it is not just back any more), and audited
 * (`share_planned`). Answers it, or null.
 */
export function planShare({ store, persona, settings, span, now, rng, reachable = () => true }: PlanContext): Opener | null {
	const { initiative } = settings;
	const own = initiative.sharing;
	if (!initiative.enabled || !own.enabled || now - span.start > JUST_BACK_MS) return null;
	const busy = busyJustBefore(persona, span);
	const until = Math.min(now + JUST_BACK_MS, span.end - initiative.spanEndMinutes * MINUTE);
	if (!busy || until <= now || rng() >= own.chance) return null;
	const candidates = store.quietPeople(persona.id, now - REST_MS).flatMap(({ person, lastAt }) => {
		if (!reachable(person) || store.pendingOpener(person.id) || openerBlock(store, person, now, initiative)) return [];
		const { familiarity, affinity } = faded(person, now - lastAt, settings.relationship);
		const liked = !settings.relationship.affinity.enabled || affinity >= own.minAffinity;
		return familiarity >= own.minFamiliarity && liked ? [{ weight: familiarity * (settings.relationship.affinity.enabled ? 1 + affinity : 1), value: person }] : [];
	});
	const [person] = pickSome(rng, candidates, 1);
	if (!person) return null;
	const opener = store.planOpener(persona.id, person.id, { kind: 'share', about: busy.reason, dueAt: now + rng() * (until - now), expiresAt: Math.min(span.end, span.start + 2 * JUST_BACK_MS) });
	store.audit(persona.id, 'share_planned', { personId: person.id, about: busy.reason, dueAt: opener.dueAt });
	return opener;
}
