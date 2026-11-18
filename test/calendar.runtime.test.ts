/**
 * The calendar through the reply queue: a plan, and what it owes someone, change only with a reply that reached them.
 */

import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { createStepClock } from '../src/clock.js';
import type { LlmMessage } from '../src/llm.js';
import { createReplyQueue, UnreachableError, type Conversation } from '../src/runtime.js';
import { DAY, HOUR } from '../src/settings.js';
import { calledOffKey, type Store } from '../src/store.js';
import { everyDay, memoryStore, personaOf, PLAIN_DM, settingsOf, TEST_IDENTITY } from './fixtures.js';

const persona = personaOf({ id: 'robin', name: 'Robin', timezone: 'America/Toronto', schedule: everyDay(['18:00', '20:00'], ['00:30', '02:00']) }, { prompt: 'You are playful and warm.' });
// Wednesday 9 PM in Toronto; Saturday is 3 days ahead
const NOW = Date.UTC(2026, 9, 15, 1);
const SATURDAY = { year: 2026, month: 10, day: 17 };
const FAST = { readingDurationSeconds: [1, 1], typingDurationSeconds: [5, 5], burst: { settleSeconds: [0, 0] }, glance: { delaySeconds: [1, 1] }, interruptions: { meanMinutes: 0 } };
const CINEMA = { reply: 'yes!! cinema it is', plan: { day: 3, from: '19:00', to: '21:00', busy: 'at the cinema', public: 'at the cinema', share: 'open' } };
const SORRY = { reply: "sam, so sorry, i can't make jo's party" };

/** Someone Robin has known a while, at these levels, who last wrote an hour before `at`. */
const known = (store: Store, account: string, name: string, familiarity: number, affinity: number, at = NOW) => {
	const person = store.createPerson('robin', 'chat', account, name);
	return store.updatePerson(person.id, { familiarity, affinity, conversations: 6, incoming: 12, lastInAt: at - HOUR, handledAt: at - HOUR });
};

/** Robin's reply queue on a step clock, its model answering a DM turn with `dm` and an opener with `opener`. */
function setUp({ dm, opener = SORRY, dryRun = false }: { dm: unknown; opener?: unknown; dryRun?: boolean }) {
	const clock = createStepClock({ now: () => NOW });
	const store = memoryStore(clock.now);
	const runtime = { now: clock.now, rng: () => 0.5, store, dryRun, halted: () => false, log: () => undefined, timers: clock.timers };
	const settings = settingsOf({ calendar: { enabled: true }, initiative: { enabled: true }, pacing: FAST });
	const llm = { complete: async (_messages: LlmMessage[], { task }: { task: string }) => JSON.stringify(task === 'directMessage' ? dm : opener) };
	const brain = createBrain({ persona, settings, identity: TEST_IDENTITY, runtime, llm });
	const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
	const sent: { to: string; text: string }[] = [];
	const conv = (to: string, extra: Partial<Conversation> = {}): Conversation => ({ channel: PLAIN_DM, typing: async () => undefined, send: async (text) => void sent.push({ to, text }), ...extra });
	const say = (account: string, name: string, text: string, conversation = conv(account)) => queue.handle(brain.incoming(PLAIN_DM, account, name, text), conversation, text);
	queue.allowInitiative('chat', async (person) => conv(person.name.toLowerCase()));
	return { clock, store, brain, queue, sent, conv, say };
}

/** Sam, promised Jo's party on Saturday, and Kim, closer, who asks for the cinema then. */
const samAndKim = (store: Store) => {
	const sam = known(store, 'sam', 'Sam', 0.25, 0.2);
	const kim = known(store, 'kim', 'Kim', 0.85, 0.7);
	const party = store.addEvent('robin', { kind: 'busy', day: SATURDAY, from: 18 * 60, to: 22 * 60, what: "at Jo's party", personId: sam.id, source: 'persona', withThem: true });
	return { sam, kim, party };
};

describe('its calendar through the reply queue', () => {
	it.each(['stop', 'unreachable'] as const)('makes no plan of a reply that never reached them, nor breaks a promise for it (%s)', async (mode) => {
		const { clock, store, brain, queue, conv, say } = setUp({ dm: CINEMA });
		const { sam, party } = samAndKim(store);
		let stopped = false;
		const kimConv = conv('kim', {
			// Kim says stop while the yes is being typed; or has blocked it on the platform
			async typing(on) {
				if (on && !stopped && mode === 'stop') {
					stopped = true;
					void queue.handle(brain.incoming(PLAIN_DM, 'kim', 'Kim', 'stop'), kimConv, 'stop');
				}
			},
			...(mode === 'unreachable' && {
				send: async () => {
					throw new UnreachableError('blocked');
				},
			}),
		});
		queue.start();
		await say('kim', 'Kim', 'cinema saturday 7?', kimConv);
		await clock.run({ until: NOW + 3 * HOUR });
		queue.stop();
		expect(store.eventById(party.id)?.cancelledAt).toBeNull();
		expect(store.events('robin', SATURDAY, SATURDAY)).toEqual([expect.objectContaining({ id: party.id })]);
		expect(store.pendingOpener(sam.id)).toBeUndefined();
		expect(store.get('robin', calledOffKey(sam.id))).toBeNull();
	});

	it('makes no plan of a reply cut short after its first message: what promised it never reached them', async () => {
		const { clock, store, queue, sent, conv, say } = setUp({ dm: { ...CINEMA, reply: 'omg hi!!\nyes cinema saturday at 7, promise' } });
		const { sam, party } = samAndKim(store);
		let sends = 0;
		const kimConv = conv('kim', {
			send: async (text) => {
				if (++sends > 1) throw new UnreachableError('blocked');
				sent.push({ to: 'kim', text });
			},
		});
		queue.start();
		await say('kim', 'Kim', 'cinema saturday 7?', kimConv);
		await clock.run({ until: NOW + 3 * HOUR });
		queue.stop();
		expect(sent).toEqual([{ to: 'kim', text: 'omg hi!!' }]);
		expect(store.eventById(party.id)?.cancelledAt).toBeNull();
		expect(store.events('robin', SATURDAY, SATURDAY)).toEqual([expect.objectContaining({ id: party.id })]);
		expect(store.get('robin', calledOffKey(sam.id))).toBeNull();
	});

	it('makes the plan of a reply that all went out, even when taking typing down fails after it', async () => {
		const { clock, store, queue, sent, conv, say } = setUp({ dm: CINEMA });
		const { kim, party } = samAndKim(store);
		const kimConv = conv('kim', {
			typing: async (on) => {
				if (!on) throw new Error('typing rate-limited');
			},
		});
		queue.start();
		await say('kim', 'Kim', 'cinema saturday 7?', kimConv);
		await clock.run({ until: NOW + HOUR });
		queue.stop();
		expect(sent[0]).toEqual({ to: 'kim', text: CINEMA.reply });
		expect(store.eventById(party.id)).toMatchObject({ cancelledBy: kim.id });
		expect(store.events('robin', SATURDAY, SATURDAY)).toEqual([expect.objectContaining({ what: 'at the cinema', personId: kim.id })]);
	});

	it('keeps what it owes someone when its reply to them never went out, and lets the apology tell them', async () => {
		const { clock, store, queue, sent, conv, say } = setUp({ dm: { reply: "hey! so sorry, i can't make jo's party saturday" } });
		const sam = known(store, 'sam', 'Sam', 0.25, 0.2, NOW - 2 * HOUR);
		const party = store.addEvent('robin', { kind: 'busy', day: SATURDAY, from: 18 * 60, to: 22 * 60, what: "at Jo's party", personId: sam.id, source: 'persona', withThem: true });
		store.cancelEvent(party.id, 99);
		store.set('robin', calledOffKey(sam.id), JSON.stringify([{ id: party.id, start: NOW + 3 * DAY, end: NOW + 3 * DAY + 4 * HOUR, kind: 'busy', what: "at Jo's party" }]));
		store.planOpener('robin', sam.id, { kind: 'apology', about: "Saturday: at Jo's party", dueAt: NOW, expiresAt: NOW + 4 * DAY });
		// The read receipt fails: the turn ends with nothing sent
		const samConv = conv('sam', {
			markRead: async () => {
				throw new Error('read receipt API 500');
			},
		});
		queue.start();
		await say('sam', 'Sam', 'hey, still on for saturday?', samConv);
		await clock.run({ until: NOW + 6 * HOUR });
		queue.stop();
		// Told by the apology, which did go out
		expect(sent).toEqual([{ to: 'sam', text: SORRY.reply }]);
		expect(store.auditLog('robin').some((row) => row.kind === 'opener_sent' && row.detail.kind === 'apology')).toBe(true);
		expect(store.get('robin', calledOffKey(sam.id))).toBeNull();
	});

	it('changes nothing its calendar keeps in a dry run', async () => {
		const { clock, store, queue, say } = setUp({ dm: CINEMA, dryRun: true });
		const { sam, party } = samAndKim(store);
		queue.start();
		await say('kim', 'Kim', 'cinema saturday 7?');
		await clock.run({ until: NOW + 6 * HOUR });
		queue.stop();
		expect(store.eventById(party.id)?.cancelledAt).toBeNull();
		expect(store.events('robin', SATURDAY, SATURDAY)).toEqual([expect.objectContaining({ id: party.id })]);
		expect(store.get('robin', calledOffKey(sam.id))).toBeNull();
		expect(store.pendingOpener(sam.id)).toBeUndefined();
	});

	it('makes the plan of a reply that went out, and breaks the promise for it', async () => {
		const { clock, store, queue, sent, say } = setUp({ dm: CINEMA });
		const { sam, kim, party } = samAndKim(store);
		queue.start();
		await say('kim', 'Kim', 'cinema saturday 7?');
		await clock.run({ until: NOW + HOUR });
		queue.stop();
		expect(store.eventById(party.id)).toMatchObject({ cancelledBy: kim.id });
		// Sam told by an apology, as soon as the persona was free
		expect(sent).toEqual([
			{ to: 'kim', text: CINEMA.reply },
			{ to: 'sam', text: SORRY.reply },
		]);
		expect(store.get('robin', calledOffKey(sam.id))).toBeNull();
	});
});
