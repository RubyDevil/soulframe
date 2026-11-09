/**
 * Texting first (settings.initiative): who the persona may send an opener to, and when a planned one may go. The code
 * decides all of this; the model only decides, as the moment comes, whether to text and what (brain.composeOpener).
 * These guardrails apply whatever the settings say: the settings may only make it rarer.
 */

import { addDays, localDateOf, zonedToUtc } from './schedule.js';
import { HOUR, type Settings } from './settings.js';
import type { Person, Store } from './store.js';

/** At least this long since the last message either way: it never texts first in the middle of a conversation. */
export const REST_MS = 2 * HOUR;
/** The local time a follow-up planned for a later day may go from: never a night that only belongs to it by the date. */
const FOLLOW_UP_FROM_MINUTES = 6 * 60;
/** How many ignored openers in a row may double the wait before the next one (64 times `personGapHours` at most). */
const MAX_BACKOFF = 6;

/**
 * Why no opener may go to the person now, or null when one may. `final`: it never will (they ended it, can't be
 * texted first or never wrote): the opener is dropped. Otherwise it may later: it stays pending until its expiry.
 * Checks, in order: active, no account deny-listed or flagged as possibly under 18, they wrote to it before, no reply
 * owed, nothing written either way for REST_MS, no opener of its own left unanswered, the gap since the last one
 * (`personGapHours`, doubled for each ignored in a row), the persona's `perDay`, and one a day per account for every
 * persona. When in the day is its own hours' to say (the reply queue's spans).
 */
export function openerBlock(store: Store, person: Person, now: number, initiative: Settings['initiative']): { reason: string; final: boolean } | null {
	const final = (reason: string) => ({ reason, final: true });
	const later = (reason: string) => ({ reason, final: false });
	if (person.state !== 'active') return final(person.state);
	const accounts = Object.entries(person.ids);
	if (accounts.some(([channel, externalId]) => store.isDenied(channel, externalId))) return final('denied');
	if (accounts.some(([channel, externalId]) => store.isMinorCautioned(channel, externalId))) return final('minor_caution');
	if (person.incoming === 0) return final('never_wrote');
	if (person.lastInAt > person.handledAt) return later('reply_owed');
	const last = store.history(person.id, 1)[0];
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
