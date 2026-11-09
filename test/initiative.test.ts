import { describe, expect, it } from 'vitest';
import { followUpWindow, openerBlock, REST_MS } from '../src/initiative.js';
import { DAY, HOUR, MINUTE } from '../src/settings.js';
import { memoryStore, settingsOf } from './fixtures.js';

// Thursday 20:00 UTC
const NOW = Date.UTC(2026, 9, 15, 20);
const initiative = settingsOf({ initiative: { enabled: true } }).initiative;

/** A store at NOW with one person of 'robin' who wrote yesterday at 20:00 and was answered. */
const setUp = () => {
	let at = NOW;
	const store = memoryStore(() => at);
	const person = store.createPerson('robin', 'chat', 'sam', 'Sam');
	const wrote = NOW - DAY;
	store.addMessage(person.id, 'chat', 'in', 'interview tomorrow!', wrote);
	store.addMessage(person.id, 'chat', 'out', 'good luck!!', wrote + MINUTE);
	store.updatePerson(person.id, { lastInAt: wrote, handledAt: wrote });
	return { store, person: store.personById(person.id), setNow: (ms: number) => (at = ms) };
};

/** Sends an opener to the person, closed at `at`. */
const sentAt = (store: ReturnType<typeof memoryStore>, personId: number, persona = 'robin') => {
	const opener = store.planOpener(persona, personId, { kind: 'followUp', about: 'x', dueAt: 0, expiresAt: NOW + DAY });
	store.closeOpener(opener.id, 'sent');
	return opener;
};

describe('openerBlock', () => {
	it('lets an opener go to someone at rest who wrote before, at an hour they write at', () => {
		const { store, person } = setUp();
		expect(openerBlock(store, person, NOW, initiative)).toBeNull();
	});

	it('never texts first anyone who ended it, is denied or flagged, or never wrote', () => {
		const { store, person } = setUp();
		expect(openerBlock(store, { ...person, state: 'stopped' }, NOW, initiative)).toEqual({ reason: 'stopped', final: true });
		expect(openerBlock(store, { ...person, incoming: 0 }, NOW, initiative)).toEqual({ reason: 'never_wrote', final: true });
		store.cautionMinor('chat', 'sam', 0.6);
		expect(openerBlock(store, person, NOW, initiative)).toEqual({ reason: 'minor_caution', final: true });
		store.deny('chat', 'sam', 'minor');
		expect(openerBlock(store, person, NOW, initiative)).toEqual({ reason: 'denied', final: true });
	});

	it('waits while a reply is owed and in the middle of a conversation', () => {
		const { store, person } = setUp();
		expect(openerBlock(store, { ...person, lastInAt: person.handledAt + 1 }, NOW, initiative)).toEqual({ reason: 'reply_owed', final: false });
		store.addMessage(person.id, 'chat', 'out', 'hm', NOW - REST_MS + MINUTE);
		expect(openerBlock(store, person, NOW, initiative)?.reason).toBe('mid_conversation');
	});

	it('leaves one opener unanswered at most, and doubles the gap for each one in a row they ignored', () => {
		const { store, person } = setUp();
		sentAt(store, person.id);
		// Closed at the store's clock
		const closedAt = NOW;
		expect(openerBlock(store, store.personById(person.id), NOW + 3 * DAY, initiative)?.reason).toBe('unanswered');
		// They answer three days later: past the 48 hours, so it was ignored, and the next waits twice the gap
		const answered = closedAt + 3 * DAY;
		store.addMessage(person.id, 'chat', 'in', 'sorry, busy week', answered);
		store.updatePerson(person.id, { lastInAt: answered, handledAt: answered });
		const now = closedAt + 3 * DAY + 3 * HOUR;
		expect(openerBlock(store, store.personById(person.id), now, initiative)?.reason).toBe('too_soon');
		expect(openerBlock(store, store.personById(person.id), closedAt + 4 * DAY + HOUR, initiative)).toBeNull();
	});

	it('keeps to perDay, and to one opener a day per account across personas', () => {
		const { store, person } = setUp();
		const other = store.createPerson('robin', 'chat', 'kim', 'Kim');
		sentAt(store, other.id);
		sentAt(store, other.id);
		expect(openerBlock(store, person, NOW + HOUR, initiative)?.reason).toBe('day_cap');
		const { store: shared, person: sam } = setUp();
		const skysSam = shared.createPerson('sky', 'chat', 'sam', 'Sam');
		sentAt(shared, skysSam.id, 'sky');
		expect(openerBlock(shared, sam, NOW + HOUR, initiative)?.reason).toBe('account_cap');
	});

	it('only texts at an hour of the day they have written at, within an hour', () => {
		const { store, person } = setUp();
		expect(openerBlock(store, person, NOW + HOUR + 30 * MINUTE, initiative)).toBeNull();
		expect(openerBlock(store, person, NOW - 2 * HOUR, initiative)).toEqual({ reason: 'their_hours', final: false });
	});
});

describe('followUpWindow', () => {
	it('is later today from REST_MS, or that day from 6 AM, until the end of the day after it, in its time zone', () => {
		expect(followUpWindow(NOW, 0, 'UTC')).toEqual({ dueAt: NOW + REST_MS, expiresAt: Date.UTC(2026, 9, 17) });
		expect(followUpWindow(NOW, 1, 'UTC')).toEqual({ dueAt: Date.UTC(2026, 9, 16, 6), expiresAt: Date.UTC(2026, 9, 18) });
		// 20:00 UTC is 4 PM in Toronto (EDT): its tomorrow at 6 AM is 10:00 UTC
		expect(followUpWindow(NOW, 1, 'America/Toronto').dueAt).toBe(Date.UTC(2026, 9, 16, 10));
	});
});
