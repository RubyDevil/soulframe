import { describe, expect, it } from 'vitest';
import { followUpWindow, openerBlock, planCheckIns, planShare, REST_MS } from '../src/initiative.js';
import type { Rng } from '../src/rng.js';
import { spanAt } from '../src/schedule.js';
import { DAY, HOUR, MINUTE, type Settings } from '../src/settings.js';
import type { Store } from '../src/store.js';
import { memoryStore, personaOf, settingsOf, testPersona } from './fixtures.js';

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
	it('lets an opener go to someone at rest who wrote before, at any hour', () => {
		const { store, person } = setUp();
		expect(openerBlock(store, person, NOW, initiative)).toBeNull();
		expect(openerBlock(store, person, NOW - 8 * HOUR, initiative)).toBeNull();
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
});

describe('followUpWindow', () => {
	it('is later today from REST_MS, or that day from 6 AM, until the end of the day after it, in its time zone', () => {
		expect(followUpWindow(NOW, 0, 'UTC')).toEqual({ dueAt: NOW + REST_MS, expiresAt: Date.UTC(2026, 9, 17) });
		expect(followUpWindow(NOW, 1, 'UTC')).toEqual({ dueAt: Date.UTC(2026, 9, 16, 6), expiresAt: Date.UTC(2026, 9, 18) });
		// 20:00 UTC is 4 PM in Toronto (EDT): its tomorrow at 6 AM is 10:00 UTC
		expect(followUpWindow(NOW, 1, 'America/Toronto').dueAt).toBe(Date.UTC(2026, 9, 16, 10));
	});
});

describe('openerBlock on a check-in', () => {
	it('drops a check-in once they talked since it was planned, and lets it go otherwise', () => {
		const { store, person } = setUp();
		const opener = store.planOpener('robin', person.id, { kind: 'checkIn', about: '', dueAt: NOW, expiresAt: NOW + HOUR });
		expect(openerBlock(store, person, NOW + 3 * HOUR, initiative, opener)).toBeNull();
		store.addMessage(person.id, 'chat', 'in', 'hey you', NOW + MINUTE);
		store.updatePerson(person.id, { lastInAt: NOW + MINUTE, handledAt: NOW + MINUTE });
		expect(openerBlock(store, store.personById(person.id), NOW + 3 * HOUR, initiative, opener)).toEqual({ reason: 'talked_since', final: true });
	});
});

// The test persona: online 19:00 to 23:00 UTC every day, at the gym until 18:50 with `gym`
const GYM = { days: { 'mon-sun': { busy: [{ reason: 'at the gym', start: ['17:30', '17:30'], end: ['18:50', '18:50'] }], online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }] } } };
const persona = personaOf(testPersona());
const gymGoer = personaOf(testPersona({ schedule: GYM }));
// Thursday, five minutes into its online time
const EVENING = Date.UTC(2026, 9, 15, 19, 5);
const span = spanAt(persona, EVENING)!;
const ON = settingsOf({ initiative: { enabled: true, sharing: { enabled: true } } });

/** Successive draws, the last one repeated. */
const draws = (...values: number[]): Rng => {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)]!;
};

/** One of the persona's people, last in touch `quietDays` ago, answered. */
const friend = (store: Store, name: string, { familiarity = 0.5, affinity = 0.3, quietDays = 5 } = {}) => {
	const created = store.createPerson('test', 'chat', name, name);
	const at = EVENING - quietDays * DAY;
	store.addMessage(created.id, 'chat', 'in', 'talk soon!', at);
	store.updatePerson(created.id, { lastInAt: at, handledAt: at, familiarity, affinity });
	return store.personById(created.id);
};

const checkIns = (store: Store, { settings = ON, rng = () => 0, now = EVENING }: { settings?: Settings; rng?: Rng; now?: number } = {}) =>
	planCheckIns({ store, persona, settings, span, now, rng });

describe('planCheckIns', () => {
	it('plans one for someone close gone quiet, at a random moment of the online time it may still use', () => {
		const store = memoryStore(() => EVENING);
		const alex = friend(store, 'alex');
		const until = span.end - 20 * MINUTE;
		expect(checkIns(store, { rng: draws(0, 0.5) })).toEqual([expect.objectContaining({ personId: alex.id, kind: 'checkIn', dueAt: EVENING + 0.5 * (until - EVENING), expiresAt: span.end })]);
		expect(store.pendingOpener(alex.id)?.kind).toBe('checkIn');
		expect(store.auditLog('test', 1)[0]).toMatchObject({ kind: 'check_in_planned', detail: { personId: alex.id } });
	});

	it('leaves out who is not close, not liked, not quiet long enough, or has a plan already', () => {
		const store = memoryStore(() => EVENING);
		friend(store, 'kim', { familiarity: 0.2 });
		friend(store, 'lee', { affinity: -0.1 });
		friend(store, 'sam', { quietDays: 1 });
		const ana = friend(store, 'ana');
		store.planOpener('test', ana.id, { kind: 'followUp', about: 'the trip', dueAt: EVENING + DAY, expiresAt: EVENING + 3 * DAY });
		expect(checkIns(store)).toEqual([]);
		expect(store.pendingOpener(ana.id)?.kind).toBe('followUp');
		// Without affinity, nobody is left out for it
		expect(checkIns(store, { settings: settingsOf({ initiative: { enabled: true }, relationship: { affinity: { enabled: false } } }) }).map((opener) => opener.kind)).toEqual(['checkIn']);
	});

	it('lets those apart for months drift off: their familiarity fades below the threshold', () => {
		const store = memoryStore(() => EVENING);
		friend(store, 'gone', { familiarity: 0.5, quietDays: 70 });
		expect(checkIns(store)).toEqual([]);
		const drifting = friend(store, 'drifting', { familiarity: 0.5, quietDays: 20 });
		expect(checkIns(store).map((opener) => opener.personId)).toEqual([drifting.id]);
	});

	it('draws each at a chance that grows with closeness, about once in meanDays of silence', () => {
		// Familiarity kept as it is while they are apart, to see the rate alone
		const settings = settingsOf({ initiative: { enabled: true }, relationship: { familiarity: { fadeHalfLifeDays: 0 } } });
		const store = memoryStore(() => EVENING);
		friend(store, 'alex', { familiarity: 0.32 });
		// 215 of its 240 minutes left today, at once in 7 days: 1 - exp(-(1 / 7) * 215 / 240), about 0.12
		expect(checkIns(store, { settings, rng: () => 0.13 })).toEqual([]);
		expect(checkIns(store, { settings, rng: draws(0.12, 0) })).toHaveLength(1);
		const close = memoryStore(() => EVENING);
		friend(close, 'kai', { familiarity: 1 });
		// Twice as often for the closest: about 0.23
		expect(checkIns(close, { settings, rng: () => 0.24 })).toEqual([]);
		expect(checkIns(close, { settings, rng: draws(0.22, 0) })).toHaveLength(1);
	});

	it('plans no more than perDay leaves, and nothing while off', () => {
		const store = memoryStore(() => EVENING);
		for (const name of ['alex', 'kim', 'lee']) friend(store, name);
		expect(checkIns(store)).toHaveLength(2);
		const capped = memoryStore(() => EVENING);
		friend(capped, 'alex');
		for (const name of ['x', 'y']) capped.closeOpener(capped.planOpener('test', capped.createPerson('test', 'chat', name, name).id, { kind: 'followUp', about: 'x', dueAt: 0, expiresAt: EVENING + DAY }).id, 'sent');
		expect(checkIns(capped)).toEqual([]);
		const off = memoryStore(() => EVENING);
		friend(off, 'alex');
		expect(checkIns(off, { settings: settingsOf() })).toEqual([]);
		expect(checkIns(off, { settings: settingsOf({ initiative: { enabled: true, checkIns: { enabled: false } } }) })).toEqual([]);
	});

	it('leaves out who no allowed channel reaches', () => {
		const store = memoryStore(() => EVENING);
		const alex = friend(store, 'alex');
		friend(store, 'kim');
		expect(planCheckIns({ store, persona, settings: ON, span, now: EVENING, rng: () => 0, reachable: (person) => person.id === alex.id }).map((opener) => opener.personId)).toEqual([alex.id]);
	});

	it('plans nothing once too little of its online time is left', () => {
		const store = memoryStore(() => EVENING);
		friend(store, 'alex');
		expect(checkIns(store, { now: span.end - 10 * MINUTE })).toEqual([]);
	});
});

describe('planShare', () => {
	const share = (store: Store, { who = gymGoer, settings = ON, rng = () => 0 as number, now = EVENING } = {}) =>
		planShare({ store, persona: who, settings, span: spanAt(who, now)!, now, rng });

	it('plans one right after a busy block, to one of those it is close to and likes, about the block', () => {
		const store = memoryStore(() => EVENING);
		const alex = friend(store, 'alex', { familiarity: 0.7, affinity: 0.5, quietDays: 1 });
		friend(store, 'lee', { familiarity: 0.3 });
		const opener = share(store);
		expect(opener).toMatchObject({ personId: alex.id, kind: 'share', about: 'at the gym', dueAt: EVENING });
		expect(opener!.expiresAt).toBeLessThanOrEqual(Date.UTC(2026, 9, 15, 20));
		expect(store.auditLog('test', 1)[0]).toMatchObject({ kind: 'share_planned', detail: { personId: alex.id, about: 'at the gym' } });
	});

	it('plans nothing without a busy block just before, late in its online time, at an unlucky draw, or while off', () => {
		for (const options of [{ who: persona }, { now: EVENING + 40 * MINUTE }, { rng: () => 0.2 }, { settings: settingsOf({ initiative: { enabled: true } }) }]) {
			const store = memoryStore(() => EVENING);
			friend(store, 'alex', { familiarity: 0.7, affinity: 0.5 });
			expect(share(store, options)).toBeNull();
		}
		// Nobody close enough
		const store = memoryStore(() => EVENING);
		friend(store, 'kim', { familiarity: 0.4, affinity: 0.5 });
		expect(share(store)).toBeNull();
	});
});
