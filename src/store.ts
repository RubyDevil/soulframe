import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { ChannelId } from './channel.js';

// Loaded through Node's own require: Vite (under the tests) doesn't know node:sqlite yet and fails to resolve it
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** `stopped`: they asked to stop or can't be reached; `blocked`: the persona blocked them; `denied`: deny-listed (`store.deny`, with its reason). */
export type PersonState = 'active' | 'stopped' | 'blocked' | 'denied';

/** Someone a persona talks with, on one channel or several once linked. */
export interface Person {
	id: number;
	persona: string;
	/** Their account on each channel they are known on. */
	ids: Readonly<Record<ChannelId, string>>;
	name: string;
	state: PersonState;
	/** Messages they sent, on every channel. */
	incoming: number;
	summary: string;
	/** Conversations so far: a message after `memory.conversationGapHours` of silence from them starts one. */
	conversations: number;
	/** When they last wrote (ms), 0 never. */
	lastInAt: number;
	/** Their messages up to this time (ms) had a turn: they are still owed one while `lastInAt` is later. */
	handledAt: number;
	/** When they were first seen (ms); never changed. */
	firstSeenAt: number;
}

export interface StoredMessage {
	channel: ChannelId;
	direction: 'in' | 'out';
	text: string;
	at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
	id INTEGER PRIMARY KEY,
	persona TEXT NOT NULL,
	name TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	incoming INTEGER NOT NULL DEFAULT 0,
	summary TEXT NOT NULL DEFAULT '',
	conversations INTEGER NOT NULL DEFAULT 0,
	last_in_at INTEGER NOT NULL DEFAULT 0,
	handled_at INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
	persona TEXT NOT NULL,
	channel TEXT NOT NULL,
	external_id TEXT NOT NULL,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	PRIMARY KEY (persona, channel, external_id),
	UNIQUE (person_id, channel)
);
CREATE INDEX IF NOT EXISTS identities_account ON identities (channel, external_id);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	direction TEXT NOT NULL,
	text TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_person ON messages (person_id, at);
CREATE INDEX IF NOT EXISTS messages_at ON messages (at);
CREATE TABLE IF NOT EXISTS deny (
	channel TEXT NOT NULL,
	external_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (channel, external_id)
);
CREATE TABLE IF NOT EXISTS kv (
	persona TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (persona, key)
);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	persona TEXT NOT NULL,
	kind TEXT NOT NULL,
	detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
`;

/** A person's row and, in `ids`, their identities as one JSON object ({"<channel>": "<external id>"}). */
const PERSON_COLUMNS = 'p.*, (SELECT json_group_object(i.channel, i.external_id) FROM identities i WHERE i.person_id = p.id) AS ids';
const PERSON_SELECT = `SELECT ${PERSON_COLUMNS} FROM people p`;

interface PersonRow {
	id: number;
	persona: string;
	ids: string;
	name: string;
	state: PersonState;
	incoming: number;
	summary: string;
	conversations: number;
	last_in_at: number;
	handled_at: number;
	created_at: number;
}

const toPerson = (row: PersonRow): Person => ({
	id: row.id,
	persona: row.persona,
	ids: JSON.parse(row.ids) as Person['ids'],
	name: row.name,
	state: row.state,
	incoming: row.incoming,
	summary: row.summary,
	conversations: row.conversations,
	lastInAt: row.last_in_at,
	handledAt: row.handled_at,
	firstSeenAt: row.created_at,
});

const COLUMNS: Record<keyof Omit<Person, 'id' | 'persona' | 'ids' | 'firstSeenAt'>, string> = {
	name: 'name',
	state: 'state',
	incoming: 'incoming',
	summary: 'summary',
	conversations: 'conversations',
	lastInAt: 'last_in_at',
	handledAt: 'handled_at',
};

/** The key of the flag on someone possibly under 18 (settings.decisions.minor.cautionAt), in the kv of every persona ('*'). */
const minorCautionKey = (channel: ChannelId, externalId: string) => `minorCaution:${channel}:${externalId}`;

export type Database = InstanceType<typeof DatabaseSync>;

/** Runs `work` in one transaction on `db`: all of it or nothing (the app's own migrations use it too). */
export function inTransaction<T>(db: Database, work: () => T): T {
	db.exec('BEGIN');
	try {
		const result = work();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

/** The app's SQLite file (`:memory:` in tests), its folder made if missing: one connection for every table in it, the app's own included. */
export function openDatabase(path: string): Database {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	// A second process on the same file (a dry run, say) waits up to 5 s for a lock instead of failing with 'database is locked'
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	return db;
}

export type Store = ReturnType<typeof createStore>;

/**
 * soulframe's own state (people and their identities, their messages, the deny-list, kv, audit) in `db`, its tables
 * made if missing. A file in an older layout of the app's own is the app's to migrate first. Whoever opened `db` closes it.
 */
export function createStore(db: Database, now: () => number = Date.now) {
	db.exec(SCHEMA);

	const byId = (id: number) => {
		const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id) as unknown as PersonRow | undefined;
		if (!row) throw new Error(`No person ${id}`);
		return toPerson(row);
	};

	return {
		person(persona: string, channel: ChannelId, externalId: string): Person | undefined {
			const row = db
				.prepare(`${PERSON_SELECT} JOIN identities account ON account.person_id = p.id WHERE account.persona = ? AND account.channel = ? AND account.external_id = ?`)
				.get(persona, channel, externalId) as unknown as PersonRow | undefined;
			return row && toPerson(row);
		},
		personById: byId,
		createPerson(persona: string, channel: ChannelId, externalId: string, name: string): Person {
			const at = now();
			const id = inTransaction(db, () => {
				const result = db.prepare('INSERT INTO people (persona, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(persona, name, at, at);
				db.prepare('INSERT INTO identities (persona, channel, external_id, person_id) VALUES (?, ?, ?, ?)').run(persona, channel, externalId, result.lastInsertRowid);
				return Number(result.lastInsertRowid);
			});
			return byId(id);
		},
		/** Gives the person their account on `channel`; throws when they have one there already, or another of the persona's people has this one (callers check `person` first). */
		link(personId: number, channel: ChannelId, externalId: string): Person {
			db.prepare('INSERT INTO identities (persona, channel, external_id, person_id) SELECT persona, ?, ?, id FROM people WHERE id = ?').run(channel, externalId, personId);
			db.prepare('UPDATE people SET updated_at = ? WHERE id = ?').run(now(), personId);
			return byId(personId);
		},
		updatePerson(id: number, patch: Partial<Omit<Person, 'id' | 'persona' | 'ids' | 'firstSeenAt'>>): Person {
			const entries = Object.entries(patch) as [keyof typeof COLUMNS, unknown][];
			if (entries.length) {
				const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ');
				const values = entries.map(([, value]) => (typeof value === 'boolean' ? Number(value) : value) as string | number | null);
				db.prepare(`UPDATE people SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
			}
			return byId(id);
		},
		addMessage(personId: number, channel: ChannelId, direction: 'in' | 'out', text: string, at = now()) {
			db.prepare('INSERT INTO messages (person_id, channel, direction, text, at) VALUES (?, ?, ?, ?, ?)').run(personId, channel, direction, text, at);
			if (direction === 'in') db.prepare('UPDATE people SET incoming = incoming + 1, updated_at = ? WHERE id = ?').run(now(), personId);
		},
		/** The last `limit` messages with the person, oldest first. */
		history(personId: number, limit = 40): StoredMessage[] {
			const rows = db
				.prepare('SELECT channel, direction, text, at FROM messages WHERE person_id = ? ORDER BY at DESC, id DESC LIMIT ?')
				.all(personId, limit) as unknown as StoredMessage[];
			return rows.reverse();
		},
		/**
		 * Active people still owed a turn who last wrote at `since` or later, oldest first, each with the channel they
		 * last wrote on (people whose messages were swept are left out): answered when the app starts again (the reply queue's `requeue`).
		 */
		unanswered(persona: string, since: number): { person: Person; channel: ChannelId }[] {
			const rows = db
				.prepare(
					`SELECT ${PERSON_COLUMNS}, m.channel AS last_channel FROM people p
					 JOIN messages m ON m.id = (SELECT id FROM messages WHERE person_id = p.id AND direction = 'in' ORDER BY at DESC, id DESC LIMIT 1)
					 WHERE p.persona = ? AND p.state = 'active' AND p.last_in_at > p.handled_at AND p.last_in_at >= ?
					 ORDER BY p.last_in_at, p.id`,
				)
				.all(persona, since) as unknown as (PersonRow & { last_channel: ChannelId })[];
			return rows.map((row) => ({ person: toPerson(row), channel: row.last_channel }));
		},
		isDenied(channel: ChannelId, externalId: string): boolean {
			return db.prepare('SELECT 1 FROM deny WHERE channel = ? AND external_id = ?').get(channel, externalId) !== undefined;
		},
		/**
		 * Shared by every persona: someone denied by one is never approached by another. At once, too: every persona's
		 * person with that account is denied, so a turn already waiting for them sends nothing.
		 */
		deny(channel: ChannelId, externalId: string, reason: string) {
			db.prepare('INSERT OR IGNORE INTO deny (channel, external_id, reason, at) VALUES (?, ?, ?, ?)').run(channel, externalId, reason, now());
			db.prepare(`UPDATE people SET state = 'denied', updated_at = ? WHERE id IN (SELECT person_id FROM identities WHERE channel = ? AND external_id = ?)`).run(now(), channel, externalId);
		},
		/** Flags someone possibly under 18 for every persona, like the deny-list, keeping the first probability: never cleared by the code. */
		cautionMinor(channel: ChannelId, externalId: string, probability: number) {
			db.prepare("INSERT OR IGNORE INTO kv (persona, key, value) VALUES ('*', ?, ?)").run(minorCautionKey(channel, externalId), String(probability));
		},
		isMinorCautioned(channel: ChannelId, externalId: string): boolean {
			return db.prepare("SELECT 1 FROM kv WHERE persona = '*' AND key = ?").get(minorCautionKey(channel, externalId)) !== undefined;
		},
		get(persona: string, key: string): string | null {
			const row = db.prepare('SELECT value FROM kv WHERE persona = ? AND key = ?').get(persona, key) as unknown as { value: string } | undefined;
			return row?.value ?? null;
		},
		set(persona: string, key: string, value: string | null) {
			if (value === null) db.prepare('DELETE FROM kv WHERE persona = ? AND key = ?').run(persona, key);
			else db.prepare('INSERT INTO kv (persona, key, value) VALUES (?, ?, ?) ON CONFLICT (persona, key) DO UPDATE SET value = excluded.value').run(persona, key, value);
		},
		audit(persona: string, kind: string, detail: Record<string, unknown> = {}) {
			db.prepare('INSERT INTO audit (at, persona, kind, detail) VALUES (?, ?, ?, ?)').run(now(), persona, kind, JSON.stringify(detail));
		},
		auditLog(persona?: string, limit = 50): { at: number; persona: string; kind: string; detail: Record<string, unknown> }[] {
			const rows = (
				persona
					? db.prepare('SELECT at, persona, kind, detail FROM audit WHERE persona = ? ORDER BY id DESC LIMIT ?').all(persona, limit)
					: db.prepare('SELECT at, persona, kind, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
			) as unknown as { at: number; persona: string; kind: string; detail: string }[];
			return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
		},
		/** Deletes messages and audit lines older than `before` (the app sweeps its own tables). */
		sweep(before: number) {
			db.prepare('DELETE FROM messages WHERE at < ?').run(before);
			db.prepare('DELETE FROM audit WHERE at < ?').run(before);
		},
	};
}
