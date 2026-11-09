import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelId } from '../src/channel.js';
import { createStore, openDatabase } from '../src/store.js';
import { memoryStore } from './fixtures.js';

// As in store.ts: Vite doesn't resolve node:sqlite
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const HOUR = 3_600_000;

/** The store on the file at `path`, and its database (closing it closes the store). */
const openStore = (path: string, now?: () => number) => {
	const db = openDatabase(path);
	return { db, store: createStore(db, now) };
};

describe('identities', () => {
	it('finds a person by any of their accounts, and links one more per channel, never one already taken', () => {
		const store = memoryStore();
		const sam = store.createPerson('robin', 'chat', 'd-sam', 'Sam');
		expect(sam.ids).toEqual({ chat: 'd-sam' });
		const linked = store.link(sam.id, 'forum', 'u-sam');
		expect(linked.ids).toEqual({ chat: 'd-sam', forum: 'u-sam' });
		expect(store.person('robin', 'forum', 'u-sam')).toEqual(linked);
		// Another persona knows the same account as someone of its own
		expect(store.createPerson('sky', 'forum', 'u-sam', 'Sam').id).not.toBe(sam.id);
		const jo = store.createPerson('robin', 'forum', 'u-jo', 'Jo');
		expect(() => store.link(sam.id, 'forum', 'u-other')).toThrow(/UNIQUE constraint failed/);
		expect(() => store.link(jo.id, 'chat', 'd-sam')).toThrow(/UNIQUE constraint failed/);
		expect(() => store.createPerson('robin', 'forum', 'u-jo', 'Jo again')).toThrow(/UNIQUE constraint failed/);
		expect(store.personById(jo.id).ids).toEqual({ forum: 'u-jo' });
		// The failed creation left nobody behind
		expect(store.person('robin', 'forum', 'u-jo')?.id).toBe(jo.id);
		expect(() => store.personById(jo.id + 1)).toThrow('No person');
	});
});

describe('unanswered', () => {
	/** A store, and `wrote` for someone of robin's with these messages, each at its own time. */
	const setUp = () => {
		let clock = 0;
		const store = memoryStore(() => clock);
		const wrote = (externalId: string, messages: [channel: ChannelId, direction: 'in' | 'out', at: number][]) => {
			const person = store.createPerson('robin', messages[0]![0], externalId, externalId);
			for (const [platform, direction, at] of messages) {
				clock = at;
				store.addMessage(person.id, platform, direction, 'hi');
				if (direction === 'in') store.updatePerson(person.id, { lastInAt: at });
			}
			return person.id;
		};
		return { store, wrote };
	};

	it('gives the active people still owed a turn since `since`, oldest first, with the platform they last wrote on', () => {
		const { store, wrote } = setUp();
		const sam = wrote('sam', [['forum', 'in', 50 * HOUR]]);
		// Jo wrote on Forum, then on Chat; the persona's reply on Forum after that is not theirs
		const jo = wrote('jo', [['forum', 'in', 20 * HOUR], ['chat', 'in', 30 * HOUR], ['forum', 'out', 31 * HOUR]]);
		const al = wrote('al', [['chat', 'in', 40 * HOUR]]);
		store.updatePerson(wrote('handled', [['forum', 'in', 45 * HOUR]]), { handledAt: 45 * HOUR });
		for (const state of ['stopped', 'blocked', 'denied'] as const) store.updatePerson(wrote(state, [['forum', 'in', 46 * HOUR]]), { state });
		wrote('before since', [['forum', 'in', 9 * HOUR]]);
		expect(store.unanswered('robin', 10 * HOUR).map(({ person, channel }) => [person.id, channel])).toEqual([
			[jo, 'chat'],
			[al, 'chat'],
			[sam, 'forum'],
		]);
		expect(store.unanswered('someone else', 0)).toEqual([]);
	});

	it('leaves out people whose messages were swept', () => {
		const { store, wrote } = setUp();
		wrote('old', [['forum', 'in', 5 * HOUR]]);
		const kept = wrote('kept', [['forum', 'in', 20 * HOUR]]);
		store.sweep(10 * HOUR);
		expect(store.unanswered('robin', 0).map(({ person }) => person.id)).toEqual([kept]);
	});
});

describe('sweep', () => {
	it('deletes only the messages and audit lines from before `before`, through indexes on their times', () => {
		const dir = mkdtempSync(join(tmpdir(), 'soulframe-'));
		let clock = 0;
		const { db: file, store } = openStore(join(dir, 'sweep.db'), () => clock);
		try {
			const sam = store.createPerson('robin', 'forum', 'sam', 'Sam').id;
			for (const at of [9 * HOUR, 10 * HOUR, 11 * HOUR]) {
				clock = at;
				store.addMessage(sam, 'forum', 'in', 'hi');
				store.audit('robin', 'sent');
			}
			store.sweep(10 * HOUR);
			expect(store.history(sam).map(({ at }) => at)).toEqual([10 * HOUR, 11 * HOUR]);
			expect(store.auditLog('robin').map(({ at }) => at)).toEqual([11 * HOUR, 10 * HOUR]);
			const db = new DatabaseSync(join(dir, 'sweep.db'));
			const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as unknown as { name: string }[]).map(({ name }) => name);
			db.close();
			expect(indexes).toEqual(expect.arrayContaining(['messages_at', 'audit_at']));
		} finally {
			file.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows may still hold the file
			}
		}
	});
});

describe('addMessage', () => {
	it('keeps the time it is given, else the clock, and counts only their messages', () => {
		const store = memoryStore(() => 9 * HOUR);
		const sam = store.createPerson('robin', 'forum', 'sam', 'Sam');
		store.addMessage(sam.id, 'forum', 'in', 'hi', 5 * HOUR);
		store.addMessage(sam.id, 'forum', 'out', 'hey');
		expect(store.history(sam.id).map(({ direction, at }) => [direction, at])).toEqual([['in', 5 * HOUR], ['out', 9 * HOUR]]);
		expect(store.personById(sam.id).incoming).toBe(1);
	});
});

describe('deny', () => {
	it("denies every persona's person with that account at once, and nobody else", () => {
		const store = memoryStore();
		const robins = store.createPerson('robin', 'forum', 'u-kid', 'Kid');
		// Sky knows them from Chat, linked to the same Forum account
		const skys = store.link(store.createPerson('sky', 'chat', 'd-kid', 'Kid').id, 'forum', 'u-kid');
		const other = store.createPerson('robin', 'forum', 'u-sam', 'Sam');
		store.deny('forum', 'u-kid', 'minor');
		expect([robins, skys, other].map((person) => store.personById(person.id).state)).toEqual(['denied', 'denied', 'active']);
		expect(store.isDenied('forum', 'u-kid')).toBe(true);
		expect(store.isDenied('chat', 'd-kid')).toBe(false);
	});
});

describe('minor caution', () => {
	it('flags an account for every persona, keeping its first probability', () => {
		const store = memoryStore();
		expect(store.isMinorCautioned('forum', 'u-kid')).toBe(false);
		store.cautionMinor('forum', 'u-kid', 0.6);
		store.cautionMinor('forum', 'u-kid', 0.8);
		expect(store.isMinorCautioned('forum', 'u-kid')).toBe(true);
		// The key flags already stored were written under
		expect(store.get('*', 'minorCaution:forum:u-kid')).toBe('0.6');
		expect(store.isMinorCautioned('chat', 'u-kid')).toBe(false);
	});
});

describe('what came with a message', () => {
	it('is stored with it, and replaced once looked at', () => {
		const store = memoryStore();
		const { id: sam } = store.createPerson('robin', 'chat', 'sam', 'Sam');
		store.addMessage(sam, 'chat', 'in', 'plain', 1);
		store.addMessage(sam, 'chat', 'in', '', 2, { images: [{ url: 'https://cdn.example/p.jpg' }], links: [] });
		const [plain, photo] = store.history(sam);
		expect(plain).not.toHaveProperty('media');
		expect(photo!.media).toEqual({ images: [{ url: 'https://cdn.example/p.jpg' }], links: [] });
		store.setMedia(photo!.id, { images: [{ seen: 'a cat' }], links: [] });
		expect(store.history(sam)[1]!.media).toEqual({ images: [{ seen: 'a cat' }], links: [] });
	});

	it('gets its column on a database made before it, keeping the messages', () => {
		const db = openDatabase(':memory:');
		db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, channel TEXT NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)');
		db.prepare("INSERT INTO messages (person_id, channel, direction, text, at) VALUES (1, 'chat', 'in', 'old', 5)").run();
		const store = createStore(db, () => 0);
		expect(store.history(1)).toEqual([{ id: 1, channel: 'chat', direction: 'in', text: 'old', at: 5 }]);
		// Opening it again changes nothing
		expect(createStore(db, () => 0).history(1)).toHaveLength(1);
		db.close();
	});
});

describe('a database made by the first beta', () => {
	it('gets the columns added since, familiarity starting from the conversations so far', () => {
		const db = openDatabase(':memory:');
		// The first beta's people table
		db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, persona TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', incoming INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', conversations INTEGER NOT NULL DEFAULT 0, last_in_at INTEGER NOT NULL DEFAULT 0, handled_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
		db.prepare('INSERT INTO people (persona, name, conversations, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run('robin', 'Sam', 5);
		db.prepare('INSERT INTO people (persona, name, conversations, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run('robin', 'Kai', 0);
		const store = createStore(db, () => 0);
		// 5 conversations made Sam a regular, as the conversation counts did
		expect(store.personById(1)).toMatchObject({ familiarity: 1 - 0.9 ** 5, affinity: 0, importance: 1, importanceAt: 0 });
		expect(store.personById(2).familiarity).toBe(0);
		// Opening it again changes nothing
		store.updatePerson(1, { familiarity: 0.7 });
		expect(createStore(db, () => 0).personById(1).familiarity).toBe(0.7);
		db.close();
	});
});

describe('forgetting and resetting', () => {
	/** Two personas with people who talked, notes, kv and audit lines. */
	const populated = () => {
		const store = memoryStore(() => 1_000);
		const ana = store.createPerson('robin', 'forum', 'ana', 'Ana');
		const bo = store.createPerson('robin', 'forum', 'bo', 'Bo');
		const cy = store.createPerson('sky', 'forum', 'cy', 'Cy');
		for (const person of [ana, bo, cy]) {
			store.addMessage(person.id, 'forum', 'in', 'hi');
			store.addMessage(person.id, 'forum', 'out', 'hey');
			store.audit(person.persona, 'sent', { personId: person.id });
			store.set(person.persona, `relationship:${person.id}`, '{}');
		}
		store.updatePerson(ana.id, { summary: 'likes jazz', familiarity: 0.5 });
		store.set('robin', 'selfNotes', 'has a cat');
		store.set('sky', 'selfNotes', 'has a dog');
		store.audit('robin', 'started');
		return { store, ana, bo, cy };
	};

	it('forgets one person with their messages, accounts, levels and audit lines, and nobody else', () => {
		const { store, ana, bo } = populated();
		expect(store.forgetPerson(ana.id)).toBe(true);
		expect(() => store.personById(ana.id)).toThrow();
		expect(store.person('robin', 'forum', 'ana')).toBeUndefined();
		expect(store.history(ana.id)).toEqual([]);
		expect(store.get('robin', `relationship:${ana.id}`)).toBeNull();
		expect(store.auditLog('robin').filter((row) => row.detail.personId === ana.id)).toEqual([]);
		// The others, and the persona's own values
		expect(store.history(bo.id)).toHaveLength(2);
		expect(store.get('robin', `relationship:${bo.id}`)).toBe('{}');
		expect(store.get('robin', 'selfNotes')).toBe('has a cat');
		expect(store.forgetPerson(ana.id)).toBe(false);
		// Someone new on that account starts from nothing
		expect(store.createPerson('robin', 'forum', 'ana', 'Ana').familiarity).toBe(0);
	});

	it('keeps a person who asked to stop, was blocked or denied, unless includeEnded', () => {
		const { store, ana } = populated();
		store.updatePerson(ana.id, { state: 'stopped' });
		expect(store.forgetPerson(ana.id)).toBe(false);
		expect(store.personById(ana.id).state).toBe('stopped');
		expect(store.forgetPerson(ana.id, { includeEnded: true })).toBe(true);
	});

	it('keeps the deny list and the minor flags of a forgotten account', () => {
		const { store, ana } = populated();
		store.deny('forum', 'ana', 'minor');
		store.cautionMinor('forum', 'ana', 0.6);
		expect(store.forgetPerson(ana.id, { includeEnded: true })).toBe(true);
		expect(store.isDenied('forum', 'ana')).toBe(true);
		expect(store.isMinorCautioned('forum', 'ana')).toBe(true);
	});

	it("resets one persona: its people, messages, kv and audit, and no other persona's, nor the deny list", () => {
		const { store, ana, bo, cy } = populated();
		store.deny('forum', 'dee', 'minor');
		store.cautionMinor('forum', 'dee', 0.7);
		expect(store.resetPersona('robin')).toEqual({ people: 2, messages: 4 });
		expect([ana, bo].map((p) => store.person('robin', 'forum', p.ids.forum!))).toEqual([undefined, undefined]);
		expect(store.get('robin', 'selfNotes')).toBeNull();
		expect(store.auditLog('robin')).toEqual([]);
		// The other persona, the deny list and the minor flags
		expect(store.history(cy.id)).toHaveLength(2);
		expect(store.get('sky', 'selfNotes')).toBe('has a dog');
		expect(store.auditLog('sky')).toHaveLength(1);
		expect(store.isDenied('forum', 'dee')).toBe(true);
		expect(store.isMinorCautioned('forum', 'dee')).toBe(true);
		// Nothing left to reset
		expect(store.resetPersona('robin')).toEqual({ people: 0, messages: 0 });
	});

	it('keeps the ended people of a persona and their audit lines, unless includeEnded', () => {
		const { store, ana, bo } = populated();
		store.updatePerson(bo.id, { state: 'blocked' });
		expect(store.resetPersona('robin')).toEqual({ people: 1, messages: 2 });
		expect(store.personById(bo.id).state).toBe('blocked');
		expect(store.history(bo.id)).toHaveLength(2);
		expect(store.auditLog('robin').map((row) => row.detail.personId)).toEqual([bo.id]);
		expect(() => store.personById(ana.id)).toThrow();
		expect(store.resetPersona('robin', { includeEnded: true })).toEqual({ people: 1, messages: 2 });
		expect(store.auditLog('robin')).toEqual([]);
	});
});

describe('blocking and unblocking by hand', () => {
	it('blocks an active person, audited, and unblocks them or someone who asked to stop; nothing else', () => {
		const store = memoryStore(() => 5_000);
		const ana = store.createPerson('robin', 'forum', 'ana', 'Ana');
		expect(store.block(ana.id)).toBe(true);
		expect(store.personById(ana.id).state).toBe('blocked');
		expect(store.auditLog('robin')[0]).toMatchObject({ kind: 'blocked', detail: { personId: ana.id, source: 'manual' } });
		// Already ended, or nobody
		expect(store.block(ana.id)).toBe(false);
		expect(store.block(99)).toBe(false);
		expect(store.unblock(ana.id)).toBe(true);
		expect(store.personById(ana.id).state).toBe('active');
		expect(store.auditLog('robin')[0]).toMatchObject({ kind: 'unblocked', detail: { personId: ana.id, from: 'blocked', source: 'manual' } });
		store.updatePerson(ana.id, { state: 'stopped' });
		expect(store.unblock(ana.id)).toBe(true);
		// Active already; denied is lifted by undeny
		expect(store.unblock(ana.id)).toBe(false);
		store.deny('forum', 'ana', 'minor');
		expect(store.unblock(ana.id)).toBe(false);
		expect(store.personById(ana.id).state).toBe('denied');
	});

	it('takes an account off the deny list and makes its people active, unless another account of theirs is still listed', () => {
		const store = memoryStore(() => 5_000);
		const ana = store.createPerson('robin', 'forum', 'ana', 'Ana');
		store.link(ana.id, 'chat', 'ana-chat');
		store.deny('forum', 'ana', 'minor');
		store.deny('chat', 'ana-chat', 'minor');
		expect(store.personById(ana.id).state).toBe('denied');
		expect(store.undeny('forum', 'ana')).toBe(true);
		expect(store.isDenied('forum', 'ana')).toBe(false);
		// The other account is still listed
		expect(store.personById(ana.id).state).toBe('denied');
		expect(store.undeny('chat', 'ana-chat')).toBe(true);
		expect(store.personById(ana.id).state).toBe('active');
		expect(store.auditLog('robin')[0]).toMatchObject({ kind: 'undenied', detail: { personId: ana.id, platform: 'chat', source: 'manual' } });
		expect(store.undeny('chat', 'ana-chat')).toBe(false);
	});

	it('clears a minor-caution flag once, and says if there was none', () => {
		const store = memoryStore();
		store.cautionMinor('forum', 'ana', 0.6);
		expect(store.clearMinorCaution('forum', 'ana')).toBe(true);
		expect(store.isMinorCautioned('forum', 'ana')).toBe(false);
		expect(store.clearMinorCaution('forum', 'ana')).toBe(false);
	});
});

describe('openers', () => {
	const plan = { kind: 'followUp' as const, about: 'ask how the interview went', dueAt: 1_000, expiresAt: 5_000 };

	it('keeps one pending per person, a newer plan replacing it, and closes each once', () => {
		let at = 500;
		const store = memoryStore(() => at);
		const sam = store.createPerson('robin', 'chat', 'sam', 'Sam');
		const first = store.planOpener('robin', sam.id, plan);
		expect(first).toMatchObject({ personId: sam.id, persona: 'robin', about: plan.about, dueAt: 1_000, closedAt: null, outcome: null });
		const second = store.planOpener('robin', sam.id, { ...plan, about: 'the trip' });
		expect(store.pendingOpener(sam.id)?.id).toBe(second.id);
		at = 900;
		store.closeOpener(second.id, 'declined');
		store.closeOpener(second.id, 'sent');
		expect(store.pendingOpener(sam.id)).toBeUndefined();
		expect(store.sentOpeners(sam.id)).toEqual([]);
	});

	it('answers those due, earliest first, after closing those past their expiry', () => {
		const store = memoryStore(() => 0);
		const sam = store.createPerson('robin', 'chat', 'sam', 'Sam');
		const kim = store.createPerson('robin', 'chat', 'kim', 'Kim');
		const ana = store.createPerson('robin', 'chat', 'ana', 'Ana');
		store.planOpener('robin', sam.id, { ...plan, dueAt: 2_000 });
		store.planOpener('robin', kim.id, { ...plan, dueAt: 1_000 });
		const old = store.planOpener('robin', ana.id, { ...plan, dueAt: 100, expiresAt: 200 });
		store.planOpener('robin', store.createPerson('robin', 'chat', 'lee', 'Lee').id, { ...plan, dueAt: 9_000, expiresAt: 10_000 });
		expect(store.dueOpeners('robin', 3_000).map((opener) => opener.personId)).toEqual([kim.id, sam.id]);
		expect(store.dueOpeners('sky', 3_000)).toEqual([]);
		expect(store.pendingOpener(ana.id)).toBeUndefined();
		expect(old.id).toBeGreaterThan(0);
	});

	it('counts those sent, per persona and per account across personas, and goes with the person', () => {
		let at = 1_000;
		const store = memoryStore(() => at);
		const sam = store.createPerson('robin', 'chat', 'sam', 'Sam');
		const skysSam = store.createPerson('sky', 'chat', 'sam', 'Sam');
		const kim = store.createPerson('sky', 'chat', 'kim', 'Kim');
		store.closeOpener(store.planOpener('sky', skysSam.id, plan).id, 'sent');
		store.closeOpener(store.planOpener('sky', kim.id, plan).id, 'rehearsed');
		expect(store.openersSentSince('sky', 0)).toBe(1);
		expect(store.openersSentSince('robin', 0)).toBe(0);
		expect(store.accountOpenedSince(sam.id, 0)).toBe(true);
		expect(store.accountOpenedSince(sam.id, 2_000)).toBe(false);
		expect(store.accountOpenedSince(kim.id, 0)).toBe(false);
		expect(store.sentOpeners(skysSam.id).map((opener) => opener.outcome)).toEqual(['sent']);
		at = 10_000;
		store.sweep(5_000);
		expect(store.sentOpeners(skysSam.id)).toEqual([]);
		store.planOpener('robin', sam.id, plan);
		store.forgetPerson(sam.id);
		expect(store.dueOpeners('robin', 10_000)).toEqual([]);
	});

	it('reads when someone first wrote after a moment, and the hours of the day they write at', () => {
		const store = memoryStore(() => 0);
		const sam = store.createPerson('robin', 'chat', 'sam', 'Sam');
		store.addMessage(sam.id, 'chat', 'in', 'hi', Date.UTC(2026, 9, 15, 20, 30));
		store.addMessage(sam.id, 'chat', 'in', 'still up', Date.UTC(2026, 9, 16, 23, 5));
		store.addMessage(sam.id, 'chat', 'out', 'me too', Date.UTC(2026, 9, 17, 4));
		expect(store.hoursWritten(sam.id)).toEqual([20, 23]);
		expect(store.firstInAfter(sam.id, Date.UTC(2026, 9, 16))).toBe(Date.UTC(2026, 9, 16, 23, 5));
		expect(store.firstInAfter(sam.id, Date.UTC(2026, 9, 17))).toBeNull();
	});
});
