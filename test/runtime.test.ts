import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrain, type Brain, type Turn } from '../src/brain.js';
import type { Channel, ChannelId } from '../src/channel.js';
import { ScheduleSchema } from '../src/config/hours.js';
import type { Persona } from '../src/config/personas.js';
import { createScriptedDecisions, type Decisions } from '../src/decisions.js';
import { LlmBudgetError, ModelNotConfiguredError, ProviderUnavailableError } from '../src/llm.js';
import { STOP_QUESTION } from '../src/prompts.js';
import { interruptionsOn } from '../src/pacing.js';
import { seededRng, sleep, type Rng } from '../src/rng.js';
import type { IncomingMessage } from '../src/perception.js';
import { createReplyQueue, createRuntime, UnreachableError, watchSpans, type Conversation } from '../src/runtime.js';
import { MINOR_EXIT, STOP_ACK } from '../src/safety.js';
import { DEFAULT_SETTINGS, MINUTE, parseSettings, type Settings } from '../src/settings.js';
import type { Person, Store } from '../src/store.js';
import { memoryStore, NOTED_DM, PLAIN_DM, personaOf, settingsOf, SNOOZE, TEST_IDENTITY, testPersona } from './fixtures.js';

// 23:00 in Toronto: inside every night of the hours below
const OPEN = Date.UTC(2026, 9, 15, 3);

/** A persona's config, online every evening in Toronto. */
const configOf = (id: string) => ({ id, name: id, timezone: 'America/Toronto', schedule: { days: { 'mon-sun': { online: [{ start: ['18:00', '20:00'], end: ['00:30', '02:00'] }] } } } });

const config = {
	personas: [personaOf(configOf('robin')), personaOf(configOf('sky'))],
	/** The settings each one's brain runs with: robin's of its own, sky's the app's. */
	settings: {
		robin: settingsOf({ retries: { attempts: 1 }, pacing: { glance: { delaySeconds: [1, 1] } } }),
		sky: settingsOf({ retries: { attempts: 3 } }),
	} as Record<string, Settings>,
};

const setUp = () => {
	const store = memoryStore(() => OPEN);
	const runtime = createRuntime({ store, dryRun: false, haltFile: join(tmpdir(), 'soulframe-no-such-halt-file'), rng: () => 0, now: () => OPEN });
	return { store, runtime };
};

/** The same plan every day, for hours a `window:` can't give (breaks, `on`). */
const everyDay = (plan: Record<string, unknown>) => ScheduleSchema.parse({ days: { 'mon-sun': plan } });

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('console log formatting', () => {
	it('prints a readable header and indented fields without escaping message text', () => {
		const { runtime, store } = setUp();
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		runtime.log('robin', 'post_sent', { channel: 'general', text: 'First line\r\nSecond line', dryRun: false, detail: { count: 2 } });
		expect(log).toHaveBeenCalledWith([
			'[2026-10-15T03:00:00.000Z] robin | post sent',
			'  channel: general',
			'  text: First line',
			'    Second line',
			'  dryRun: false',
			'  detail: { count: 2 }',
		].join('\n'));
	});

	it('prints events without details on one line', () => {
		const { runtime, store } = setUp();
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		runtime.log('robin', 'chat_started');
		expect(log).toHaveBeenCalledWith('[2026-10-15T03:00:00.000Z] robin | chat started');
	});
});


describe('reply scheduling', () => {
	it.each([1234.4, 1234.6])('uses whole milliseconds for both the timer and log when given %s ms', (delay) => {
		vi.useFakeTimers();
		const { runtime, store } = setUp();
		const persona = config.personas[0]!;
		const brain = createBrain({ persona, settings: config.settings.robin!, identity: TEST_IDENTITY, runtime, llm: { complete: async () => 'hello' } });
		const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
		const log = vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
		const timer = vi.spyOn(globalThis, 'setTimeout');
		try {
			queue.schedule(1, { channel: NOTED_DM, typing: async () => undefined, send: async () => undefined }, delay);
			expect(timer).toHaveBeenCalledWith(expect.any(Function), Math.round(delay));
			expect(log).toHaveBeenCalledWith(persona.id, 'reply_scheduled', expect.objectContaining({
				delayMs: Math.round(delay),
				dueAt: new Date(OPEN + Math.round(delay)).toISOString(),
			}));
		} finally {
			queue.stop();
		}
	});
});

describe('DM lifecycle logs', () => {
	it.each([
		{ acceptInvite: true, dryRun: false, action: 'none', joins: true },
		{ acceptInvite: false, dryRun: false, action: 'none', joins: false },
		{ acceptInvite: undefined, dryRun: false, action: 'none', joins: false },
		{ acceptInvite: true, dryRun: true, action: 'none', joins: false },
		{ acceptInvite: true, dryRun: false, action: 'block', joins: false },
		{ acceptInvite: true, dryRun: false, action: SNOOZE.name, joins: false },
		// On a short break it never joins a group chat
		{ onBreak: true, acceptInvite: true, dryRun: false, action: 'none', joins: false },
	])('joins only on permitted acceptance: %j', async ({ onBreak, acceptInvite, dryRun, action, joins }) => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 9, 14, 20));
		const persona = onBreak ? { ...utc.personas[0]!, schedule: everyDay({ breaks: [{ start: ['19:55', '19:55'], minutes: [10, 10] }] }) } : utc.personas[0]!;
		const store = memoryStore();
		const runtime = createRuntime({ store, dryRun, haltFile: 'unused', rng: () => 0 });
		vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
		const brain = createBrain({ settings: DEFAULT_SETTINGS, persona, identity: TEST_IDENTITY, runtime, llm: { complete: async () => JSON.stringify({ reply: acceptInvite ? 'joining' : 'not now', acceptInvite, action }) } });
		const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
		const join = vi.fn(async () => undefined);
		const conversation = { channel: NOTED_DM, typing: vi.fn(async () => undefined), send: vi.fn(async () => undefined) };
		try {
			await queue.handle(brain.incoming(NOTED_DM, 'user-1', 'Sam', '[group invitation]'), {
				...conversation, invitation: { name: 'Weekend trip', join },
			}, '[group invitation]');
			await queue.handle(brain.incoming(NOTED_DM, 'user-1', 'Sam', 'come hang out'), conversation, 'come hang out');
			expect(join).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(join).toHaveBeenCalledTimes(joins ? 1 : 0);
			if (dryRun) expect(conversation.send).not.toHaveBeenCalled();
			else expect(conversation.send).toHaveBeenCalledWith(acceptInvite ? 'joining' : 'not now');
			if (joins) expect(conversation.send.mock.invocationCallOrder[0]).toBeLessThan(join.mock.invocationCallOrder[0]!);
		} finally {
			queue.stop();
		}
	});

	it('keeps an invitation answered on a short break for its full online time', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 9, 14, 20));
		// A break 19:55 to 20:05, then online from 21:00
		const persona = { ...utc.personas[0]!, schedule: everyDay({ breaks: [{ start: ['19:55', '19:55'], minutes: [10, 10] }], online: [{ start: ['21:00', '21:00'], end: ['23:00', '23:00'] }] }) };
		const store = memoryStore();
		const runtime = createRuntime({ store, dryRun: false, haltFile: 'unused', rng: () => 0 });
		vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
		const brain = createBrain({ settings: DEFAULT_SETTINGS, persona, identity: TEST_IDENTITY, runtime, llm: { complete: async () => JSON.stringify({ reply: 'sure', acceptInvite: true }) } });
		const compose = vi.spyOn(brain, 'compose');
		const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
		const join = vi.fn(async () => undefined);
		// The lines the app adds to each turn there go to compose with the invitation
		const extraLines = () => ['An app line.'];
		const conversation = { channel: NOTED_DM, typing: async () => undefined, send: async () => undefined, extraLines };
		const message = (text: string, invitation?: { name: string; join: () => Promise<void> }) =>
			queue.handle(brain.incoming(NOTED_DM, 'user-1', 'Sam', text), { ...conversation, ...(invitation && { invitation }) }, text);
		try {
			await message('[group invitation]', { name: 'Weekend trip', join });
			await vi.advanceTimersByTimeAsync(20_000);
			expect(compose).toHaveBeenLastCalledWith(1, NOTED_DM, { invitation: 'Weekend trip', extraLines });
			expect(join).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(Date.UTC(2026, 9, 14, 21, 5) - Date.now());
			await message('you coming?');
			await vi.advanceTimersByTimeAsync(20_000);
			expect(compose).toHaveBeenLastCalledWith(1, NOTED_DM, { invitation: 'Weekend trip', extraLines });
			expect(join).toHaveBeenCalledTimes(1);
		} finally {
			queue.stop();
		}
	});

	it.each([true, false])('logs incoming text and outgoing reply text (reply=%s)', async (replies) => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 9, 14, 20));
		const persona = utc.personas[0]!;
		const store = memoryStore();
		const runtime = createRuntime({ store, dryRun: false, haltFile: 'unused', rng: () => 0 });
		const log = vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
		const brain = createBrain({ settings: DEFAULT_SETTINGS, persona, identity: TEST_IDENTITY, runtime, llm: { complete: async () => JSON.stringify({ reply: replies ? 'private reply' : null }) } });
		const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
		const conversation = { channel: NOTED_DM, typing: vi.fn(async () => undefined), send: vi.fn(async () => undefined) };
		try {
			const decision = brain.incoming(NOTED_DM, 'user-1', 'Sam', 'private incoming message');
			await queue.handle(decision, conversation, 'private incoming message');
			expect(log).toHaveBeenCalledWith('test', 'dm_received', { platform: 'forum', text: 'private incoming message', decision: 'reply', personId: 1 });
			await queue.handle(decision, conversation, 'another incoming message');
			expect(log).toHaveBeenCalledWith('test', 'reply_batched', { personId: 1, platform: 'forum' });
			await vi.advanceTimersByTimeAsync(20_000);
			expect(log).toHaveBeenCalledWith('test', 'reply_processing', { personId: 1, platform: 'forum' });
			if (replies) {
				expect(conversation.send).toHaveBeenCalledWith('private reply');
				expect(log).toHaveBeenCalledWith('test', 'dm_sent', { personId: 1, platform: 'forum', text: 'private reply' });
				expect(log).toHaveBeenCalledWith('test', 'reply_sent', { personId: 1, platform: 'forum', messages: 1, dryRun: false });
			} else {
				expect(conversation.send).not.toHaveBeenCalled();
				expect(log).toHaveBeenCalledWith('test', 'reply_skipped', { personId: 1, platform: 'forum', reason: 'no_reply' });
			}
			expect(log).toHaveBeenCalledWith('test', 'dm_received', { platform: 'forum', text: 'another incoming message', decision: 'reply', personId: 1 });
			log.mockClear();
			await queue.handle({ kind: 'ignore', reason: 'stopped' }, conversation, 'ignored message');
			expect(log).toHaveBeenCalledWith('test', 'dm_received', { platform: 'forum', text: 'ignored message', decision: 'ignore', reason: 'stopped' });
		} finally {
			queue.stop();
		}
	});
});

const utc = { personas: [personaOf(testPersona(), { prompt: 'A friendly persona.' })] };
/** That day (Oct 14) at a UTC time; its hours are 19:00 to 23:00. */
const at = (hours: number, minutes = 0, seconds = 0) => Date.UTC(2026, 9, 14, hours, minutes, seconds);
// 20:00, inside its hours
const EVENING = at(20);
/** Its hours plus a 10-minute break at 12:30, on `breakOn` only when given. */
const withBreak = (breakOn?: ChannelId[]): Persona => ({
	...utc.personas[0]!,
	schedule: everyDay({
		breaks: [{ start: ['12:30', '12:30'], minutes: [10, 10], ...(breakOn && { on: breakOn }) }],
		online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }],
	}),
});

/**
 * A queue at `now` (in open hours unless given) with a real brain and store (a new one unless given); `message` hands
 * it what someone wrote, as a persona does, and `halt` flips the halt switch.
 */
const start = ({ decisions, now = EVENING, persona = utc.personas[0]!, settings = DEFAULT_SETTINGS, rng = () => 0, dryRun = false, store = memoryStore() }: { decisions?: Decisions; now?: number; persona?: Persona; settings?: Settings; rng?: Rng; dryRun?: boolean; store?: Store } = {}) => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	let halted = false;
	const runtime = { ...createRuntime({ store, dryRun, haltFile: 'unused', rng }), halted: () => halted };
	const log = vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
	const brain = createBrain({ persona, settings, identity: TEST_IDENTITY, runtime, decisions, llm: { complete: async () => JSON.stringify({ reply: 'hey you' }) } });
	const act = vi.fn(async (_personId: number, _action: string) => undefined);
	const queue = createReplyQueue({ brain, runtime, act });
	queue.start();
	const conversation = { channel: NOTED_DM, typing: vi.fn(async (_on: boolean) => undefined), send: vi.fn(async (_text: string) => undefined) };
	const message = (text: string, from = 'user-1', channel: Channel = NOTED_DM) => queue.handle(brain.incoming(channel, from, 'Sam', text), { ...conversation, channel }, text);
	const halt = (on: boolean) => (halted = on);
	const close = () => {
		queue.stop();
	};
	return { store, log, brain, queue, act, conversation, message, halt, close };
};

/** A promise and its settling, for a call held while the test acts. */
const held = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

/** The details of every `event` logged, in order. */
const logged = (log: ReturnType<typeof start>['log'], event: string) => log.mock.calls.filter(([, name]) => name === event).map(([, , detail]) => detail ?? {});
/** The details of every `kind` audited, oldest first. */
const audited = (store: Store, kind: string) => store.auditLog('test').filter((row) => row.kind === kind).map((row) => row.detail).reverse();
/** What the history holds as sent to them. */
const sentTo = (store: Store, personId = 1) => store.history(personId).filter((m) => m.direction === 'out').map((m) => m.text);

describe('replies after the person ends it', () => {
	it('drops the rest of a reply when they say stop while it types, and still says goodbye', async () => {
		const { store, log, brain, conversation, message, close } = start();
		vi.spyOn(brain, 'compose').mockResolvedValue({ messages: ['one', 'two'], action: 'none' });
		let stopped = false;
		conversation.typing.mockImplementation(async (on) => {
			if (on && !stopped) {
				stopped = true;
				void message('please stop messaging me');
			}
		});
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(60_000);
			expect(conversation.send.mock.calls).toEqual([[STOP_ACK]]);
			expect(conversation.typing.mock.calls.at(-1)).toEqual([false]);
			expect(log).toHaveBeenCalledWith('test', 'reply_cancelled', { personId: 1, platform: 'forum', sent: 0, unsent: 2, reason: 'ended' });
			expect(sentTo(store)).toEqual([STOP_ACK]);
		} finally {
			close();
		}
	});

	it("sends the goodbye the brain's own check chose, though they are no longer active", async () => {
		const { store, conversation, message, close } = start({ decisions: createScriptedDecisions((question) => (question.name === STOP_QUESTION ? 0.95 : 0)) });
		try {
			await message('ok whatever');
			await vi.advanceTimersByTimeAsync(60_000);
			expect(store.personById(1).state).toBe('stopped');
			expect(conversation.send.mock.calls).toEqual([[STOP_ACK]]);
			expect(sentTo(store)).toEqual([STOP_ACK]);
		} finally {
			close();
		}
	});

	it('records the goodbye to a stop request only once it is sent', async () => {
		const { store, conversation, message, close } = start();
		let recordedAtSend: string[] | null = null;
		conversation.send.mockImplementation(async () => void (recordedAtSend = sentTo(store)));
		try {
			const handled = message('please stop messaging me');
			expect(sentTo(store)).toEqual([]);
			await vi.advanceTimersByTimeAsync(MINUTE);
			await handled;
			expect(conversation.send.mock.calls).toEqual([[STOP_ACK]]);
			expect(recordedAtSend).toEqual([]);
			expect(sentTo(store)).toEqual([STOP_ACK]);
		} finally {
			close();
		}
	});

	it('drops a goodbye cut by HALT: they are stopped already', async () => {
		const { store, log, conversation, message, halt, close } = start();
		try {
			halt(true);
			const handled = message('please stop messaging me');
			await vi.advanceTimersByTimeAsync(MINUTE);
			await handled;
			halt(false);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(conversation.send).not.toHaveBeenCalled();
			expect(logged(log, 'reply_cancelled')).toEqual([{ personId: 1, platform: 'forum', sent: 0, unsent: 1, reason: 'halt_switch' }]);
			expect(store.personById(1).state).toBe('stopped');
			expect(sentTo(store)).toEqual([]);
		} finally {
			close();
		}
	});

	it.each([
		{ text: 'hi', handledAt: EVENING },
		// A goodbye: they are stopped, and nothing is owed
		{ text: 'please stop messaging me', handledAt: 0 },
	])('turns typing off, logs it and drops the turn when sending fails, never trying again ($text)', async ({ text, handledAt }) => {
		const { store, log, conversation, message, close } = start();
		conversation.send.mockRejectedValue(new Error('network down'));
		try {
			const handled = message(text);
			await vi.advanceTimersByTimeAsync(60_000);
			await handled;
			expect(conversation.send).toHaveBeenCalledTimes(1);
			expect(conversation.typing.mock.calls.at(-1)).toEqual([false]);
			expect(logged(log, 'delivery_failed')).toEqual([{ personId: 1, platform: 'forum', sent: 0, error: 'Error: network down' }]);
			expect(store.personById(1)).toMatchObject({ lastInAt: EVENING, handledAt });
			expect(store.unanswered('test', 0)).toEqual([]);
			expect(sentTo(store)).toEqual([]);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(conversation.send).toHaveBeenCalledTimes(1);
		} finally {
			close();
		}
	});

	it('records only the messages that went out when a later send fails', async () => {
		const { store, log, brain, conversation, message, close } = start();
		vi.spyOn(brain, 'compose').mockResolvedValue({ messages: ['one', 'two'], action: 'none' });
		conversation.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timed out'));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			expect(conversation.send.mock.calls).toEqual([['one'], ['two']]);
			expect(sentTo(store)).toEqual(['one']);
			expect(logged(log, 'delivery_failed')).toEqual([{ personId: 1, platform: 'forum', sent: 1, error: 'Error: timed out' }]);
			expect(store.personById(1).handledAt).toBe(EVENING);
			expect(audited(store, 'sent')).toEqual([]);
		} finally {
			close();
		}
	});

	it('stops for good someone it can no longer message there, without trying again', async () => {
		const { store, log, conversation, message, close } = start();
		conversation.send.mockRejectedValue(new UnreachableError('blocked'));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(conversation.send).toHaveBeenCalledTimes(1);
			expect(store.personById(1).state).toBe('stopped');
			expect(logged(log, 'unreachable')).toEqual([{ personId: 1, platform: 'forum', code: 'blocked' }]);
			expect(logged(log, 'delivery_failed')).toEqual([]);
			expect(audited(store, 'sent')).toEqual([]);
			expect(sentTo(store)).toEqual([]);
		} finally {
			close();
		}
	});

	it('keeps someone under 18 denied, and someone it blocked blocked, when the goodbye cannot be delivered', async () => {
		const { store, brain, conversation, message, close } = start();
		conversation.send.mockRejectedValue(new UnreachableError('friends_only'));
		vi.spyOn(brain, 'compose').mockImplementationOnce(async (personId) => {
			// As compose does for a block
			store.updatePerson(personId, { state: 'blocked' });
			return { messages: ['bye'], action: 'block' };
		});
		try {
			const handled = message('im 15 btw');
			await vi.advanceTimersByTimeAsync(MINUTE);
			await handled;
			expect(conversation.send.mock.calls).toEqual([[MINOR_EXIT]]);
			expect(store.personById(1).state).toBe('denied');
			await message('hey', 'user-2');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(store.personById(2).state).toBe('blocked');
		} finally {
			close();
		}
	});
});

describe('a stopped queue (a start that failed, then its retry)', () => {
	it('sends nothing more for a turn under way, which stays owed and is answered once by the next start', async () => {
		const first = start();
		const composing = held<Turn>();
		vi.spyOn(first.brain, 'compose').mockReturnValueOnce(composing.promise);
		try {
			await first.message('hi');
			await vi.advanceTimersByTimeAsync(5_000);
			// The other platform failed to start: index.ts stops the persona, and startAll tries again a minute later
			first.queue.stop();
			await vi.advanceTimersByTimeAsync(MINUTE);
			const second = start({ store: first.store, now: Date.now() });
			await second.queue.requeue('forum', async () => second.conversation);
			// The old turn's model answers late
			composing.resolve({ messages: ['hey you'], action: 'block' });
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(first.conversation.send).not.toHaveBeenCalled();
			expect(first.act).not.toHaveBeenCalled();
			expect(logged(first.log, 'reply_cancelled')).toEqual([{ personId: 1, platform: 'forum', sent: 0, unsent: 1, reason: 'stopped' }]);
			expect(second.conversation.send.mock.calls).toEqual([['hey you']]);
			expect(sentTo(first.store)).toEqual(['hey you']);
			second.queue.stop();
		} finally {
			first.close();
		}
	});

	it('leaves no timer behind when stopped while waiting for its next look, with its quiet running', async () => {
		const { queue, message, close } = start({ rng: () => 0.9 });
		try {
			await message('hey', 'ana');
			await message('hi', 'bo');
			// The tick, the quiet after each message, and the one look both wait for
			expect(vi.getTimerCount()).toBe(4);
			queue.stop();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(60 * MINUTE);
		} finally {
			close();
		}
	});

	it('leaves no timer behind when stopped during an interruption', async () => {
		const persona = utc.personas[0]!;
		const [, interruption] = interruptionsOn(persona, { year: 2026, month: 10, day: 14 }, DEFAULT_SETTINGS.pacing);
		const { log, queue, close } = start({ now: interruption!.start - 5_000 });
		try {
			await vi.advanceTimersByTimeAsync(40_000);
			// The tick met it, and a timer brings it back
			expect(logged(log, 'away')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(2);
			queue.stop();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			close();
		}
	});

	it('times nothing again for a turn that fails once stopped', async () => {
		const { brain, queue, conversation, message, close } = start();
		const composing = held<Turn>();
		const compose = vi.spyOn(brain, 'compose').mockReturnValueOnce(composing.promise);
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(5_000);
			queue.stop();
			composing.reject(new ProviderUnavailableError('LLM 503: overloaded'));
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
			await message('still there?');
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(60 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(1);
			expect(conversation.send).not.toHaveBeenCalled();
		} finally {
			close();
		}
	});
});

describe('turns still owed (handled_at)', () => {
	it('marks what the model saw handled once the reply is delivered, recorded as it goes out', async () => {
		const { store, conversation, message, close } = start();
		let land: () => void = () => undefined;
		conversation.send.mockImplementation(() => new Promise<undefined>((resolve) => (land = () => resolve(undefined))));
		try {
			await message('hi');
			expect(store.personById(1)).toMatchObject({ lastInAt: EVENING, handledAt: 0 });
			await vi.advanceTimersByTimeAsync(60_000);
			// Composed and being sent: still owed, nothing recorded yet
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
			expect(store.personById(1).handledAt).toBe(0);
			expect(sentTo(store)).toEqual([]);
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(store.personById(1)).toMatchObject({ lastInAt: EVENING, handledAt: EVENING });
			expect(sentTo(store)).toEqual(['hey you']);
			expect(store.unanswered('test', 0)).toEqual([]);
		} finally {
			close();
		}
	});

	it('marks a message left on read handled once compose resolves', async () => {
		const { store, brain, message, close } = start();
		vi.spyOn(brain, 'compose').mockResolvedValue({ messages: [], action: 'none' });
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(60_000);
			expect(store.personById(1)).toMatchObject({ lastInAt: EVENING, handledAt: EVENING });
			expect(store.unanswered('test', 0)).toEqual([]);
		} finally {
			close();
		}
	});

	it('keeps a turn halted before its first send owed, and sends it from the backlog once HALT is removed', async () => {
		const { store, log, conversation, message, halt, close } = start();
		// HALT is created while its first message is being typed
		conversation.typing.mockImplementationOnce(async () => void halt(true));
		let recordedAtSend: string[] | null = null;
		conversation.send.mockImplementation(async () => void (recordedAtSend = sentTo(store)));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(conversation.send).not.toHaveBeenCalled();
			expect(sentTo(store)).toEqual([]);
			expect(store.personById(1).handledAt).toBe(0);
			expect(logged(log, 'reply_waiting')).toEqual([expect.objectContaining({ personId: 1, reason: 'halt_switch' })]);
			halt(false);
			// The next tick starts it, 30 s later
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
			expect(recordedAtSend).toEqual([]);
			expect(sentTo(store)).toEqual(['hey you']);
			expect(store.personById(1).handledAt).toBe(EVENING);
		} finally {
			close();
		}
	});

	it('leaves a turn halted before its first send to the turn of a newer message already coming', async () => {
		const { brain, conversation, message, halt, close } = start();
		const compose = vi.spyOn(brain, 'compose');
		// While the first message is typed, they write again (due 4 s later) and HALT is created
		conversation.typing.mockImplementationOnce(async () => {
			void message('one more thing');
			halt(true);
		});
		try {
			await message('hi');
			// The first turn fires after 4 s, reads for 1 s, and is cut 2.4 s later
			await vi.advanceTimersByTimeAsync(8_000);
			expect(conversation.send).not.toHaveBeenCalled();
			halt(false);
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(2);
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
		} finally {
			close();
		}
	});

	it('drops the rest of a reply halted after its first message and commits the turn: nothing more goes out once HALT is removed', async () => {
		const { store, log, brain, conversation, message, halt, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockResolvedValueOnce({ messages: ['one', 'two'], action: 'none' });
		conversation.send.mockImplementationOnce(async () => void halt(true));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(conversation.send.mock.calls).toEqual([['one']]);
			expect(logged(log, 'reply_cancelled')).toEqual([{ personId: 1, platform: 'forum', sent: 1, unsent: 1, reason: 'halt_switch' }]);
			expect(logged(log, 'reply_waiting')).toEqual([]);
			expect(store.personById(1).handledAt).toBe(EVENING);
			halt(false);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(1);
			expect(sentTo(store)).toEqual(['one']);
		} finally {
			close();
		}
	});

	it('carries out no block the persona chose once HALT is on, and logs it skipped', async () => {
		const { store, log, brain, act, conversation, halt, message, close } = start();
		vi.spyOn(brain, 'compose').mockImplementationOnce(async (personId) => {
			// As compose does for a block
			store.updatePerson(personId, { state: 'blocked' });
			return { messages: ['bye'], action: 'block' };
		});
		conversation.typing.mockImplementationOnce(async () => void halt(true));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(conversation.send).not.toHaveBeenCalled();
			expect(act).not.toHaveBeenCalled();
			expect(logged(log, 'action_skipped')).toEqual([{ personId: 1, action: 'block', reason: 'halt_switch' }]);
		} finally {
			close();
		}
	});

	it('in a dry run, sends and records nothing and leaves someone owed from before still owed', async () => {
		const { store, log, queue, conversation, close } = start({ dryRun: true });
		// Sam wrote an hour ago and had no turn yet
		const sam = store.createPerson('test', 'forum', 'user-1', 'Sam').id;
		store.addMessage(sam, 'forum', 'in', 'still there?', EVENING - 60 * MINUTE);
		store.updatePerson(sam, { lastInAt: EVENING - 60 * MINUTE });
		try {
			await queue.requeue('forum', async () => conversation);
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			expect(logged(log, 'dry_send')).toEqual([{ personId: sam, platform: 'forum', text: 'hey you' }]);
			expect(logged(log, 'reply_sent')).toEqual([{ personId: sam, platform: 'forum', messages: 1, dryRun: true }]);
			expect(conversation.send).not.toHaveBeenCalled();
			expect(sentTo(store, sam)).toEqual([]);
			expect(store.personById(sam).handledAt).toBe(0);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([sam]);
			expect(store.get('test', 'lastOnlineAt')).toBeNull();
			expect(audited(store, 'sent')).toEqual([]);
		} finally {
			close();
		}
	});

	it.each([
		{ dryRun: false, fails: false, delivered: ['one', 'two'] },
		{ dryRun: true, fails: false, delivered: ['one', 'two'] },
		{ dryRun: false, fails: true, delivered: ['one'] },
	])('tells the conversation of each message sent, or logged in a dry run, never of one whose send failed: %j', async ({ dryRun, fails, delivered }) => {
		const { brain, conversation, message, close } = start({ dryRun });
		vi.spyOn(brain, 'compose').mockResolvedValue({ messages: ['one', 'two'], action: 'none' });
		const told = vi.fn((_text: string) => undefined);
		Object.assign(conversation, { delivered: told });
		if (fails) conversation.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network down'));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(told.mock.calls).toEqual(delivered.map((text) => [text]));
		} finally {
			close();
		}
	});

	it.each([
		['leaves it on read', async () => ({ messages: [], action: 'none' as const })],
		['gives up on a failing model', async (): Promise<never> => {
			throw new Error('model down');
		}],
	])('in a dry run, never marks them handled when it %s', async (_what, compose) => {
		const { store, brain, message, close } = start({ dryRun: true });
		vi.spyOn(brain, 'compose').mockImplementation(compose);
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(store.personById(1).handledAt).toBe(0);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
		} finally {
			close();
		}
	});

	it('writes the reply again, the draft dropped, for a message that came in while it was written', async () => {
		const { store, log, brain, conversation, message, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockImplementationOnce(async () => {
			await message('one more thing');
			return { messages: ['the draft'], action: 'none', keep: () => store.updatePerson(1, { summary: 'from the draft' }) };
		});
		try {
			await message('hi');
			// Due after 4 s (rng 0); the newer message comes in while the model writes, and its quiet (2 s) ends at 20:00:06
			await vi.advanceTimersByTimeAsync(5_000);
			expect(logged(log, 'reply_restarted')).toEqual([{ personId: 1, platform: 'forum', restarts: 1 }]);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(compose).toHaveBeenCalledTimes(2);
			// One reply, to both messages; nothing of the draft was sent or kept
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
			expect(store.personById(1)).toMatchObject({ summary: '', lastInAt: EVENING + 4_000, handledAt: EVENING + 4_000 });
		} finally {
			close();
		}
	});

	it.each([
		['one message', ['the reply']],
		['two messages', ['first part', 'second part']],
	])('gives a message that comes in while the first message of a reply is being sent a turn of its own (%s)', async (_what, parts) => {
		const { store, log, brain, conversation, message, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockResolvedValueOnce({ messages: parts, action: 'none' });
		let first = true;
		conversation.send.mockImplementation(async () => {
			if (!first) return;
			first = false;
			// It lands as the first message goes out: too late to start over
			await message('wait, one more thing');
		});
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			// The reply went out whole, once, and the newer message had its own turn
			expect(conversation.send.mock.calls.map(([text]) => text)).toEqual([...parts, 'hey you']);
			expect(compose).toHaveBeenCalledTimes(2);
			expect(logged(log, 'reply_superseded')).toEqual([]);
			expect(logged(log, 'reply_restarted')).toEqual([]);
			expect(logged(log, 'reply_after_turn')).toEqual([{ personId: 1, platform: 'forum' }]);
			expect(store.personById(1).handledAt).toBe(store.personById(1).lastInAt);
		} finally {
			close();
		}
	});

	it.each<[string, { restartOnNewMessage?: boolean; maxRestarts?: number }]>([
		['restartOnNewMessage is off', { restartOnNewMessage: false }],
		['the reply already started over maxRestarts times', { maxRestarts: 1 }],
	])('keeps a message that came in during compose owed until its own turn when %s', async (_when, burst) => {
		const { store, log, brain, message, close } = start({ settings: settingsOf({ pacing: { burst } }) });
		const compose = vi.spyOn(brain, 'compose');
		if (burst.maxRestarts) {
			// Started over once already: the message in the second draft is too late for a third
			compose.mockImplementationOnce(async () => {
				await message('wait');
				return { messages: ['the draft'], action: 'none' };
			});
		}
		compose.mockImplementationOnce(async () => {
			await message('one more thing');
			return { messages: ['hey you'], action: 'none' };
		});
		try {
			await message('hi');
			// The turn is due after 4 s (rng 0), reads for 1 s while the model writes, and is sent 2.4 s later
			await vi.advanceTimersByTimeAsync(burst.maxRestarts ? 9_500 : 7_500);
			const newer = store.personById(1).lastInAt;
			expect(store.personById(1).handledAt).toBeLessThan(newer);
			expect(logged(log, 'reply_after_turn')).toEqual([{ personId: 1, platform: 'forum' }]);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
			// Its own turn once that one ended
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(compose).toHaveBeenCalledTimes(burst.maxRestarts ? 3 : 2);
			expect(store.personById(1).handledAt).toBe(newer);
		} finally {
			close();
		}
	});

	it('marks them handled and audits it when the last attempt fails', async () => {
		const { store, brain, message, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockRejectedValue(new Error('model down'));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(3);
			expect(store.personById(1).handledAt).toBe(EVENING);
			expect(store.auditLog('test').filter((row) => row.kind === 'reply_given_up').map((row) => row.detail)).toEqual([{ personId: 1, platform: 'forum', attempts: 3 }]);
		} finally {
			close();
		}
	});

	it('gives up at once on a model the settings do not name, keeping them owed for the next start', async () => {
		const { store, brain, message, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockRejectedValue(new ModelNotConfiguredError('No model set for directMessage'));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(60 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(1);
			expect(audited(store, 'reply_given_up')).toEqual([{ personId: 1, platform: 'forum', attempts: 1, reason: 'model_not_configured' }]);
			expect(store.personById(1).handledAt).toBe(0);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
		} finally {
			close();
		}
	});

	it('keeps a message that came in during the last attempt owed when it gives up, for its own turn', async () => {
		const { store, brain, conversation, message, close } = start();
		const compose = vi.spyOn(brain, 'compose')
			.mockRejectedValueOnce(new Error('model down'))
			.mockRejectedValueOnce(new Error('model down'))
			.mockImplementationOnce(async () => {
				await message('one more thing');
				throw new Error('model down');
			});
		try {
			await message('hi');
			// Tried at 20:00:04, then 1 and 2 minutes later (retries.delayMinutes with this rng)
			await vi.advanceTimersByTimeAsync(3 * MINUTE + 5_000);
			expect(compose).toHaveBeenCalledTimes(3);
			expect(store.personById(1).handledAt).toBe(EVENING);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(compose).toHaveBeenCalledTimes(4);
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
			expect(store.personById(1).handledAt).toBe(store.personById(1).lastInAt);
		} finally {
			close();
		}
	});

	it('keeps them owed through a provider outage, without giving up, waiting twice as long after each try, and answers them once it is back', async () => {
		const { store, log, brain, conversation, message, close } = start();
		const compose = vi.spyOn(brain, 'compose');
		for (let i = 0; i < 6; i++) compose.mockRejectedValueOnce(new ProviderUnavailableError('LLM 503: overloaded'));
		try {
			await message('hi');
			// Tried at 20:00:04, then retries.delayMinutes (1 minute with this rng) times 1, 2, 4, 8 and at most 16 later
			await vi.advanceTimersByTimeAsync(46 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(6);
			expect(logged(log, 'reply_waiting_provider')).toHaveLength(6);
			expect(logged(log, 'reply_scheduled').map((detail) => detail.delayMs)).toEqual([4_000, ...[1, 2, 4, 8, 16, 16].map((minutes) => minutes * MINUTE)]);
			expect(store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(7);
			expect(conversation.send.mock.calls).toEqual([['hey you']]);
			expect(store.personById(1).handledAt).toBe(EVENING);
			expect(audited(store, 'reply_given_up')).toEqual([]);
			expect(logged(log, 'reply_failed')).toEqual([]);
			// Answered: the next outage starts again from one wait
			compose.mockRejectedValueOnce(new ProviderUnavailableError('LLM 503: overloaded'));
			await message('still there?');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ delayMs: MINUTE, reason: 'retry' });
		} finally {
			close();
		}
	});

	it('keeps them owed while the token budget is spent', async () => {
		const { store, brain, message, close } = start();
		const compose = vi.spyOn(brain, 'compose').mockRejectedValue(new LlmBudgetError());
		try {
			await message('hi');
			// Tried at 20:00 and again an hour later (retries.budgetCheckMinutes)
			await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
			expect(compose).toHaveBeenCalledTimes(2);
			expect(store.personById(1).handledAt).toBe(0);
			expect(store.auditLog('test').some((row) => row.kind === 'reply_given_up')).toBe(false);
		} finally {
			close();
		}
	});

	it('parks again, oldest first, the people on that platform owed a turn since 48 h before it was last online', async () => {
		vi.useFakeTimers();
		const DAY = 24 * 60 * MINUTE;
		const store = memoryStore();
		/** Someone whose message at `when` had no turn yet. */
		const wrote = (externalId: string, platform: ChannelId, when: number) => {
			vi.setSystemTime(when);
			const person = store.createPerson('test', platform, externalId, externalId);
			store.addMessage(person.id, platform, 'in', 'still there?');
			return store.updatePerson(person.id, { lastInAt: when }).id;
		};
		wrote('user-1', 'forum', EVENING - 6 * DAY);
		const sam = wrote('user-2', 'forum', EVENING - 2.5 * DAY);
		wrote('user-3', 'chat', EVENING - 2 * DAY);
		const jo = wrote('user-4', 'forum', EVENING - DAY);
		// Last online 3 days ago, two days off since: the backlog goes back to 5 days ago, not 2
		store.set('test', 'lastOnlineAt', String(EVENING - 3 * DAY));
		vi.setSystemTime(EVENING);
		const runtime = createRuntime({ store, dryRun: false, haltFile: 'unused', rng: () => 0 });
		const log = vi.spyOn(runtime, 'log').mockImplementation(() => undefined);
		const queue = createReplyQueue({ brain: { persona: utc.personas[0]!, settings: DEFAULT_SETTINGS } as Brain, runtime, act: async () => undefined });
		queue.start();
		// Jo can't be reached any more
		const conversationOf = vi.fn(async (person: Person) => (person.id === jo ? null : { channel: NOTED_DM, typing: async () => undefined, send: async () => undefined }));
		try {
			// The tick records a newer time, but the backlog still goes back from the one read when the queue was made
			await vi.advanceTimersByTimeAsync(30_000);
			expect(store.get('test', 'lastOnlineAt')).toBe(String(EVENING + 30_000));
			await queue.requeue('forum', conversationOf);
			expect(conversationOf.mock.calls.map(([person]) => person.id)).toEqual([sam, jo]);
			// Into the backlog, never timed at once (the drain answers it from the next tick)
			expect(logged(log, 'reply_waiting')).toEqual([{ personId: sam, platform: 'forum', reason: 'restart', backlog: 1, nextOpenAt: '2026-10-15T19:00:00.000Z' }]);
			expect(logged(log, 'reply_scheduled')).toEqual([]);
		} finally {
			queue.stop();
		}
	});

	it('does not queue again someone whose turn is already coming', async () => {
		const { log, queue, message, close } = start();
		const conversationOf = vi.fn(async () => ({ channel: NOTED_DM, typing: async () => undefined, send: async () => undefined }));
		try {
			await message('hi');
			await queue.requeue('forum', conversationOf);
			expect(conversationOf).toHaveBeenCalledTimes(1);
			expect(logged(log, 'reply_waiting')).toEqual([]);
			expect(logged(log, 'reply_scheduled')).toEqual([expect.objectContaining({ personId: 1, reason: 'pacing' })]);
		} finally {
			close();
		}
	});

	it('records when it was last online every 30 s while its hours are open, from its start, and stops with the queue', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 9, 14, 22, 57, 50));
		const store = memoryStore();
		const runtime = createRuntime({ store, dryRun: false, haltFile: 'unused', rng: () => 0 });
		const queue = createReplyQueue({ brain: { persona: utc.personas[0]!, settings: DEFAULT_SETTINGS } as Brain, runtime, act: async () => undefined });
		try {
			// Not before start(), when its platforms are up
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(store.get('test', 'lastOnlineAt')).toBeNull();
			queue.start();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(store.get('test', 'lastOnlineAt')).toBe(String(Date.UTC(2026, 9, 14, 22, 59, 20)));
			// Its hours end at 23:00
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(store.get('test', 'lastOnlineAt')).toBe(String(Date.UTC(2026, 9, 14, 22, 59, 50)));
			queue.stop();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			queue.stop();
		}
	});

	it('starts its tick once, and never again once stopped', () => {
		vi.useFakeTimers();
		const { runtime } = setUp();
		const queue = createReplyQueue({ brain: { persona: utc.personas[0]!, settings: DEFAULT_SETTINGS } as Brain, runtime, act: async () => undefined });
		queue.start();
		queue.start();
		expect(vi.getTimerCount()).toBe(1);
		queue.stop();
		queue.start();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('watchSpans', () => {
	it('calls onChange once for each change of the span open on a platform, and logs each', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at(12, 29, 50));
		const { runtime, store } = setUp();
		const log = vi.fn();
		const watch = (platform: ChannelId) => {
			const onChange = vi.fn();
			return { onChange, stop: watchSpans(withBreak(['forum']), platform, { ...runtime, now: Date.now, log }, onChange) };
		};
		const forum = watch('forum');
		const chat = watch('chat');
		try {
			await vi.advanceTimersByTimeAsync(at(19, 1) - Date.now());
			expect(forum.onChange.mock.calls.map(([span]) => span?.kind ?? null)).toEqual([null, 'break', null, 'online']);
			// The break is on Forum only
			expect(chat.onChange.mock.calls.map(([span]) => span?.kind ?? null)).toEqual([null, 'online']);
			expect(log.mock.calls.filter(([, , detail]) => detail.platform === 'forum')).toEqual([
				['test', 'hours_closed', { platform: 'forum', nextOpenAt: '2026-10-14T12:30:00.000Z' }],
				['test', 'hours_open', { platform: 'forum', kind: 'break', closesAt: '2026-10-14T12:40:00.000Z' }],
				['test', 'hours_closed', { platform: 'forum', nextOpenAt: '2026-10-14T19:00:00.000Z' }],
				['test', 'hours_open', { platform: 'forum', kind: 'online', closesAt: '2026-10-14T23:00:00.000Z' }],
			]);
			expect(log).toHaveBeenCalledWith('test', 'hours_closed', { platform: 'chat', nextOpenAt: '2026-10-14T19:00:00.000Z' });
		} finally {
			forum.stop();
			chat.stop();
		}
	});
});

describe('the backlog', () => {
	/** Records who each turn was for and when; each is left on read unless `messages`. */
	const turns = (brain: Brain, messages: string[] = []) => {
		const seen: { personId: number; platform: ChannelId; at: number }[] = [];
		const compose = vi.spyOn(brain, 'compose').mockImplementation(async (personId, channel) => {
			seen.push({ personId, platform: channel.id, at: Date.now() });
			return { messages, action: 'none' };
		});
		return { seen, compose };
	};
	const ids = (seen: { personId: number }[]) => seen.map(({ personId }) => personId);
	/** Each turn as [personId, when]. */
	const timeline = (seen: { personId: number; at: number }[]) => seen.map((turn) => [turn.personId, turn.at]);

	it('parks a message that comes in offline, without a timer for the start of the hours', async () => {
		const { log, message, close } = start({ now: at(12) });
		try {
			await message('hi');
			expect(logged(log, 'reply_waiting')).toEqual([{ personId: 1, platform: 'forum', reason: 'offline', backlog: 1, nextOpenAt: '2026-10-14T19:00:00.000Z' }]);
			expect(logged(log, 'reply_scheduled')).toEqual([]);
			// The queue's own tick only
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			close();
		}
	});

	it.each([0, 2])('answers it when the span opens, one person at a time, oldest first, with %i extra minutes before the first', async (minutes) => {
		const settings = settingsOf({ pacing: { returnOnlineReplyDelayMinutes: [minutes, minutes] } });
		const { log, brain, conversation, message, close } = start({ now: at(12), settings });
		const { seen } = turns(brain, ['hey you']);
		const sent: number[] = [];
		conversation.send.mockImplementation(async () => void sent.push(Date.now()));
		try {
			for (const from of ['ana', 'bo', 'cy']) {
				await message('you there?', from);
				await vi.advanceTimersByTimeAsync(MINUTE);
			}
			await vi.advanceTimersByTimeAsync(at(19, 10) - Date.now());
			expect(ids(seen)).toEqual([1, 2, 3]);
			// backlogGapSeconds (30 s with this rng) before each, and returnOnlineReplyDelayMinutes before the first
			expect(seen[0]!.at).toBe(at(19, minutes, 30));
			// Each starts only once the one before was sent
			expect(seen[1]!.at).toBe(sent[0]! + 30_000);
			expect(seen[2]!.at).toBe(sent[1]! + 30_000);
			expect(logged(log, 'reply_scheduled').map((detail) => [detail.reason, detail.delayMs])).toEqual([
				['backlog', 30_000 + minutes * MINUTE],
				['backlog', 30_000],
				['backlog', 30_000],
			]);
		} finally {
			close();
		}
	});

	it('answers on a short break as if watching, due 90 s before it ends, else in the next span', async () => {
		// On its phone: with this rng the watching lag is 14.08 s (its 99th percentile), where a full span would glance at its messages after 15 minutes
		const { log, message, close } = start({ now: at(12, 35), persona: withBreak(), rng: () => 0.99 });
		try {
			await message('quick one?', 'ana');
			await vi.advanceTimersByTimeAsync(3 * MINUTE + 25_000);
			// 1 minute 35 s left: cut to be due at 12:38:30
			await message('still there?', 'bo');
			await vi.advanceTimersByTimeAsync(MINUTE);
			// Under 90 s left: not even the quickest reply fits
			await message('and me?', 'cy');
			expect(logged(log, 'reply_scheduled').map((detail) => [detail.personId, detail.delayMs, detail.dueAt, detail.watching])).toEqual([
				[1, 14_077, '2026-10-14T12:35:14.077Z', true],
				[2, 5_000, '2026-10-14T12:38:30.000Z', true],
			]);
			expect(logged(log, 'reply_waiting')).toEqual([{ personId: 3, platform: 'forum', reason: 'span_ending', backlog: 1, nextOpenAt: '2026-10-14T19:00:00.000Z' }]);
			await vi.advanceTimersByTimeAsync(at(19, 10) - Date.now());
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ personId: 3, reason: 'backlog' });
			expect(logged(log, 'reply_sent').map((detail) => detail.personId)).toEqual([1, 2, 3]);
		} finally {
			close();
		}
	});

	it('still sends a reply it was writing when the break ended', async () => {
		const { brain, conversation, message, close } = start({ now: at(12, 37), persona: withBreak() });
		vi.spyOn(brain, 'compose').mockImplementation(async () => {
			await sleep(3 * MINUTE);
			return { messages: ['back to it, talk later'], action: 'none' };
		});
		let sentAt = 0;
		conversation.send.mockImplementation(async () => void (sentAt = Date.now()));
		try {
			await message('hi');
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(conversation.send).toHaveBeenCalledWith('back to it, talk later');
			expect(sentAt).toBeGreaterThan(at(12, 40));
		} finally {
			close();
		}
	});

	it('sends nothing to someone deny-listed elsewhere while they waited (a group chat, another persona)', async () => {
		const { store, conversation, message, close } = start({ now: at(12) });
		try {
			await message('hey');
			store.deny('forum', 'user-1', 'minor');
			await vi.advanceTimersByTimeAsync(at(19, 10) - Date.now());
			expect(conversation.send).not.toHaveBeenCalled();
		} finally {
			close();
		}
	});

	it('keeps a Chat person waiting through a Forum-only break, for the next span that includes Chat', async () => {
		const { brain, message, close } = start({ now: at(12), persona: withBreak(['forum']) });
		const { seen } = turns(brain);
		try {
			await message('hey', 'dee', PLAIN_DM);
			await message('hey', 'fay', NOTED_DM);
			await vi.advanceTimersByTimeAsync(at(12, 45) - Date.now());
			expect(seen.map(({ personId, platform }) => [personId, platform])).toEqual([[2, 'forum']]);
			await vi.advanceTimersByTimeAsync(at(19, 5) - Date.now());
			expect(seen.map(({ personId, platform }) => [personId, platform])).toEqual([[2, 'forum'], [1, 'chat']]);
		} finally {
			close();
		}
	});

	it('parks a reply that comes due while halted, and answers the backlog at a human pace once HALT is removed', async () => {
		const { store, log, brain, message, halt, close } = start();
		const { seen } = turns(brain);
		try {
			await message('hi', 'ana');
			await message('hi', 'bo');
			halt(true);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(seen).toEqual([]);
			expect(logged(log, 'reply_waiting').map((detail) => [detail.personId, detail.reason])).toEqual([[1, 'halt_switch'], [2, 'halt_switch']]);
			// Halted, it answers nobody: not recorded as online, so a restart still looks back far enough for them
			expect(store.get('test', 'lastOnlineAt')).toBeNull();
			halt(false);
			// The next tick (20:10:30) starts the first, 30 s later; the second 30 s after it ends (it reads for 1 s, then leaves it on read)
			await vi.advanceTimersByTimeAsync(MINUTE + 10_000);
			expect(store.get('test', 'lastOnlineAt')).toBe(String(at(20, 11)));
			expect(timeline(seen)).toEqual([[1, at(20, 11)]]);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(timeline(seen)).toEqual([[1, at(20, 11)], [2, at(20, 11, 31)]]);
		} finally {
			close();
		}
	});

	describe('moves on to the next person whatever happens to a backlog turn', () => {
		/** Ana, Bo and Cy wrote while offline; the span opens at 19:00, so Ana's turn is due at 19:00:30 and Bo's 30 s after it ends. */
		const backlog = async () => {
			const run = start({ now: at(18, 50) });
			for (const from of ['ana', 'bo', 'cy']) await run.message('you there?', from);
			return run;
		};

		it.each([['a model error', new Error('model down')], ['a spent budget', new LlmBudgetError()]])('when compose fails with %s', async (_kind, error) => {
			const { store, brain, close } = await backlog();
			const { seen, compose } = turns(brain);
			compose.mockImplementationOnce(async (personId, channel) => {
				seen.push({ personId, platform: channel.id, at: Date.now() });
				throw error;
			});
			try {
				await vi.advanceTimersByTimeAsync(at(19, 1, 10) - Date.now());
				// Ana's retry or budget wait runs on its own timer, after Bo
				expect(timeline(seen)).toEqual([[1, at(19, 0, 30)], [2, at(19, 1)]]);
				expect(store.personById(1).handledAt).toBe(0);
			} finally {
				close();
			}
		});

		it('when the person being answered says stop before their turn', async () => {
			const { brain, message, close } = await backlog();
			const { seen } = turns(brain);
			try {
				await vi.advanceTimersByTimeAsync(at(19, 0, 10) - Date.now());
				const goodbye = message('please stop messaging me', 'ana');
				await vi.advanceTimersByTimeAsync(40_000);
				await goodbye;
				expect(timeline(seen)).toEqual([[2, at(19, 0, 40)]]);
			} finally {
				close();
			}
		});

		it('when the person is still busy with an earlier turn, which their newer message is left to', async () => {
			// Ana's turn on the break is still being written, stuck, when she writes again
			const { log, brain, message, close } = start({ now: at(12, 38), persona: withBreak() });
			const { seen, compose } = turns(brain);
			compose.mockImplementationOnce(async (personId, channel) => {
				seen.push({ personId, platform: channel.id, at: Date.now() });
				return new Promise<never>(() => undefined);
			});
			try {
				await message('hi', 'ana');
				await vi.advanceTimersByTimeAsync(10 * MINUTE);
				await message('hello?', 'ana');
				await message('hey', 'bo');
				await vi.advanceTimersByTimeAsync(at(19, 1, 10) - Date.now());
				// Her draft is to start over once the model answers: she never waits in the backlog, and Bo's turn is its first
				expect(logged(log, 'reply_superseded')).toEqual([{ personId: 1, platform: 'forum' }]);
				// On the break it answers as if watching: 2 s with this rng
				expect(timeline(seen)).toEqual([[1, at(12, 38, 2)], [2, at(19, 0, 30)]]);
			} finally {
				close();
			}
		});

		it.each(['unreachable', 'failed', 'ended', 'halt_switch'] as const)("when Ana's delivery stops with %s", async (stop) => {
			const run = await backlog();
			const compose = vi.spyOn(run.brain, 'compose').mockImplementation(async (personId) => ({ messages: [`for ${personId}`], action: 'none' }));
			// On Ana's first message typed
			let first = true;
			run.conversation.typing.mockImplementation(async (on) => {
				if (!on || !first) return;
				first = false;
				if (stop === 'ended') run.store.updatePerson(1, { state: 'stopped' });
				if (stop === 'halt_switch') {
					run.halt(true);
					setTimeout(() => run.halt(false), MINUTE);
				}
			});
			let tried = false;
			run.conversation.send.mockImplementation(async (text) => {
				if (text !== 'for 1' || tried) return;
				tried = true;
				if (stop === 'unreachable') throw new UnreachableError('blocked');
				if (stop === 'failed') throw new Error('network down');
			});
			try {
				await vi.advanceTimersByTimeAsync(at(19, 15) - Date.now());
				// Halted before anything went out, Ana is answered from the backlog once HALT is removed
				expect(compose.mock.calls.map(([personId]) => personId)).toEqual(stop === 'halt_switch' ? [1, 2, 3, 1] : [1, 2, 3]);
				expect([1, 2, 3].map((id) => sentTo(run.store, id))).toEqual([stop === 'halt_switch' ? ['for 1'] : [], ['for 2'], ['for 3']]);
				for (const id of [1, 2, 3]) expect(run.store.personById(id).handledAt).toBe(at(18, 50));
			} finally {
				run.close();
			}
		});
	});
});

describe('settings per brain', () => {
	it("retries a failed answer as many times as its brain's settings say", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const tries = async (id: string) => {
			const { runtime, store } = setUp();
			const persona = config.personas.find((p) => p.id === id)!;
			store.createPerson(id, 'forum', 'user-1', 'Sam');
			const compose = vi.fn(async () => {
				throw new Error('model down');
			});
			const queue = createReplyQueue({ brain: { persona, settings: config.settings[id], compose } as unknown as Brain, runtime, act: async () => {} });
			queue.schedule(1, { channel: NOTED_DM, typing: async () => {}, send: async () => {} });
			for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(10 * MINUTE);
			queue.stop();
			return compose.mock.calls.length;
		};
		expect(await tries('robin')).toBe(1);
		expect(await tries('sky')).toBe(3);
	});
});

describe('typing realism', () => {
	/** Settings with these pacing settings. */
	const typist = (pacing: Record<string, unknown>) => settingsOf({ pacing });

	/** A conversation that records each call the queue makes on it as `<call> @<ms after the first call>`, with these hooks. */
	const recording = ({ typingRefreshMs, markRead }: { typingRefreshMs?: number; markRead?: 'resolves' | 'rejects' } = {}) => {
		const events: string[] = [];
		let first: number | undefined;
		const record = (event: string) => events.push(`${event} @${Date.now() - (first ??= Date.now())}`);
		const conversation: Conversation = {
			channel: NOTED_DM,
			typing: async (on) => void record(`typing ${on ? 'on' : 'off'}`),
			send: async (text) => void record(`send ${text}`),
			...(typingRefreshMs !== undefined && { typingRefreshMs }),
			...(markRead && {
				async markRead() {
					record('read');
					if (markRead === 'rejects') throw new Error('read receipt refused');
				},
			}),
		};
		return { conversation, events };
	};

	/** Sam writes, and the queue gets it with `conversation`. */
	const hi = async ({ queue, brain }: ReturnType<typeof start>, conversation: Conversation) => queue.handle(brain.incoming(NOTED_DM, 'user-1', 'Sam', 'hi'), conversation, 'hi');

	// With this rng the reply comes 4 s after the message, 'hi' is read for 1 s (the shortest) and 'hey you' is typed for 2.4 s (3.5 characters a second, plus 0.4 s)
	it('makes only the calls a plain conversation needs, with one draw for the reading', async () => {
		const rng = vi.fn(() => 0);
		const run = start({ rng });
		const { conversation, events } = recording();
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['typing on @0', 'send hey you @2400', 'typing off @2400']);
			// The reply delay (one: no turn with them yet that it could still be watching), the quiet after their message (one), the
			// reading speed (one) and the typing time (two): nothing for what the conversation and settings leave out
			expect(rng).toHaveBeenCalledTimes(5);
		} finally {
			run.close();
		}
	});

	describe('what came with a message', () => {
		// Read receipt first, so the wait before typing shows; with this rng each photo takes the shortest look (1.5 s)
		const gapBeforeTyping = async (message: string | IncomingMessage) => {
			const run = start();
			const { conversation, events } = recording({ markRead: 'resolves' });
			try {
				const text = typeof message === 'string' ? message : message.text;
				run.queue.handle(run.brain.incoming(NOTED_DM, 'user-1', 'Sam', message), conversation, text);
				await vi.advanceTimersByTimeAsync(MINUTE);
				return events[1];
			} finally {
				run.close();
			}
		};
		const photo = { url: 'https://cdn.example/p.jpg' };

		it('looks at a photo sent alone before it types', async () => {
			expect(await gapBeforeTyping({ text: '', images: [photo] })).toBe('typing on @1500');
		});
		it('takes longer over two photos', async () => {
			expect(await gapBeforeTyping({ text: '', images: [photo, photo] })).toBe('typing on @3000');
		});
		it('spends no time reading a URL', async () => {
			// At once: a timer of nothing still takes its one tick
			expect(await gapBeforeTyping(`https://example.com/${'long/'.repeat(30)}`)).toMatch(/^typing on @[01]$/);
		});
	});

	it('shows typing again every typingRefreshMs while a message is typed', async () => {
		const run = start();
		const { conversation, events } = recording({ typingRefreshMs: 1_000 });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['typing on @0', 'typing on @1000', 'typing on @2000', 'send hey you @2400', 'typing off @2400']);
		} finally {
			run.close();
		}
	});

	it('stops typing at the next refresh once halted, sending nothing, and keeps the turn owed', async () => {
		const run = start();
		const { conversation, events } = recording({ typingRefreshMs: 1_000 });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(4_000 + 1_000 + 1_500);
			run.halt(true);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['typing on @0', 'typing on @1000', 'typing off @2000']);
			expect(logged(run.log, 'reply_cancelled')).toEqual([{ personId: 1, platform: 'forum', sent: 0, unsent: 1, reason: 'halt_switch' }]);
			expect(run.store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
		} finally {
			run.close();
		}
	});

	it('shows their messages read once per reply, then reads for readingDurationSeconds before typing', async () => {
		const run = start({ settings: typist({ readingDurationSeconds: [2, 2], betweenReplyMessagesSeconds: [1, 1] }) });
		vi.spyOn(run.brain, 'compose').mockResolvedValue({ messages: ['one', 'two'], action: 'none' });
		const { conversation, events } = recording({ markRead: 'resolves' });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			// 1.5 s of typing each: the shortest typingDurationSeconds
			expect(events).toEqual(['read @0', 'typing on @2000', 'send one @3500', 'typing off @3500', 'typing on @4500', 'send two @6000', 'typing off @6000']);
		} finally {
			run.close();
		}
	});

	it('reads for as long as the unread messages take, from the moment the reply is due', async () => {
		const run = start();
		const { conversation, events } = recording({ markRead: 'resolves' });
		const long = 'x'.repeat(150);
		try {
			await run.queue.handle(run.brain.incoming(NOTED_DM, 'user-1', 'Sam', long), conversation, long);
			// Due after 4 s; with rng 0 it reads 15 characters a second: 10 s
			await vi.advanceTimersByTimeAsync(4_000 + 9_999);
			expect(events).toEqual(['read @0']);
			await vi.advanceTimersByTimeAsync(1);
			expect(events).toEqual(['read @0', 'typing on @10000']);
		} finally {
			run.close();
		}
	});

	it('treats a read receipt refused as a failed delivery: no typing, nothing sent', async () => {
		const run = start();
		const { conversation, events } = recording({ markRead: 'rejects' });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['read @0']);
			expect(logged(run.log, 'delivery_failed')).toEqual([{ personId: 1, platform: 'forum', sent: 0, error: 'Error: read receipt refused' }]);
		} finally {
			run.close();
		}
	});

	it('types nothing when halted during the read pause, and keeps the turn owed', async () => {
		const run = start({ settings: typist({ readingDurationSeconds: [2, 2] }) });
		const { conversation, events } = recording({ markRead: 'resolves' });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(4_000 + 1_000);
			run.halt(true);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['read @0']);
			expect(run.store.unanswered('test', 0).map(({ person }) => person.id)).toEqual([1]);
		} finally {
			run.close();
		}
	});

	// 33 characters: 9829 ms of typing, in stretches of 3276, 3276 and 3277 ms around two 1 s pauses
	const LONG = 'x'.repeat(33);
	const PAUSES = { thinkingPauses: { chance: 1, minChars: 10, max: 2, seconds: [1, 1] } };

	it.each([
		{ typingRefreshMs: undefined, expected: ['typing on @0', 'typing off @3276', 'typing on @4276', 'typing off @7552', 'typing on @8552', `send ${LONG} @11829`, 'typing off @11829'] },
		{
			typingRefreshMs: 2_000,
			expected: ['typing on @0', 'typing on @2000', 'typing off @3276', 'typing on @4276', 'typing on @6276', 'typing off @7552', 'typing on @8552', 'typing on @10552', `send ${LONG} @11829`, 'typing off @11829'],
		},
	])('stops and starts typing again for each thinking pause of a long message (refresh $typingRefreshMs)', async ({ typingRefreshMs, expected }) => {
		const run = start({ settings: typist(PAUSES) });
		vi.spyOn(run.brain, 'compose').mockResolvedValue({ messages: [LONG], action: 'none' });
		const { conversation, events } = recording({ typingRefreshMs });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(expected);
		} finally {
			run.close();
		}
	});

	it('leaves typing off when halted during a thinking pause, with no second typing(false)', async () => {
		const run = start({ settings: typist(PAUSES) });
		vi.spyOn(run.brain, 'compose').mockResolvedValue({ messages: [LONG], action: 'none' });
		const { conversation, events } = recording();
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(4_000 + 3_800);
			run.halt(true);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['typing on @0', 'typing off @3276']);
			expect(logged(run.log, 'reply_cancelled')).toHaveLength(1);
		} finally {
			run.close();
		}
	});

	it('rehearses all of it in a dry run, sending nothing', async () => {
		const run = start({ dryRun: true, settings: typist({ readingDurationSeconds: [2, 2] }) });
		const { conversation, events } = recording({ markRead: 'resolves', typingRefreshMs: 2_000 });
		try {
			await hi(run, conversation);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(events).toEqual(['read @0', 'typing on @2000', 'typing on @4000', 'typing off @4400']);
			expect(logged(run.log, 'dry_send')).toEqual([{ personId: 1, platform: 'forum', text: 'hey you' }]);
		} finally {
			run.close();
		}
	});
});

describe('one person at a time', () => {
	/** Each person writes at the given ms after the start; each reply is held until the test lets it finish. Answers who was composing, and when. */
	const writers = async (who: [from: string, after: number][]) => {
		const run = start();
		const gates = new Map<number, ReturnType<typeof held<void>>>();
		const order: string[] = [];
		vi.spyOn(run.brain, 'compose').mockImplementation(async (personId) => {
			order.push(`start ${personId} @${Date.now() - EVENING}`);
			gates.set(personId, held<void>());
			await gates.get(personId)!.promise;
			order.push(`end ${personId} @${Date.now() - EVENING}`);
			return { messages: [], action: 'none' };
		});
		for (const [from, after] of who) {
			await vi.advanceTimersByTimeAsync(EVENING + after - Date.now());
			await run.message('hi', from);
		}
		return { ...run, gates, order };
	};

	it('answers one person at a time: the next starts the moment the one before ends', async () => {
		const run = await writers([['ana', 0], ['bo', 0]]);
		try {
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(run.order).toEqual(['start 1 @4000']);
			run.gates.get(1)!.resolve();
			await vi.advanceTimersByTimeAsync(0);
			// No polling: Bo's turn, due since 20:00:04, starts as Ana's ends
			expect(run.order).toEqual(['start 1 @4000', 'end 1 @300000', 'start 2 @300000']);
			run.gates.get(2)!.resolve();
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(run.order).toEqual(['start 1 @4000', 'end 1 @300000', 'start 2 @300000', 'end 2 @300000']);
		} finally {
			run.close();
		}
	});

	it('answers the others in the order their turns came due', async () => {
		const run = await writers([['ana', 0], ['bo', 10_000], ['cy', 20_000]]);
		try {
			await vi.advanceTimersByTimeAsync(MINUTE);
			// Each turn ends as the test lets it (once its 1 s of reading is over too), which starts the next due
			for (let i = 0; i < 3; i++) {
				const composing = Number(run.order.at(-1)!.split(' ')[1]);
				run.gates.get(composing)!.resolve();
				await vi.advanceTimersByTimeAsync(1_000);
			}
			expect(run.order.filter((line) => line.startsWith('start'))).toEqual(['start 1 @4000', 'start 2 @80000', 'start 3 @81000']);
		} finally {
			run.close();
		}
	});

	it('stops holding the others back for a reply stuck over ten minutes', async () => {
		const run = await writers([['ana', 0], ['bo', 0]]);
		try {
			await vi.advanceTimersByTimeAsync(5 * MINUTE);
			expect(run.order).toEqual(['start 1 @4000']);
			await vi.advanceTimersByTimeAsync(5 * MINUTE + 4_000);
			expect(run.order).toEqual(['start 1 @4000', 'start 2 @604000']);
		} finally {
			run.close();
		}
	});

	it('has no setting to turn it off', () => {
		expect(parseSettings({ pacing: { singlePresence: false } }).issues).toEqual(['pacing.singlePresence: unknown key']);
	});
});

describe('someone who writes in bursts (pacing.burst)', () => {
	/** Settings with this `pacing.burst`, and these other pacing settings. */
	const burstSettings = (burst: Record<string, unknown>, pacing: Record<string, unknown> = {}) => settingsOf({ pacing: { burst, ...pacing } });
	/** Sam writes each text at its ms after 20:00. */
	const writes = async (run: ReturnType<typeof start>, texts: [text: string, after: number][]) => {
		for (const [text, after] of texts) {
			await vi.advanceTimersByTimeAsync(EVENING + after - Date.now());
			await run.message(text);
		}
	};
	/** When each compose started, in ms after 20:00, calling the real one. */
	const composeStarts = (run: ReturnType<typeof start>) => {
		const starts: number[] = [];
		const real = run.brain.compose.bind(run.brain);
		vi.spyOn(run.brain, 'compose').mockImplementation(async (...args) => {
			starts.push(Date.now() - EVENING);
			return real(...args);
		});
		return starts;
	};

	it('waits for them to stop: each message starts the quiet again, up to maxSettleResets of them', async () => {
		const run = start({ settings: burstSettings({ settleSeconds: [3, 3], maxSettleResets: 2 }) });
		const starts = composeStarts(run);
		try {
			// Due 4 s after the first; the quiet runs to 3 s, then 5.5 s and 8 s; the fourth message may not start it again
			await writes(run, [['so', 0], ['about', 2_500], ['yesterday', 5_000], ['…', 7_500]]);
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(starts).toEqual([8_000]);
			// One reply, to all of them
			expect(run.conversation.send.mock.calls).toEqual([['hey you']]);
			expect(run.store.personById(1).handledAt).toBe(EVENING + 7_500);
		} finally {
			run.close();
		}
	});

	it('starts at once when they stopped long before the turn is due, and waits for no quiet with settleSeconds [0, 0]', async () => {
		for (const settleSeconds of [[2, 5], [0, 0]]) {
			const run = start({ settings: burstSettings({ settleSeconds }) });
			const starts = composeStarts(run);
			try {
				await writes(run, [['hi', 0], ['you there?', 3_000]]);
				await vi.advanceTimersByTimeAsync(MINUTE);
				// The quiet after 'you there?' (2 s with this rng) ends at 5 s, after the turn came due
				expect(starts).toEqual([settleSeconds[1] ? 5_000 : 4_000]);
			} finally {
				run.close();
			}
		}
	});

	it.each([
		[1_000, 6_000],
		[5_000, 9_000],
	])('shows their messages read and reads them while the model writes (%i ms), typing once both are done (at %i ms)', async (composeMs, typingAt) => {
		const run = start({ settings: burstSettings({}, { readingDurationSeconds: [2, 2] }) });
		const events: string[] = [];
		const record = (event: string) => void events.push(`${event} @${Date.now() - EVENING}`);
		vi.spyOn(run.brain, 'compose').mockImplementation(async () => {
			record('compose');
			await sleep(composeMs);
			return { messages: ['hey'], action: 'none' };
		});
		const conversation: Conversation = { channel: NOTED_DM, markRead: async () => record('read'), typing: async (on) => record(`typing ${on ? 'on' : 'off'}`), send: async (text) => record(`send ${text}`) };
		try {
			await run.queue.handle(run.brain.incoming(NOTED_DM, 'user-1', 'Sam', 'hi'), conversation, 'hi');
			await vi.advanceTimersByTimeAsync(MINUTE);
			// Due at 4 s; 1.5 s of typing (the shortest)
			expect(events).toEqual(['read @4000', 'compose @4000', `typing on @${typingAt}`, `send hey @${typingAt + 1_500}`, `typing off @${typingAt + 1_500}`]);
		} finally {
			run.close();
		}
	});

	it('stops typing and writes the reply again for a message that came in while its first message was typed', async () => {
		const run = start();
		const compose = vi.spyOn(run.brain, 'compose').mockResolvedValueOnce({ messages: ['x'.repeat(70)], action: 'none' });
		const events: string[] = [];
		const conversation: Conversation = {
			channel: NOTED_DM,
			typingRefreshMs: 1_000,
			typing: async (on) => void events.push(`typing ${on ? 'on' : 'off'} @${Date.now() - EVENING}`),
			send: async (text) => void events.push(`send ${text} @${Date.now() - EVENING}`),
		};
		const say = (text: string) => run.queue.handle(run.brain.incoming(NOTED_DM, 'user-1', 'Sam', text), conversation, text);
		try {
			// Due at 4 s, read for 1 s: typing from 5 s, for 20.4 s
			await say('hi');
			await vi.advanceTimersByTimeAsync(10_000 - 1);
			await say('one more thing');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(compose).toHaveBeenCalledTimes(2);
			expect(logged(run.log, 'reply_restarted')).toEqual([{ personId: 1, platform: 'forum', restarts: 1 }]);
			// Typing goes off at the next refresh; the second draft starts once their quiet (2 s) is over, reads the newer message for 1 s and types 'hey you' for 2.4 s
			expect(events.filter((event) => !event.startsWith('typing on @') || event === 'typing on @5000' || event === 'typing on @12999')).toEqual([
				'typing on @5000',
				'typing off @10000',
				'typing on @12999',
				'send hey you @15399',
				'typing off @15399',
			]);
			expect(sentTo(run.store)).toEqual(['hey you']);
		} finally {
			run.close();
		}
	});
});

describe('attention: watching a chat, glancing, interruptions', () => {
	const persona = utc.personas[0]!;
	/** The interruptions of its Oct 14 (`pacing.interruptions`): the second runs from about 20:51:37 to 20:56:35. */
	const [, away] = interruptionsOn(persona, { year: 2026, month: 10, day: 14 }, DEFAULT_SETTINGS.pacing);
	/** Who wrote when, from what reply_scheduled logged. */
	const timed = (log: ReturnType<typeof start>['log']) => logged(log, 'reply_scheduled').map((detail) => [detail.personId, detail.delayMs, detail.watching]);

	it('answers within seconds while it still watches their chat, and glances later when it does not', async () => {
		// rng 0: a turn to go by means watching (the chance is never 0), its lag 2 s; without one, the next glance in 4 s
		const { log, conversation, message, close } = start();
		try {
			await message('hey');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(conversation.send).toHaveBeenCalledTimes(1);
			await message('how are you?');
			expect(timed(log)).toEqual([
				[1, 4_000, false],
				[1, 2_000, true],
			]);
		} finally {
			close();
		}
	});

	it.each([
		[30_000, true],
		[3 * MINUTE, false],
	])('watches their chat %i ms after its turn with them: %s (the chance halves every 90 s, rng 0.4)', async (after, watching) => {
		// 0.79 after 30 s, 0.25 after 3 minutes
		const { log, conversation, message, close } = start({ rng: () => 0.4 });
		let sentAt = 0;
		conversation.send.mockImplementation(async () => void (sentAt = Date.now()));
		try {
			await message('hey');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(sentAt).toBeGreaterThan(0);
			await vi.advanceTimersByTimeAsync(sentAt + after - Date.now());
			await message('and you?');
			expect(logged(log, 'reply_scheduled').at(-1)!.watching).toBe(watching);
		} finally {
			close();
		}
	});

	it('notices a message from anyone within seconds while it is on its phone with someone else', async () => {
		const { log, conversation, message, close } = start();
		try {
			await message('hey', 'bo');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(conversation.send).toHaveBeenCalledTimes(1);
			// Ana never wrote before: it is on its phone, with Bo, so her message is noticed after the short lag
			await message('hi there', 'ana');
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ personId: 2, delayMs: 2_000, watching: true });
		} finally {
			close();
		}
	});

	it('notices everyone who wrote before its next look at its messages at once, then picks among them', async () => {
		// rng 0.9: its next look comes 150 s after Bo's message; Ana writes 100 s in and waits for the same look
		const { log, message, close } = start({ rng: () => 0.9 });
		try {
			await message('hey', 'bo');
			await vi.advanceTimersByTimeAsync(100_000);
			await message('hi', 'ana');
			expect(logged(log, 'reply_scheduled').map((detail) => [detail.personId, detail.delayMs, detail.dueAt])).toEqual([
				[1, 150_000, new Date(EVENING + 150_000).toISOString()],
				[2, 50_000, new Date(EVENING + 150_000).toISOString()],
			]);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(logged(log, 'reply_picked')[0]).toMatchObject({ among: 2 });
		} finally {
			close();
		}
	});

	it("notices what waited for its next look as soon as it picks up its phone for someone's backlog turn", async () => {
		// Bo wrote while it was offline; the span opens at 19:00, and his backlog turn starts after the gap (113.5 s) from the next tick, 19:00:20
		const { log, message, close } = start({ now: at(18, 59, 50), rng: () => 0.9 });
		try {
			await message('hey', 'bo');
			await vi.advanceTimersByTimeAsync(at(19, 0, 5) - Date.now());
			// Ana writes once it is online: off its phone, its next look 150 s away
			await message('hi', 'ana');
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ personId: 2, delayMs: 150_000, watching: false });
			await vi.advanceTimersByTimeAsync(at(19, 2, 20) - Date.now());
			// Bo's turn picked up the phone at 19:02:13, before its look at 19:02:35: Ana's message was noticed then, after the lag (8 s, its 90th percentile)
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ personId: 2, delayMs: 8_000, watching: true });
		} finally {
			close();
		}
	});

	it('starts no turn while something took it away, answers them in order once it is back, and watches no chat then', async () => {
		const { log, brain, conversation, message, close } = start({ now: away!.start - 20_000 });
		const starts: [number, number][] = [];
		const real = brain.compose.bind(brain);
		vi.spyOn(brain, 'compose').mockImplementation(async (personId, channel, options) => {
			starts.push([personId, Date.now()]);
			return real(personId, channel, options);
		});
		try {
			// Answered just before it is called away
			await message('quick question', 'ana');
			await vi.advanceTimersByTimeAsync(15_000);
			expect(conversation.send).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(away!.start + 30_000 - Date.now());
			await message('still there?', 'ana');
			await message('hi!', 'bo');
			await vi.advanceTimersByTimeAsync(MINUTE);
			// Due a few seconds later, inside the interruption: nothing starts
			expect(starts).toHaveLength(1);
			// Met at the first tick inside it (they come every 30 s from the start, 20 s before it)
			expect(logged(log, 'away')).toEqual([{ from: new Date(away!.start + 10_000).toISOString(), until: new Date(away!.end).toISOString() }]);
			await vi.advanceTimersByTimeAsync(away!.end + MINUTE - Date.now());
			expect(starts.slice(1)).toEqual([
				[1, away!.end],
				[2, expect.any(Number)],
			]);
			// Ana's newer message was timed as not watching: it was called away since its turn with her
			expect(logged(log, 'reply_scheduled').filter((detail) => detail.personId === 1).map((detail) => detail.watching)).toEqual([false, false]);
		} finally {
			close();
		}
	});

	it('holds an interruption off while a conversation that matters goes on, and takes it once that calms down', async () => {
		const { store, log, conversation, message, close } = start({ now: away!.start - 20_000 });
		try {
			await message('i have to tell you something', 'ana');
			// Something that matters a lot, as the model rated it just now
			store.updatePerson(1, { importance: 3, importanceAt: Date.now() });
			await vi.advanceTimersByTimeAsync(away!.start + 30_000 - Date.now());
			expect(logged(log, 'interruption_held')).toEqual([{ personId: 1, minutes: Number(((away!.end - away!.start - 10_000) / MINUTE).toFixed(1)) }]);
			// Still there for her: answered within seconds, inside the time it would have been away
			await message('ok so', 'ana');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(conversation.send).toHaveBeenCalledTimes(2);
			expect(logged(log, 'away')).toEqual([]);
			// Five quiet minutes later it goes, for the time it had left
			await vi.advanceTimersByTimeAsync(6 * MINUTE);
			const [left] = logged(log, 'away') as { from: string; until: string }[];
			expect(Date.parse(left!.until) - Date.parse(left!.from)).toBe(away!.end - away!.start - 10_000);
			expect(Date.parse(left!.from)).toBeGreaterThanOrEqual(away!.start + 30_000 + 5 * MINUTE);
		} finally {
			close();
		}
	});

	it('never holds one off with holdAtImportance 4, for small talk, or for a rating from an hour ago', async () => {
		for (const [holdAtImportance, importance, ratedAgo] of [[4, 3, 0], [2, 1, 0], [2, 3, 60 * MINUTE]] as const) {
			const { store, log, message, close } = start({ settings: settingsOf({ pacing: { interruptions: { holdAtImportance } } }), now: away!.start - 20_000 });
			try {
				await message('hey', 'ana');
				store.updatePerson(1, { importance, importanceAt: Date.now() - ratedAgo });
				await vi.advanceTimersByTimeAsync(away!.start + 30_000 - Date.now());
				expect(logged(log, 'interruption_held')).toEqual([]);
				expect(logged(log, 'away')).toHaveLength(1);
			} finally {
				close();
			}
		}
	});

	it('watches no chat it answered while it was being called away, though that reply was finished first', async () => {
		const { brain, log, conversation, message, close } = start({ now: away!.start - 10_000 });
		vi.spyOn(brain, 'compose').mockResolvedValueOnce({ messages: ['x'.repeat(70)], action: 'none' });
		try {
			// Typed until 15 s into the interruption, which the tick meets 20 s in
			await message('hi');
			await vi.advanceTimersByTimeAsync(away!.start + 30_000 - Date.now());
			expect(conversation.send).toHaveBeenCalledTimes(1);
			await message('so?');
			expect(logged(log, 'reply_scheduled').at(-1)).toMatchObject({ watching: false });
		} finally {
			close();
		}
	});

	it('finishes a reply it was typing when it is called away', async () => {
		const { brain, conversation, message, close } = start({ now: away!.start - 10_000 });
		vi.spyOn(brain, 'compose').mockResolvedValue({ messages: ['x'.repeat(70)], action: 'none' });
		let sentAt = 0;
		conversation.send.mockImplementation(async () => void (sentAt = Date.now()));
		try {
			// Due 4 s later, read for 1 s, typed for 20.4 s: sent after the interruption began
			await message('hi');
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(sentAt).toBe(away!.start - 10_000 + 25_400);
			expect(sentAt).toBeGreaterThan(away!.start);
		} finally {
			close();
		}
	});
});

describe('who goes first when several are due (pacing.priority)', () => {
	/**
	 * Ana writes at 20:00 and her turn, due 52 s later (rng 0.6), is held until the test lets it go; Bo writes at 60 s,
	 * Cy at 70 s, while it is on its phone with her: both are due within seconds, while Ana's turn is under way.
	 */
	const three = async ({ settings, decisions }: { settings?: Settings; decisions?: Decisions } = {}) => {
		const run = start({ settings, decisions, rng: () => 0.6 });
		const gate = held<void>();
		const order: number[] = [];
		vi.spyOn(run.brain, 'compose').mockImplementation(async (personId) => {
			order.push(personId);
			if (personId === 1) await gate.promise;
			return { messages: [], action: 'none' };
		});
		for (const [from, after] of [['ana', 0], ['bo', 60_000], ['cy', 70_000]] as const) {
			await vi.advanceTimersByTimeAsync(EVENING + after - Date.now());
			await run.message('hi', from);
		}
		await vi.advanceTimersByTimeAsync(EVENING + 2 * MINUTE - Date.now());
		return { ...run, gate, order };
	};

	it('picks by weight: a conversation that matters more goes first', async () => {
		for (const [importance, first] of [[3, 2], [1, 3]] as const) {
			const run = await three();
			try {
				// Bo (person 2) says something that matters a lot; with no difference, rng 0.6 picks Cy, the second due
				run.store.updatePerson(2, { importance, importanceAt: Date.now() });
				run.gate.resolve();
				await vi.advanceTimersByTimeAsync(MINUTE);
				expect(run.order.slice(0, 2)).toEqual([1, first]);
				expect(logged(run.log, 'reply_picked')[0]).toMatchObject({ personId: first, among: 2 });
			} finally {
				run.close();
			}
		}
	});

	it('takes them in the order they came due with weighted off', async () => {
		const run = await three({ settings: settingsOf({ pacing: { priority: { weighted: false } } }) });
		try {
			run.store.updatePerson(3, { importance: 3, importanceAt: Date.now(), familiarity: 0.9 });
			run.gate.resolve();
			await vi.advanceTimersByTimeAsync(MINUTE);
			expect(run.order).toEqual([1, 2, 3]);
			expect(logged(run.log, 'reply_picked')).toEqual([]);
		} finally {
			run.close();
		}
	});

	it('asks how much their messages matter as their turn comes due while it is busy, once per newest message', async () => {
		const decisions = createScriptedDecisions((question) => (question.name === 'conversation_importance' ? 3 : 0));
		const run = await three({ decisions });
		try {
			// Bo and Cy came due while Ana's turn was under way: each asked once, ahead of their turn
			expect(decisions.calls.filter((call) => call.names.includes('conversation_importance'))).toHaveLength(2);
			expect([2, 3].map((id) => run.store.personById(id).importance)).toEqual([3, 3]);
		} finally {
			run.close();
		}
	});
});

describe('people waiting in line', () => {
	/** Ana's turn is under way and held by the test until `gate` is resolved; `order` lists who composed. */
	const busyWithAna = async (run: ReturnType<typeof start>) => {
		const gate = held<void>();
		const order: [number, number][] = [];
		vi.spyOn(run.brain, 'compose').mockImplementation(async (personId) => {
			order.push([personId, Date.now() - EVENING]);
			if (personId === 1) await gate.promise;
			return { messages: ['ok'], action: 'none' };
		});
		await run.message('hi', 'ana');
		await vi.advanceTimersByTimeAsync(10_000);
		expect(order).toEqual([[1, 4_000]]);
		return { gate, order };
	};

	it('sends someone due who writes again back to their quiet, and answers both messages in one reply', async () => {
		const run = start();
		const { gate, order } = await busyWithAna(run);
		try {
			// Bo is due at 12 s, in line behind Ana
			await run.message('hey', 'bo');
			await vi.advanceTimersByTimeAsync(2_000);
			// He writes again at 14 s: his quiet runs to 16 s. Ana's reply ends at 15 s
			await vi.advanceTimersByTimeAsync(2_000);
			await run.message('also', 'bo');
			gate.resolve();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(order).toEqual([[1, 4_000], [2, 16_000]]);
			expect(run.store.personById(2).handledAt).toBe(run.store.personById(2).lastInAt);
			expect(sentTo(run.store, 2)).toEqual(['ok']);
		} finally {
			run.close();
		}
	});

	it("parks everyone in line when the halt switch goes on, and answers them from the backlog once it is off", async () => {
		const run = start();
		const { gate } = await busyWithAna(run);
		try {
			await run.message('hey', 'bo');
			await vi.advanceTimersByTimeAsync(4_000);
			run.halt(true);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(5_000);
			// Nothing went out; both wait for HALT to end
			expect(run.conversation.send).not.toHaveBeenCalled();
			expect(logged(run.log, 'reply_waiting').map((detail) => [detail.personId, detail.reason])).toEqual([[1, 'halt_switch'], [2, 'halt_switch']]);
			run.halt(false);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(sentTo(run.store, 1)).toEqual(['ok']);
			expect(sentTo(run.store, 2)).toEqual(['ok']);
		} finally {
			run.close();
		}
	});

	it('does not write a reply again for someone who asks to stop meanwhile, and only says goodbye', async () => {
		const run = start();
		const gate = held<void>();
		const compose = vi.spyOn(run.brain, 'compose').mockImplementation(async () => {
			await gate.promise;
			return { messages: ['the draft'], action: 'none' };
		});
		try {
			await run.message('hi');
			await vi.advanceTimersByTimeAsync(6_000);
			// It will start over for this one…
			await run.message('wait');
			// …but they ask to stop before it does
			const goodbye = run.message('please stop messaging me');
			gate.resolve();
			await vi.advanceTimersByTimeAsync(MINUTE);
			await goodbye;
			expect(compose).toHaveBeenCalledTimes(1);
			expect(run.conversation.send.mock.calls).toEqual([[STOP_ACK]]);
			expect(run.store.personById(1).state).toBe('stopped');
		} finally {
			run.close();
		}
	});

	it('keeps a draft it dropped owed through the halt switch, and writes the reply again after it', async () => {
		const run = start();
		const gate = held<void>();
		const compose = vi.spyOn(run.brain, 'compose').mockImplementation(async () => {
			if (compose.mock.calls.length === 1) await gate.promise;
			return { messages: [`draft ${compose.mock.calls.length}`], action: 'none' };
		});
		try {
			await run.message('hi');
			await vi.advanceTimersByTimeAsync(6_000);
			await run.message('wait');
			run.halt(true);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			// Nothing of the first draft went out, and nothing new started while halted
			expect(run.conversation.send).not.toHaveBeenCalled();
			expect(compose).toHaveBeenCalledTimes(1);
			run.halt(false);
			await vi.advanceTimersByTimeAsync(10 * MINUTE);
			expect(sentTo(run.store)).toEqual(['draft 2']);
			expect(run.store.personById(1).handledAt).toBe(run.store.personById(1).lastInAt);
		} finally {
			run.close();
		}
	});

	it('draws the next in line in proportion to their weight: a conversation that matters goes first about two times in three', async () => {
		// Bo rated 3 (weighs about 3.9 after a couple of minutes), Cy 1 (weighs 2); everything else is equal
		const settings = settingsOf({ pacing: { glance: { delaySeconds: [4, 60] }, interruptions: { meanMinutes: 0 }, burst: { settleSeconds: [0, 0] } } });
		let bo = 0;
		const trials = 300;
		for (let trial = 0; trial < trials; trial++) {
			const run = start({ settings, rng: seededRng(`pick-${trial}`) });
			const gate = held<void>();
			const order: number[] = [];
			vi.spyOn(run.brain, 'compose').mockImplementation(async (personId) => {
				order.push(personId);
				if (personId === 1) await gate.promise;
				return { messages: [], action: 'none' };
			});
			try {
				await run.message('hi', 'ana');
				while (!order.length) await vi.advanceTimersByTimeAsync(1_000);
				// It is on its phone with Ana: both are noticed within seconds, while her turn goes on
				await run.message('hey', 'bo');
				await run.message('hey', 'cy');
				run.store.updatePerson(2, { importance: 3, importanceAt: Date.now() });
				run.store.updatePerson(3, { importance: 1, importanceAt: Date.now() });
				await vi.advanceTimersByTimeAsync(2 * MINUTE);
				gate.resolve();
				await vi.advanceTimersByTimeAsync(5_000);
				expect(order.slice(0, 2).length).toBe(2);
				if (order[1] === 2) bo++;
			} finally {
				run.close();
			}
			vi.useRealTimers();
		}
		// 0.66 expected, 0.027 a standard deviation
		expect(bo / trials).toBeGreaterThan(0.57);
		expect(bo / trials).toBeLessThan(0.75);
	});
});
