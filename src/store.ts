import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelId } from './channel.js';
import type { MessageMedia } from './perception.js';

// Loaded at run time, not imported: Vite (under the tests) doesn't know node:sqlite yet and fails to resolve it, and
// getBuiltinModule works the same in the ESM and the CJS build (import.meta.url would not exist in CJS)
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

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
	/** How well the persona knows them, 0 to 1: counted by the code from the turns it kept, fading while they are apart (settings.relationship). */
	familiarity: number;
	/** How the persona feels about them, -1 to 1 (0 neutral): a small step per turn, as the model answers (settings.relationship.affinity). */
	affinity: number;
	/** How much their conversation mattered at their last turn, 0 (small talk) to 3 (something big), and when it was rated (ms, 0 never). */
	importance: number;
	importanceAt: number;
}

/**
 * What made the persona plan to text someone first (settings.initiative): `followUp`, a DM turn's own plan; `checkIn`,
 * someone close gone quiet; `share`, its day, as it comes back from a busy block.
 */
export type OpenerKind = 'followUp' | 'checkIn' | 'share';

/**
 * How an opener ended: `sent`; `rehearsed` (a dry run logged it); `declined` (the model chose not to text); `replaced`
 * by a newer plan, or dropped by a DM turn (`dropped` too); `dropped` (they can't be texted any more, or the plan was given up);
 * `expired` before a moment came; `failed` (the model or the send failed).
 */
export type OpenerOutcome = 'sent' | 'rehearsed' | 'declined' | 'replaced' | 'dropped' | 'expired' | 'failed';

/** A first message the persona plans to send someone (settings.initiative): pending until it is closed with its outcome. */
export interface Opener {
	id: number;
	persona: string;
	personId: number;
	kind: OpenerKind;
	/** Why: a follow-up's note in the model's own words, the busy block a share is about; empty for a check-in. Data in the prompt. */
	about: string;
	/** The earliest moment it may go, and the moment it is given up (ms). */
	dueAt: number;
	expiresAt: number;
	createdAt: number;
	/** When it was closed, and how; null while pending. */
	closedAt: number | null;
	outcome: OpenerOutcome | null;
}

interface OpenerRow {
	id: number;
	persona: string;
	person_id: number;
	kind: OpenerKind;
	about: string;
	due_at: number;
	expires_at: number;
	created_at: number;
	closed_at: number | null;
	outcome: OpenerOutcome | null;
}

const toOpener = (row: OpenerRow): Opener => ({
	id: row.id,
	persona: row.persona,
	personId: row.person_id,
	kind: row.kind,
	about: row.about,
	dueAt: row.due_at,
	expiresAt: row.expires_at,
	createdAt: row.created_at,
	closedAt: row.closed_at,
	outcome: row.outcome,
});

export interface StoredMessage {
	id: number;
	channel: ChannelId;
	direction: 'in' | 'out';
	text: string;
	at: number;
	/** The photos and links that came with it, if any. */
	media?: MessageMedia;
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
	familiarity REAL NOT NULL DEFAULT 0,
	affinity REAL NOT NULL DEFAULT 0,
	importance REAL NOT NULL DEFAULT 1,
	importance_at INTEGER NOT NULL DEFAULT 0,
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
	at INTEGER NOT NULL,
	media TEXT
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
CREATE TABLE IF NOT EXISTS openers (
	id INTEGER PRIMARY KEY,
	persona TEXT NOT NULL,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	about TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	closed_at INTEGER,
	outcome TEXT
);
CREATE INDEX IF NOT EXISTS openers_person ON openers (person_id, closed_at);
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
	familiarity: number;
	affinity: number;
	importance: number;
	importance_at: number;
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
	familiarity: row.familiarity,
	affinity: row.affinity,
	importance: row.importance,
	importanceAt: row.importance_at,
});

const COLUMNS: Record<keyof Omit<Person, 'id' | 'persona' | 'ids' | 'firstSeenAt'>, string> = {
	name: 'name',
	state: 'state',
	incoming: 'incoming',
	summary: 'summary',
	conversations: 'conversations',
	lastInAt: 'last_in_at',
	handledAt: 'handled_at',
	familiarity: 'familiarity',
	affinity: 'affinity',
	importance: 'importance',
	importanceAt: 'importance_at',
};

/**
 * Columns added to `people` since the first beta, each added on open to a database made before it. Familiarity starts
 * from their conversations so far (1 - 0.9^n: 2 of them make them at ease, 5 a regular, 12 close, as the conversation
 * counts did), so nobody who was close becomes a stranger.
 */
const ADDED_PEOPLE_COLUMNS: { name: string; definition: string; fill?: string }[] = [
	{ name: 'familiarity', definition: 'REAL NOT NULL DEFAULT 0', fill: 'conversations' },
	{ name: 'affinity', definition: 'REAL NOT NULL DEFAULT 0' },
	{ name: 'importance', definition: 'REAL NOT NULL DEFAULT 1' },
	{ name: 'importance_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

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
	const columns = new Set((db.prepare('PRAGMA table_info(people)').all() as unknown as { name: string }[]).map((column) => column.name));
	const missing = ADDED_PEOPLE_COLUMNS.filter((column) => !columns.has(column.name));
	if (missing.length) {
		inTransaction(db, () => {
			for (const { name, definition, fill } of missing) {
				db.exec(`ALTER TABLE people ADD COLUMN ${name} ${definition}`);
				if (fill !== 'conversations') continue;
				const rows = db.prepare('SELECT id, conversations FROM people').all() as unknown as { id: number; conversations: number }[];
				const update = db.prepare(`UPDATE people SET ${name} = ? WHERE id = ?`);
				for (const row of rows) update.run(1 - 0.9 ** row.conversations, row.id);
			}
		});
	}
	// A database made before messages could carry photos and links
	if (!(db.prepare('PRAGMA table_info(messages)').all() as unknown as { name: string }[]).some((column) => column.name === 'media')) db.exec('ALTER TABLE messages ADD COLUMN media TEXT');

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
		addMessage(personId: number, channel: ChannelId, direction: 'in' | 'out', text: string, at = now(), media?: MessageMedia) {
			db.prepare('INSERT INTO messages (person_id, channel, direction, text, at, media) VALUES (?, ?, ?, ?, ?, ?)').run(personId, channel, direction, text, at, media ? JSON.stringify(media) : null);
			if (direction === 'in') db.prepare('UPDATE people SET incoming = incoming + 1, updated_at = ? WHERE id = ?').run(now(), personId);
		},
		/** What is known of a message's photos and links, once they were looked at. */
		setMedia(messageId: number, media: MessageMedia) {
			db.prepare('UPDATE messages SET media = ? WHERE id = ?').run(JSON.stringify(media), messageId);
		},
		/** The last `limit` messages with the person, oldest first. */
		history(personId: number, limit = 40): StoredMessage[] {
			const rows = db
				.prepare('SELECT id, channel, direction, text, at, media FROM messages WHERE person_id = ? ORDER BY at DESC, id DESC LIMIT ?')
				.all(personId, limit) as unknown as (Omit<StoredMessage, 'media'> & { media: string | null })[];
			return rows.reverse().map(({ media, ...message }) => ({ ...message, ...(media !== null && { media: JSON.parse(media) as MessageMedia }) }));
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
		/** Deletes messages, audit lines and closed openers older than `before` (the app sweeps its own tables). */
		sweep(before: number) {
			db.prepare('DELETE FROM messages WHERE at < ?').run(before);
			db.prepare('DELETE FROM audit WHERE at < ?').run(before);
			db.prepare('DELETE FROM openers WHERE closed_at IS NOT NULL AND closed_at < ?').run(before);
		},
		/** Plans a first message to the person (one pending per person: a pending one is closed as `replaced`). Answers it. */
		planOpener(persona: string, personId: number, plan: { kind: OpenerKind; about: string; dueAt: number; expiresAt: number }): Opener {
			const at = now();
			const id = inTransaction(db, () => {
				db.prepare("UPDATE openers SET closed_at = ?, outcome = 'replaced' WHERE person_id = ? AND closed_at IS NULL").run(at, personId);
				return Number(
					db
						.prepare('INSERT INTO openers (persona, person_id, kind, about, due_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.run(persona, personId, plan.kind, plan.about, plan.dueAt, plan.expiresAt, at).lastInsertRowid,
				);
			});
			return toOpener(db.prepare('SELECT * FROM openers WHERE id = ?').get(id) as unknown as OpenerRow);
		},
		/** The person's pending opener, if any. */
		pendingOpener(personId: number): Opener | undefined {
			const row = db.prepare('SELECT * FROM openers WHERE person_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(personId) as unknown as OpenerRow | undefined;
			return row && toOpener(row);
		},
		/** The persona's pending openers due at `at`, earliest first; those past their expiry are closed as `expired` first. */
		dueOpeners(persona: string, at: number): Opener[] {
			db.prepare("UPDATE openers SET closed_at = ?, outcome = 'expired' WHERE persona = ? AND closed_at IS NULL AND expires_at <= ?").run(at, persona, at);
			const rows = db.prepare('SELECT * FROM openers WHERE persona = ? AND closed_at IS NULL AND due_at <= ? ORDER BY due_at, id').all(persona, at) as unknown as OpenerRow[];
			return rows.map(toOpener);
		},
		/** Closes a pending opener with its outcome (one already closed is left as it was). */
		closeOpener(id: number, outcome: OpenerOutcome) {
			db.prepare('UPDATE openers SET closed_at = ?, outcome = ? WHERE id = ? AND closed_at IS NULL').run(now(), outcome, id);
		},
		/** The openers sent to the person, newest first (`limit`, default 10). */
		sentOpeners(personId: number, limit = 10): Opener[] {
			const rows = db.prepare("SELECT * FROM openers WHERE person_id = ? AND outcome = 'sent' ORDER BY closed_at DESC, id DESC LIMIT ?").all(personId, limit) as unknown as OpenerRow[];
			return rows.map(toOpener);
		},
		/** How many openers the persona sent since `since`. */
		openersSentSince(persona: string, since: number): number {
			return (db.prepare("SELECT COUNT(*) AS n FROM openers WHERE persona = ? AND outcome = 'sent' AND closed_at >= ?").get(persona, since) as unknown as { n: number }).n;
		},
		/** Whether any persona sent an opener since `since` to one of this person's accounts (every persona's person with it). */
		accountOpenedSince(personId: number, since: number): boolean {
			return (
				db
					.prepare(
						`SELECT 1 FROM openers o JOIN identities theirs ON theirs.person_id = o.person_id
						 JOIN identities mine ON mine.channel = theirs.channel AND mine.external_id = theirs.external_id
						 WHERE mine.person_id = ? AND o.outcome = 'sent' AND o.closed_at >= ? LIMIT 1`,
					)
					.get(personId, since) !== undefined
			);
		},
		/**
		 * The persona's people it may check in with or share with: active, who wrote to it before and are owed no turn, and
		 * whose last message either way (`lastAt`) is at `quietSince` or before, closest first.
		 */
		quietPeople(persona: string, quietSince: number): { person: Person; lastAt: number }[] {
			const rows = db
				.prepare(
					`SELECT * FROM (SELECT ${PERSON_COLUMNS}, COALESCE((SELECT MAX(at) FROM messages m WHERE m.person_id = p.id), p.last_in_at) AS last_at FROM people p
					 WHERE p.persona = ? AND p.state = 'active' AND p.incoming > 0 AND p.last_in_at <= p.handled_at)
					 WHERE last_at <= ? ORDER BY familiarity DESC, id`,
				)
				.all(persona, quietSince) as unknown as (PersonRow & { last_at: number })[];
			return rows.map((row) => ({ person: toPerson(row), lastAt: row.last_at }));
		},
		/** When the person first wrote after `after` (ms), or null when they haven't since. */
		firstInAfter(personId: number, after: number): number | null {
			const row = db.prepare("SELECT MIN(at) AS at FROM messages WHERE person_id = ? AND direction = 'in' AND at > ?").get(personId, after) as unknown as { at: number | null };
			return row.at;
		},
		/**
		 * By hand, an operator's: the persona stops answering this person and ignores what they write (`blocked`, audited
		 * with `source: 'manual'`). Only the store: nothing is done on the platform (the app's `act` blocks there). A
		 * reply under way to them is cut. Answers whether it changed anything (false: no such person, or already ended).
		 */
		block(personId: number): boolean {
			const row = db.prepare('SELECT persona, state FROM people WHERE id = ?').get(personId) as unknown as { persona: string; state: PersonState } | undefined;
			if (!row || row.state !== 'active') return false;
			db.prepare("UPDATE people SET state = 'blocked', updated_at = ? WHERE id = ?").run(now(), personId);
			db.prepare('INSERT INTO audit (at, persona, kind, detail) VALUES (?, ?, ?, ?)').run(now(), row.persona, 'blocked', JSON.stringify({ personId, source: 'manual' }));
			return true;
		},
		/**
		 * By hand: a person who asked to stop (`stopped`) or was blocked (`blocked`) is `active` again, audited with
		 * `source: 'manual'`. Someone deny-listed is not: `undeny` lifts that. Answers whether it changed anything.
		 */
		unblock(personId: number): boolean {
			const row = db.prepare('SELECT persona, state FROM people WHERE id = ?').get(personId) as unknown as { persona: string; state: PersonState } | undefined;
			if (!row || (row.state !== 'stopped' && row.state !== 'blocked')) return false;
			db.prepare("UPDATE people SET state = 'active', updated_at = ? WHERE id = ?").run(now(), personId);
			db.prepare('INSERT INTO audit (at, persona, kind, detail) VALUES (?, ?, ?, ?)').run(now(), row.persona, 'unblocked', JSON.stringify({ personId, from: row.state, source: 'manual' }));
			return true;
		},
		/**
		 * By hand: takes an account off the deny list, shared by every persona. Each person with that account who was
		 * `denied` is `active` again unless another of their accounts is still on the list. Audited for each persona with
		 * `source: 'manual'`. Answers whether the account was on the list.
		 */
		undeny(channel: ChannelId, externalId: string): boolean {
			return inTransaction(db, () => {
				if (db.prepare('DELETE FROM deny WHERE channel = ? AND external_id = ?').run(channel, externalId).changes === 0) return false;
				const people = db
					.prepare(`SELECT p.id, p.persona FROM people p JOIN identities i ON i.person_id = p.id WHERE i.channel = ? AND i.external_id = ? AND p.state = 'denied'`)
					.all(channel, externalId) as unknown as { id: number; persona: string }[];
				for (const { id, persona } of people) {
					const stillDenied = db
						.prepare('SELECT 1 FROM identities i JOIN deny d ON d.channel = i.channel AND d.external_id = i.external_id WHERE i.person_id = ?')
						.get(id);
					if (stillDenied) continue;
					db.prepare("UPDATE people SET state = 'active', updated_at = ? WHERE id = ?").run(now(), id);
					db.prepare('INSERT INTO audit (at, persona, kind, detail) VALUES (?, ?, ?, ?)').run(now(), persona, 'undenied', JSON.stringify({ personId: id, platform: channel, source: 'manual' }));
				}
				return true;
			});
		},
		/** By hand: takes the minor-caution flag off an account (the flag is otherwise never cleared by the code). Answers whether it was set. */
		clearMinorCaution(channel: ChannelId, externalId: string): boolean {
			return db.prepare("DELETE FROM kv WHERE persona = '*' AND key = ?").run(minorCautionKey(channel, externalId)).changes > 0;
		},
		/**
		 * Forgets one person: their messages, notes, familiarity and affinity, accounts, the relationship levels shown to
		 * them and the audit lines about them. The deny list and minor flags (keyed by account, shared by every persona) are
		 * kept, so a forgotten account that was deny-listed stays so. Someone who asked to stop, was blocked or denied
		 * (`state` not `active`) is kept too, since forgetting them would let the persona answer them again, unless
		 * `includeEnded`. Answers whether anyone was forgotten (false: no such person, or they were kept).
		 */
		forgetPerson(personId: number, { includeEnded = false }: { includeEnded?: boolean } = {}): boolean {
			const row = db.prepare('SELECT persona, state FROM people WHERE id = ?').get(personId) as unknown as { persona: string; state: PersonState } | undefined;
			if (!row || (row.state !== 'active' && !includeEnded)) return false;
			inTransaction(db, () => {
				db.prepare('DELETE FROM messages WHERE person_id = ?').run(personId);
				db.prepare('DELETE FROM identities WHERE person_id = ?').run(personId);
				db.prepare('DELETE FROM kv WHERE persona = ? AND key = ?').run(row.persona, `relationship:${personId}`);
				db.prepare("DELETE FROM audit WHERE persona = ? AND json_extract(detail, '$.personId') = ?").run(row.persona, personId);
				db.prepare('DELETE FROM people WHERE id = ?').run(personId);
			});
			return true;
		},
		/**
		 * Forgets everything one persona knows: all its people (as `forgetPerson`, so those who asked to stop, were blocked
		 * or denied are kept unless `includeEnded`), with their messages, and its own kv (self notes, when it was last
		 * online, the levels shown) and audit lines. Another persona's data, the deny list and the minor flags are untouched.
		 * Answers how many people and messages were deleted. A persona with ended people kept keeps their audit lines too.
		 */
		resetPersona(persona: string, { includeEnded = false }: { includeEnded?: boolean } = {}): { people: number; messages: number } {
			return inTransaction(db, () => {
				const ids = (db.prepare(`SELECT id FROM people WHERE persona = ?${includeEnded ? '' : " AND state = 'active'"}`).all(persona) as unknown as { id: number }[]).map((p) => p.id);
				const kept = (db.prepare("SELECT COUNT(*) AS n FROM people WHERE persona = ? AND state != 'active'").get(persona) as unknown as { n: number }).n;
				let messages = 0;
				for (const id of ids) {
					messages += Number(db.prepare('DELETE FROM messages WHERE person_id = ?').run(id).changes);
					db.prepare('DELETE FROM identities WHERE person_id = ?').run(id);
					db.prepare('DELETE FROM people WHERE id = ?').run(id);
				}
				db.prepare('DELETE FROM kv WHERE persona = ?').run(persona);
				if (includeEnded || kept === 0) db.prepare('DELETE FROM audit WHERE persona = ?').run(persona);
				else {
					// Those about people kept stay; so do none about anyone forgotten
					const keep = (db.prepare("SELECT id FROM people WHERE persona = ? AND state != 'active'").all(persona) as unknown as { id: number }[]).map((p) => p.id);
					db.prepare(`DELETE FROM audit WHERE persona = ? AND (json_extract(detail, '$.personId') IS NULL OR json_extract(detail, '$.personId') NOT IN (${keep.map(() => '?').join(', ')}))`).run(persona, ...keep);
				}
				return { people: ids.length, messages };
			});
		},
	};
}
