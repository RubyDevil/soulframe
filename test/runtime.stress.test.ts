// A seeded stress test of the reply queue (src/runtime.ts): random people write at random times while the model takes
// random time and sometimes fails, sends sometimes fail, the halt switch flips, and people ask to stop. Whatever the
// interleaving, a few things must always hold, and each is checked against what actually happened:
// - one person at a time: no two turns compose at once, and nobody is sent a reply while another's is being composed;
// - nobody is lost: once things quiet down, every active person's messages have had a turn;
// - nothing is sent twice, nothing is sent that the store does not hold (and the other way round);
// - nothing is sent to someone who ended it, but the code's goodbye;
// - a stopped queue does nothing more and leaves no timer behind.
// A failing seed is reproduced by running it alone: its number is in the test's name.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrain } from '../src/brain.js';
import { ProviderUnavailableError } from '../src/llm.js';
import { seededRng, sleep, type Rng } from '../src/rng.js';
import { createReplyQueue, createRuntime, UnreachableError, type Conversation } from '../src/runtime.js';
import { MINOR_EXIT, STOP_ACK } from '../src/safety.js';
import { MINUTE } from '../src/settings.js';
import { memoryStore, NOTED_DM, personaOf, settingsOf, TEST_IDENTITY, testPersona } from './fixtures.js';

// 20:00 UTC: inside the persona's hours (19:00 to 23:00)
const START = Date.UTC(2026, 9, 14, 20);
const PEOPLE = ['ana', 'bo', 'cy', 'dee'] as const;

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** What happened in one run, and the means to drive it. */
const world = (seed: number, { interruptions = true }: { interruptions?: boolean } = {}) => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	const luck: Rng = seededRng(`stress-luck-${seed}`);
	const persona = personaOf(testPersona(), { prompt: 'A friendly persona.' });
	const settings = settingsOf({
		retries: { attempts: 3, delayMinutes: [1, 1] },
		// Often enough to meet a few in an hour
		pacing: { interruptions: interruptions ? { meanMinutes: 12, minutes: [1, 3] } : { meanMinutes: 0 } },
	});
	const store = memoryStore();
	let halted = false;
	const runtime = { ...createRuntime({ store, dryRun: false, haltFile: 'unused', rng: seededRng(`stress-queue-${seed}`) }), halted: () => halted };
	vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
	const brain = createBrain({ persona, settings, identity: TEST_IDENTITY, runtime, llm: { complete: async () => '{"reply": null}' } });
	const queue = createReplyQueue({ brain, runtime, act: async () => undefined });

	const violations: string[] = [];
	const composing = new Set<number>();
	const composed: number[] = [];
	const sent: { personId: number; text: string; at: number }[] = [];
	let texts = 0;
	vi.spyOn(brain, 'compose').mockImplementation(async (personId) => {
		if (composing.size) violations.push(`person ${personId} composes while ${[...composing]} does`);
		composing.add(personId);
		composed.push(personId);
		try {
			await sleep(500 + luck() * 20_000);
			const roll = luck();
			if (roll < 0.05) throw new ProviderUnavailableError('LLM 503');
			if (roll < 0.1) throw new Error('model said nonsense');
			const count = Math.floor(luck() * 4);
			return { messages: Array.from({ length: count }, () => `reply ${++texts}`), action: 'none', keep: () => undefined };
		} finally {
			composing.delete(personId);
		}
	});

	const conversations = new Map<string, Conversation>();
	const conversationOf = (from: string): Conversation => {
		let conversation = conversations.get(from);
		if (!conversation) {
			conversation = {
				channel: NOTED_DM,
				typing: async () => undefined,
				async send(text) {
					// A send takes a moment, so a message can land while it goes out
					await sleep(luck() * 900);
					const person = store.person(persona.id, NOTED_DM.id, from)!;
					const goodbye = text === STOP_ACK || text === MINOR_EXIT;
					if (!goodbye && person.state !== 'active') violations.push(`"${text}" sent to ${from}, who is ${person.state}`);
					const others = [...composing].filter((id) => id !== person.id);
					if (!goodbye && others.length) violations.push(`"${text}" sent to ${from} while ${others} composes`);
					const roll = luck();
					if (roll < 0.03) throw new Error('network down');
					if (roll < 0.04) throw new UnreachableError('blocked');
					sent.push({ personId: person.id, text, at: Date.now() });
				},
			};
			conversations.set(from, conversation);
		}
		return conversation;
	};
	const write = async (from: string, text: string) => queue.handle(brain.incoming(NOTED_DM, from, from, text), conversationOf(from), text);

	/** A random hour of events, 35 minutes of them: messages, bursts, a halt now and then (unless `halts` is off), someone asking to stop. */
	const play = async (minutes = 35, { halts = true }: { halts?: boolean } = {}) => {
		const events: { at: number; run: () => Promise<void> | void }[] = [];
		for (let i = 0; i < 28; i++) {
			const at = Math.floor(luck() * minutes * MINUTE);
			const from = PEOPLE[Math.floor(luck() * PEOPLE.length)]!;
			const roll = luck();
			if (roll < 0.04) events.push({ at, run: () => void write(from, 'please stop messaging me') });
			else if (roll < 0.1) {
				if (!halts) continue;
				events.push({ at, run: () => void (halted = true) });
				events.push({ at: at + Math.floor(luck() * 4 * MINUTE), run: () => void (halted = false) });
			} else {
				// A burst of one to three messages seconds apart
				for (let k = 0; k <= Math.floor(luck() * 3); k++) events.push({ at: at + k * 1500, run: () => void write(from, `hi ${i}`) });
			}
		}
		for (const event of events.sort((a, b) => a.at - b.at)) {
			await vi.advanceTimersByTimeAsync(Math.max(0, START + event.at - Date.now()));
			await event.run();
		}
		halted = false;
	};
	return { persona, store, queue, runtime, brain, composed, sent, violations, composing, play, write, halt: (on: boolean) => (halted = on) };
};

// Odd seeds run without the queue's 30-second tick (and without halts, which only the tick brings back from the
// backlog): progress then depends on the queue starting the next turn itself, the moment a turn ends or a delay passes
describe.each(Array.from({ length: 40 }, (_, seed) => seed))('the reply queue under random load (seed %i)', (seed) => {
	it('keeps its invariants, and leaves nobody unanswered once things quiet down', async () => {
		const run = world(seed);
		const ticking = seed % 2 === 0;
		if (ticking) run.queue.start();
		try {
			await run.play(35, { halts: ticking });
			// Past every retry (at most 15 minutes of outage backoff), well before the hours end at 23:00
			await vi.advanceTimersByTimeAsync(START + 100 * MINUTE - Date.now());
			expect(run.violations).toEqual([]);
			expect(run.composing.size).toBe(0);
			const people = PEOPLE.flatMap((from) => run.store.person(run.persona.id, NOTED_DM.id, from) ?? []);
			for (const person of people) {
				// Active, and nothing left to answer
				if (person.state === 'active') expect(person.handledAt, `${person.name} is still owed a turn`).toBeGreaterThanOrEqual(person.lastInAt);
				// What was sent is what the store holds, once each
				const recorded = run.sent.filter((s) => s.personId === person.id && s.text !== STOP_ACK).map((s) => s.text);
				const stored = run.store.history(person.id, 500).filter((m) => m.direction === 'out' && m.text !== STOP_ACK).map((m) => m.text);
				expect(stored).toEqual(recorded);
				expect(new Set(recorded).size).toBe(recorded.length);
			}
		} finally {
			run.queue.stop();
		}
	});
});

describe.each(Array.from({ length: 20 }, (_, seed) => seed))('a queue stopped mid-run (seed %i)', (seed) => {
	it('starts and sends nothing more, and leaves no timer behind', async () => {
		const run = world(seed, { interruptions: seed % 2 === 0 });
		run.queue.start();
		const luck = seededRng(`stop-${seed}`);
		try {
			await run.play(20);
			// Somewhere in the middle of whatever is going on
			await vi.advanceTimersByTimeAsync(Math.floor(luck() * 10 * MINUTE));
			run.queue.stop();
			const [composes, sends] = [run.composed.length, run.sent.length];
			// Whatever was in flight finishes within a couple of minutes, and then nothing of the queue's is left to fire
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			expect(vi.getTimerCount()).toBe(0);
			// A long time passes, and people write on
			await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
			await run.write('ana', 'hello?');
			await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
			expect(run.composed.length).toBe(composes);
			expect(run.sent.length).toBe(sends);
			expect(vi.getTimerCount()).toBe(0);
			expect(run.violations).toEqual([]);
		} finally {
			run.queue.stop();
		}
	});
});

describe('the stress test itself', () => {
	it('is not trivial: across its seeds people are written to, composed for, halted and stopped', async () => {
		let sent = 0;
		let composed = 0;
		let ended = 0;
		for (const seed of [0, 1, 2, 3, 4, 5]) {
			const run = world(seed);
			run.queue.start();
			try {
				await run.play();
				await vi.advanceTimersByTimeAsync(START + 100 * MINUTE - Date.now());
				sent += run.sent.length;
				composed += run.composed.length;
				ended += PEOPLE.filter((from) => run.store.person(run.persona.id, NOTED_DM.id, from)?.state !== 'active' && run.store.person(run.persona.id, NOTED_DM.id, from)).length;
			} finally {
				run.queue.stop();
			}
			vi.useRealTimers();
		}
		expect(sent).toBeGreaterThan(30);
		expect(composed).toBeGreaterThan(30);
		expect(ended).toBeGreaterThan(0);
	});
});
