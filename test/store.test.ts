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
