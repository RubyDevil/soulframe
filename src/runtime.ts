import { existsSync } from 'node:fs';
import { inspect } from 'node:util';
import { unhandled, type Brain, type Decision, type PersonAction, type Turn } from './brain.js';
import type { Channel, ChannelId } from './channel.js';
import { LlmBudgetError, ModelNotConfiguredError, ProviderUnavailableError } from './llm.js';
import type { PersonaConfig } from './config/personas.js';
import { betweenMessagesMs, fitDelay, interruptedBetween, interruptionAt, quietMs, readingMs, replyDelay, typingPlan, watchingMs } from './pacing.js';
import { between, sleep, type Rng } from './rng.js';
import { nextSpan, spanAt, type Hours, type Span } from './schedule.js';
import { MINUTE, SECOND } from './settings.js';
import type { Person, PersonState, Store } from './store.js';

/** What every persona module shares: the clock, randomness, the store, the halt switch and logging (settings are each persona's own, persona.settings). */
export interface Runtime {
	now: () => number;
	rng: Rng;
	store: Store;
	dryRun: boolean;
	/** True while the halt file exists: nothing is sent, nothing new is started. */
	halted: () => boolean;
	log: (persona: string, event: string, detail?: Record<string, unknown>) => void;
}

export function createRuntime({
	store,
	dryRun,
	haltFile,
	rng = Math.random,
	now = Date.now,
}: {
	store: Store;
	dryRun: boolean;
	haltFile: string;
	rng?: Rng;
	now?: () => number;
}): Runtime {
	return {
		now,
		rng,
		store,
		dryRun,
		halted: () => existsSync(haltFile),
		log(persona, event, detail = {}) {
			const fields = Object.entries(detail).map(([key, value]) => {
				const text = typeof value === 'string' ? value : inspect(value, { depth: null, compact: true, breakLength: 100, colors: false });
				return `  ${key}: ${text.replace(/\r?\n/g, '\n    ')}`;
			});
			console.log([`[${new Date(now()).toISOString()}] ${persona} | ${event.replaceAll('_', ' ')}`, ...fields].join('\n'));
		},
	};
}

/** The person can't be messaged there any more (they blocked the persona or closed their DMs). */
export class UnreachableError extends Error {
	constructor(readonly code: string) {
		super(`Unreachable: ${code}`);
	}
}

/** Where a reply goes: shows typing, then sends one message (rejecting with `UnreachableError` once that can't be done any more). */
export interface Conversation {
	/** Where it happens: the brain is told its where-text, notes, limit, invitations and actions; its id keys hours and identities. */
	channel: Channel;
	/** Shows (`true`) or ends (`false`) the typing indicator: each stretch of typing, its `true` repeated or not, ends with one `false`. */
	typing(on: boolean): Promise<void>;
	/**
	 * How long one `typing(true)` shows on the platform, in ms, when its indicator expires (a few seconds on most): while a
	 * message is typed, the queue calls `typing(true)` again at this rhythm. Left out, once per stretch of typing.
	 */
	typingRefreshMs?: number;
	/**
	 * Shows the person their messages were read (a read receipt): called once per reply, when the reading starts, which
	 * lasts as long as `pacing.readingCharsPerSecond` says before the first message is typed. A rejection counts as a
	 * failed delivery, as `typing`'s.
	 */
	markRead?(): Promise<void>;
	send(text: string): Promise<void>;
	/** A message of a reply went out (`send` resolved), or a dry run logged it in place of sending: for the app's own bookkeeping on what was said. */
	delivered?(text: string): void;
	/** Lines the app adds to each DM turn here, given the person as compose reads them: after the notes on them, before any invitation and the time. */
	extraLines?(person: Person): readonly string[];
	/** A pending group-chat invitation (its name, and how to join), attached only where the app allows joining; heeded only where `channel.invitations`. */
	invitation?: { name: string; join(): Promise<void> };
}

/** The person ended the conversation (asked to stop, can't be reached, or was deny-listed). */
const endedIt = (state: PersonState) => state === 'stopped' || state === 'denied';

/** How long before the persona was last online a restart still looks for people owed a turn. */
const BACKLOG_LOOKBACK = 48 * 60 * MINUTE;
/** A reply is due at least this long before its span ends, or it waits for the next span. */
const SPAN_END_MARGIN = 90 * SECOND;
/** A turn under way for longer than this no longer holds the others back: a send that never returned must not silence the persona. */
const PRESENCE_LEASE = 10 * MINUTE;

/** How a reply ended: sent in full, paused (the halt switch, the queue stopped), ended by them, dropped for a newer message of theirs, or a send that failed. */
type Stop = 'done' | 'halt_switch' | 'stopped' | 'ended' | 'superseded' | 'unreachable' | 'failed';

/** A turn under way. */
interface TurnState {
	/** When it started: past PRESENCE_LEASE it no longer holds the others back. */
	readonly since: number;
	/** Their newest message the draft being written read. */
	through: number;
	/** Messages of the reply sent so far. */
	sent: number;
	/** The draft is being written or typed, its first message not sent yet: a newer message of theirs may make it start over. */
	writing: boolean;
	/** It starts over: a message of theirs came in while it was writing (`pacing.burst.restartOnNewMessage`). */
	superseded: boolean;
	/** How many times it started over. */
	restarts: number;
	/** Saves what the draft being sent wrote and decided (`Turn.keep`): once its first message is sent, or once it is committed. */
	keep?: () => void;
}

/**
 * Answers people at a human pace, one person at a time: while it writes or sends a reply to someone it starts nobody
 * else's, so what one turn learns about itself is never overwritten by another (self notes are read when a turn starts
 * and written when it ends). One turn per person at a time: more messages from them while it waits are answered
 * together. While a span is open on their channel, a turn is due after a random delay (only quick ones on a short break)
 * that ends before the span does, and once they stopped writing (`pacing.burst`); due turns start as soon as the persona
 * is free, in the order they came due. Otherwise they wait in the backlog, answered once a span opens: one person at a
 * time, oldest first, with a pause before each. It reads their messages while it writes, and types each message for a
 * time proportional to it.
 */
export function createReplyQueue({
	persona,
	brain,
	runtime,
	act,
}: {
	persona: PersonaConfig;
	brain: Brain;
	runtime: Runtime;
	/**
	 * Carries out what the persona chose besides talking (never "none"): "block", or one of the channel's `actions`; the app
	 * routes it by the person's identities (where it can't block, not answering is the block).
	 */
	act: (personId: number, action: PersonAction) => Promise<void>;
}) {
	const { retries, pacing } = persona.settings;
	const { burst } = pacing;
	/** By person: the timer of a turn's delay, a retry or a backlog gap. */
	const pending = new Map<number, NodeJS.Timeout>();
	/** The backlog: people owed a turn while no span was open for it, oldest first. */
	const waiting = new Map<number, Conversation>();
	/** Due while they were still writing: due once their quiet ends. */
	const settling = new Map<number, Conversation>();
	/** Due, in the order they came due: the first starts as soon as the persona is free. */
	const ready = new Map<number, Conversation>();
	/** The quiet each is given after their newest message (`pacing.burst`): its timer, how many messages started it again, and what waits for its end. */
	const quiet = new Map<number, { timer: NodeJS.Timeout; resets: number; ended: (() => void)[] }>();
	/** Turns under way, by person: one at a time, but for one stuck past PRESENCE_LEASE. */
	const active = new Map<number, TurnState>();
	/** The turn the others wait for, until it has run PRESENCE_LEASE. */
	let present: TurnState | null = null;
	/** Lets the others go once that turn has run PRESENCE_LEASE. */
	let lease: NodeJS.Timeout | undefined;
	/** A message that came in during their turn, too late for it to start over: their next turn comes once this one ends. */
	const owedAfter = new Map<number, Conversation>();
	/** When its last turn with each person ended: it may still be watching their chat (`pacing.watching`). */
	const lastWith = new Map<number, number>();
	/** The start of the interruption it was last found in (`pacing.interruptions`), and the timer that moves the queue on as it ends. */
	let awayFrom: number | null = null;
	let comeback: NodeJS.Timeout | undefined;
	/** The backlog turn in progress (one at a time), and the start of the span it was taken in. */
	let drainingId: number | null = null;
	let drainSpanStart: number | null = null;
	const invitations = new Map<number, NonNullable<Conversation['invitation']>>();
	/** Failed attempts at the pending answer, by person. */
	const failures = new Map<number, number>();
	/** Tries at the pending answer that found the provider down, by person: each doubles the next wait, up to 16 times. */
	const providerWaits = new Map<number, number>();
	/** The oldest message `requeue` answers, read before `start`'s tick records a new time. */
	const backlogSince = Number(runtime.store.get(persona.id, 'lastOnlineAt') ?? runtime.now()) - BACKLOG_LOOKBACK;
	let tick: NodeJS.Timeout | undefined;
	/** Set by `stop` (the app's, after a start that failed, say): a turn under way sends nothing more and nothing is timed or parked again, so whoever it was for is still owed at the next start. */
	let stopped = false;
	/** Why nothing may be sent or started now, if so: the queue stopped, or the halt switch. */
	const paused = () => (stopped ? 'stopped' : runtime.halted() ? 'halt_switch' : null);
	/** A turn is under way, and not for so long that it must be stuck (it stops holding the others back after PRESENCE_LEASE). */
	const occupied = () => present !== null && runtime.now() - present.since < PRESENCE_LEASE;

	/**
	 * Whether something took it away from its messages now (`pacing.interruptions`): no turn starts until it is back.
	 * The first time an interruption is found it is logged, and the queue moves on as it ends.
	 */
	const away = () => {
		const now = runtime.now();
		const interruption = interruptionAt(persona, now, pacing);
		if (!interruption) return false;
		if (awayFrom !== interruption.start) {
			awayFrom = interruption.start;
			runtime.log(persona.id, 'away', { until: new Date(interruption.end).toISOString() });
			clearTimeout(comeback);
			comeback = setTimeout(() => {
				drain();
				next();
			}, interruption.end - now);
		}
		return true;
	};

	/** A send or read receipt that failed: someone it can no longer reach is stopped for good, anything else logged. */
	const failedDelivery = (error: unknown, personId: number, channel: ChannelId, sent: number): 'unreachable' | 'failed' => {
		if (error instanceof UnreachableError) {
			// A goodbye refused keeps them denied or blocked
			if (runtime.store.personById(personId).state === 'active') runtime.store.updatePerson(personId, { state: 'stopped' });
			runtime.log(persona.id, 'unreachable', { personId, platform: channel, code: error.code });
			return 'unreachable';
		}
		runtime.log(persona.id, 'delivery_failed', { personId, platform: channel, sent, error: String(error) });
		return 'failed';
	};

	/** Whether a reply goes on ('done') or why not: paused, no longer `stillWanted`, or its draft starts over for a newer message (`state.superseded`). */
	const cutFor =
		(state: TurnState | undefined, stillWanted: () => boolean) =>
		(): Stop =>
			paused() ?? (!stillWanted() ? 'ended' : state?.superseded ? 'superseded' : 'done');

	/**
	 * Sends the messages in order, typing before each, and records each one once sent (a dry run only logs it); either
	 * way the conversation is told it was `delivered`. With `markRead`, their messages are shown read first (the code's
	 * goodbye: a turn shows them read while it writes). The rest is dropped once paused, no longer `stillWanted`, or the
	 * draft is to start over (`state.superseded`, before its first message), checked again after each wait, or once a send
	 * fails: that is never retried, since a send that timed out may still have landed. The first message sent keeps the
	 * turn (`state.keep`). Typing always ends, sent or not. Answers how many went out and why it stopped.
	 */
	const deliver = async (
		conversation: Conversation,
		messages: string[],
		personId: number,
		{ stillWanted = () => true, state, markRead = false }: { stillWanted?: () => boolean; state?: TurnState; markRead?: boolean } = {},
	) => {
		const channel = conversation.channel.id;
		const cut = cutFor(state, stillWanted);
		/** Waits `ms`, then answers whether the reply goes on ('done') or why not. */
		const wait = async (ms: number) => {
			await sleep(ms);
			return cut();
		};
		let typingShown = false;
		const typing = async (on: boolean) => {
			typingShown = on;
			await conversation.typing(on);
		};
		/** Typing on for `ms`, shown again every `typingRefreshMs` (when the conversation needs it); answers as `wait`. */
		const typeFor = async (ms: number) => {
			const every = conversation.typingRefreshMs ?? 0;
			let left = ms;
			for (; every > 0 && left > every; left -= every) {
				const reason = await wait(every);
				if (reason !== 'done') return reason;
				await typing(true);
			}
			return wait(left);
		};
		/** Types `text` as `typingPlan` says: stretches of typing, with typing off for each thinking pause between them; answers as `wait`. */
		const typeOut = async (text: string) => {
			const plan = typingPlan(text, runtime.rng, pacing);
			await typing(true);
			let reason: Stop = await typeFor(plan.typing[0]!);
			for (const [i, pause] of plan.pauses.entries()) {
				if (reason !== 'done') break;
				await typing(false);
				if ((reason = await wait(pause)) !== 'done') break;
				await typing(true);
				reason = await typeFor(plan.typing[i + 1]!);
			}
			return reason;
		};
		let sent = 0;
		let stop: Stop = 'done';
		for (const text of messages) {
			if (sent) await sleep(betweenMessagesMs(runtime.rng, pacing));
			if ((stop = cut()) !== 'done') break;
			try {
				// Once, before the first message is typed (nothing follows a failed one)
				if (!sent && markRead) await conversation.markRead?.();
				if ((stop = await typeOut(text)) !== 'done') break;
				if (runtime.dryRun) runtime.log(persona.id, 'dry_send', { personId, platform: channel, text });
				else {
					await conversation.send(text);
					runtime.store.addMessage(personId, channel, 'out', text);
					runtime.log(persona.id, 'dm_sent', { personId, platform: channel, text });
				}
				conversation.delivered?.(text);
				sent++;
				if (state) {
					// Something went out: the turn is kept, and no newer message makes it start over now
					state.sent = sent;
					state.writing = false;
					state.keep?.();
				}
			} catch (error) {
				stop = failedDelivery(error, personId, channel, sent);
				break;
			} finally {
				if (typingShown) await typing(false);
			}
		}
		if (stop === 'halt_switch' || stop === 'stopped' || stop === 'ended') runtime.log(persona.id, 'reply_cancelled', { personId, platform: channel, sent, unsent: messages.length - sent, reason: stop });
		else if (stop === 'done') {
			if (!runtime.dryRun) runtime.store.audit(persona.id, 'sent', { personId, platform: channel, messages: messages.length });
			runtime.log(persona.id, 'reply_sent', { personId, platform: channel, messages: messages.length, dryRun: runtime.dryRun });
		}
		return { sent, stop };
	};

	/**
	 * What a turn does while the model writes: shows their messages read (`markRead`), then reads `chars` characters for
	 * as long as that takes. Answers as `deliver`'s waits, or 'failed' / 'unreachable' when the read receipt was refused.
	 */
	const read = async (conversation: Conversation, personId: number, chars: number, cut: () => Stop): Promise<Stop> => {
		try {
			await conversation.markRead?.();
		} catch (error) {
			return failedDelivery(error, personId, conversation.channel.id, 0);
		}
		await sleep(readingMs(chars, runtime.rng, pacing));
		return cut();
	};

	/** Resolves once they have been quiet for their `pacing.burst.settleSeconds` (at once when they are, or once stopped). */
	const quietEnd = (personId: number) =>
		new Promise<void>((resolve) => {
			const entry = quiet.get(personId);
			if (entry && !stopped) entry.ended.push(resolve);
			else resolve();
		});

	/**
	 * A message of theirs came in, while a span is open on its channel: the quiet after it starts, or starts again while one
	 * runs, at most `burst.maxSettleResets` times (past them it ends as it was, so someone who never stops still gets a
	 * reply). A turn due meanwhile waits for its end.
	 */
	const heard = (personId: number, channel: ChannelId) => {
		if (stopped || !spanAt(persona, runtime.now(), channel)) return;
		const current = quiet.get(personId);
		if (current && current.resets >= burst.maxSettleResets) return;
		const ms = quietMs(runtime.rng, pacing);
		if (ms <= 0) return;
		if (current) clearTimeout(current.timer);
		quiet.set(personId, { timer: setTimeout(() => quieted(personId), ms), resets: current ? current.resets + 1 : 0, ended: current?.ended ?? [] });
	};

	/** Their quiet is over: what waited for it goes on, a turn that came due meanwhile first. */
	const quieted = (personId: number) => {
		const entry = quiet.get(personId);
		quiet.delete(personId);
		for (const resolve of entry?.ended ?? []) resolve();
		const conversation = settling.get(personId);
		if (!conversation) return;
		settling.delete(personId);
		due(personId, conversation);
	};

	/** Into the backlog after the halt switch, logged. */
	const haltPark = (personId: number, conversation: Conversation) => {
		runtime.log(persona.id, 'reply_paused', { personId, platform: conversation.channel.id, reason: 'halt_switch' });
		park(personId, conversation, 'halt_switch');
	};

	/** A turn that is due: while a span is open on its channel, ready once they stopped writing; else back into the backlog. */
	const due = (personId: number, conversation: Conversation) => {
		pending.delete(personId);
		if (runtime.halted()) return haltPark(personId, conversation);
		if (!spanAt(persona, runtime.now(), conversation.channel.id)) return park(personId, conversation, 'offline');
		// Still writing: due once they stop
		if (quiet.has(personId)) return void settling.set(personId, conversation);
		ready.set(personId, conversation);
		// An earlier turn of theirs is still under way (stuck): the backlog moves on meanwhile
		if (active.has(personId)) release(personId);
		next();
	};

	/**
	 * Starts the first ready turn once the persona is free (no turn under way, or one past PRESENCE_LEASE). Anyone whose span
	 * closed while they waited goes back into the backlog, and while halted everyone does; someone writing again waits for
	 * their quiet once more.
	 */
	const next = () => {
		if (stopped || occupied() || (ready.size && away())) return;
		for (const [personId, conversation] of ready) {
			// Their earlier turn, stuck past PRESENCE_LEASE, is still under way: this one waits for it to end
			if (active.has(personId)) continue;
			ready.delete(personId);
			if (runtime.halted()) haltPark(personId, conversation);
			else if (!spanAt(persona, runtime.now(), conversation.channel.id)) park(personId, conversation, 'offline');
			else if (quiet.has(personId)) settling.set(personId, conversation);
			else return void answer(personId, conversation);
		}
	};

	/** One turn under way: the others wait until it ends (or has run PRESENCE_LEASE), then the next starts. */
	const answer = async (personId: number, conversation: Conversation) => {
		const state: TurnState = { since: runtime.now(), through: 0, sent: 0, writing: false, superseded: false, restarts: 0 };
		active.set(personId, state);
		present = state;
		clearTimeout(lease);
		lease = setTimeout(next, PRESENCE_LEASE);
		try {
			await turn(personId, conversation, state);
		} catch (error) {
			runtime.log(persona.id, 'delivery_failed', { personId, error: String(error) });
		} finally {
			active.delete(personId);
			lastWith.set(personId, runtime.now());
			if (present === state) {
				present = null;
				clearTimeout(lease);
			}
			// A message that came in too late for this turn gets its own, unless a draft written after it read it
			const later = owedAfter.get(personId);
			owedAfter.delete(personId);
			const person = runtime.store.personById(personId);
			if (later && person.state === 'active' && person.lastInAt > state.through) schedule(personId, later);
			release(personId);
			next();
		}
	};

	/**
	 * The turn starts over for a newer message of theirs: the draft is dropped (nothing of it was sent or kept), and it waits
	 * for the quiet after their newest message. Answers whether to write it again: not once they ended it, nor once paused
	 * (still owed, as before a first send: after HALT back in the backlog unless a newer message's turn is coming).
	 */
	const restart = async (personId: number, conversation: Conversation, state: TurnState) => {
		state.superseded = false;
		state.writing = false;
		state.keep = undefined;
		state.restarts++;
		runtime.log(persona.id, 'reply_restarted', { personId, platform: conversation.channel.id, restarts: state.restarts });
		await quietEnd(personId);
		if (endedIt(runtime.store.personById(personId).state)) return false;
		const pause = paused();
		if (pause === 'halt_switch' && !queued(personId)) park(personId, conversation, 'halt_switch');
		return !pause;
	};

	/**
	 * Composes their turn and carries it out: the reply, the persona's action, an invitation it accepted. Their messages are
	 * read while the model writes; one that comes in before the first message is sent makes the draft start over while it
	 * may (`pacing.burst`). The turn is committed (their messages it answered marked handled, what it wrote kept) once its
	 * delivery was attempted: sent, failed or cut short. Only a turn paused before its first send stays owed: back in the
	 * backlog after HALT, for the next start after `stop`; one cut by a restart before its delivery ended is queued again
	 * at the next start. Nothing more is carried out once paused. The history holds only what was actually sent. A dry
	 * run marks nothing handled.
	 */
	const turn = async (personId: number, conversation: Conversation, state: TurnState) => {
		const channel = conversation.channel.id;
		const invitation = conversation.channel.invitations ? invitations.get(personId) : undefined;
		// Anything but the code's goodbye is dropped once they end it meanwhile (a block the persona chose still sends its reply)
		const stillWanted = () => !endedIt(runtime.store.personById(personId).state);
		const cut = cutFor(state, stillWanted);
		/** Their messages up to this time were read by an earlier draft of this turn. */
		let readUpTo = 0;
		for (;;) {
			// Their newest message the model sees: compose reads them before its first wait
			const { lastInAt: through, handledAt } = runtime.store.personById(personId);
			state.through = through;
			state.writing = true;
			/** What there is to read: their messages this turn answers, together, but for those an earlier draft read. */
			const readChars = unhandled(runtime.store.history(personId, persona.settings.memory.historyMessages), Math.max(handledAt, readUpTo)).reduce((sum, m) => sum + m.text.length, 0);
			readUpTo = through;
			runtime.log(persona.id, 'reply_processing', { personId, platform: channel });
			// It reads them while the model writes
			const reading = read(conversation, personId, readChars, cut);
			let composed: Turn;
			try {
				composed = await brain.compose(personId, conversation.channel, { invitation: invitation?.name, extraLines: conversation.extraLines });
				failures.delete(personId);
				providerWaits.delete(personId);
			} catch (error) {
				// The turn ends here, its reading left to finish on its own: the next try is timed from now, and the next person need not wait
				state.writing = false;
				void reading;
				// A message that was to make it start over gets a turn of its own, if no retry answers it
				if (state.superseded) owedAfter.set(personId, conversation);
				// A stopped queue tries nothing again: they are still owed at the next start
				if (!stopped) retry(personId, conversation, error, through);
				return;
			}
			const readStop = await reading;
			if (state.superseded && !composed.final) {
				if (await restart(personId, conversation, state)) continue;
				return;
			}
			// The code's goodbye never starts over
			if (composed.final) Object.assign(state, { superseded: false, writing: false });
			state.keep = composed.keep;
			/** Those messages had their turn (one that came in meanwhile is still owed), and so had the invitation, unless it waits for full online time; what it wrote is kept. */
			const commit = () => {
				state.writing = false;
				if (!runtime.dryRun) runtime.store.updatePerson(personId, { handledAt: through });
				if (!composed.inviteWaits && invitations.get(personId) === invitation) invitations.delete(personId);
				composed.keep?.();
			};
			if (composed.messages.length) {
				const { sent, stop } =
					readStop === 'failed' || readStop === 'unreachable'
						? { sent: 0, stop: readStop }
						: await deliver(conversation, composed.messages, personId, { stillWanted: composed.final ? undefined : stillWanted, state });
				if (stop === 'superseded') {
					if (await restart(personId, conversation, state)) continue;
					return;
				}
				if ((stop === 'halt_switch' || stop === 'stopped') && !sent && runtime.store.personById(personId).state === 'active') {
					state.writing = false;
					// Paused before anything went out: still owed, invitation and all; after HALT back in the backlog unless a newer message's turn is coming
					if (!queued(personId)) park(personId, conversation, 'halt_switch');
					return;
				}
				commit();
			} else {
				commit();
				runtime.store.audit(persona.id, 'left_on_read', { personId, platform: channel });
				runtime.log(persona.id, 'reply_skipped', { personId, platform: channel, reason: 'no_reply' });
			}
			const pause = paused();
			if (composed.action !== 'none') {
				// The store has it already (keep ends the conversation on a block), but nothing new starts on the channel
				if (pause) runtime.log(persona.id, 'action_skipped', { personId, action: composed.action, reason: pause });
				else if (runtime.dryRun) runtime.log(persona.id, `dry_${composed.action}`, { personId });
				else await act(personId, composed.action);
			}
			if (invitation && composed.acceptInvite && composed.action === 'none' && !pause && stillWanted()) {
				runtime.log(persona.id, 'invite_accepted', { personId, invitation: invitation.name, dryRun: runtime.dryRun });
				if (!runtime.dryRun) await invitation.join();
			} else if (invitation) runtime.log(persona.id, 'invite_not_joined', { personId, invitation: invitation.name });
			return;
		}
	};

	/**
	 * The person is still waiting for an answer the model failed to give: try again later rather than drop it. A spent
	 * budget or a provider outage counts no attempt: they are answered once it is over. Through an outage each wait is
	 * twice the one before, up to 16 times retries.delayMinutes, so a long one costs a few tries an hour. Given up, the
	 * messages it tried to answer (`through` the newest) are marked handled, as a turn commits them. A model the settings
	 * don't name (`ModelNotConfiguredError`) fails alike until they change, which takes a restart: given up at once, and
	 * still owed at the next start.
	 */
	const retry = (personId: number, conversation: Conversation, error: unknown, through: number) => {
		if (error instanceof LlmBudgetError) {
			runtime.log(persona.id, 'reply_waiting_budget', { personId });
			return schedule(personId, conversation, retries.budgetCheckMinutes * MINUTE);
		}
		if (error instanceof ProviderUnavailableError) {
			const waits = providerWaits.get(personId) ?? 0;
			providerWaits.set(personId, waits + 1);
			runtime.log(persona.id, 'reply_waiting_provider', { personId, error: String(error) });
			return schedule(personId, conversation, between(runtime.rng, ...retries.delayMinutes) * MINUTE * Math.min(2 ** waits, 16));
		}
		const attempt = (failures.get(personId) ?? 0) + 1;
		runtime.log(persona.id, 'reply_failed', { personId, attempt, error: String(error) });
		const unconfigured = error instanceof ModelNotConfiguredError;
		if (attempt < retries.attempts && !unconfigured) {
			failures.set(personId, attempt);
			schedule(personId, conversation, between(runtime.rng, ...retries.delayMinutes) * MINUTE * attempt);
		} else {
			failures.delete(personId);
			providerWaits.delete(personId);
			// Given up: not tried again at the next start either (a dry run marks nothing); one that came in meanwhile has its own turn
			if (!runtime.dryRun && !unconfigured) runtime.store.updatePerson(personId, { handledAt: through });
			runtime.store.audit(persona.id, 'reply_given_up', { personId, platform: conversation.channel.id, attempts: attempt, ...(unconfigured && { reason: 'model_not_configured' }) });
		}
	};

	/** Their turn comes after `wait` ms (never once stopped); `watching`: timed as it still had their chat open. */
	const timeReply = (personId: number, conversation: Conversation, wait: number, reason: 'pacing' | 'retry' | 'backlog', watching?: boolean) => {
		if (stopped) return;
		// setTimeout holds at most about 24.8 days
		const delayMs = Math.round(Math.min(wait, 2_000_000_000));
		pending.set(personId, setTimeout(() => due(personId, conversation), delayMs));
		runtime.log(persona.id, 'reply_scheduled', {
			personId,
			platform: conversation.channel.id,
			delayMs,
			dueAt: new Date(runtime.now() + delayMs).toISOString(),
			reason,
			...(watching !== undefined && { watching }),
		});
	};

	/** Into the backlog: answered once a span with time for it is open on their channel (`drain`); never once stopped. A backlog turn parked again lets the next one start. */
	const park = (personId: number, conversation: Conversation, reason: 'offline' | 'span_ending' | 'halt_switch' | 'restart') => {
		if (stopped) return;
		waiting.set(personId, conversation);
		const next = nextSpan(persona, runtime.now(), { channel: conversation.channel.id });
		runtime.log(persona.id, 'reply_waiting', { personId, platform: conversation.channel.id, reason, backlog: waiting.size, nextOpenAt: next ? new Date(next.start).toISOString() : null });
		release(personId);
	};

	/** Starts the next backlog turn unless one is in progress: the oldest waiting person whose channel has a span open with time left for it. */
	const drain = () => {
		if (drainingId !== null || runtime.halted() || occupied() || (waiting.size && away())) return;
		const now = runtime.now();
		for (const [personId, conversation] of waiting) {
			const span = spanAt(persona, now, conversation.channel.id);
			if (!span) continue;
			// The first backlog reply of a span may wait longer, as someone just back
			const first = span.start !== drainSpanStart ? between(runtime.rng, ...pacing.returnOnlineReplyDelayMinutes) * MINUTE : 0;
			const delay = between(runtime.rng, ...pacing.backlogGapSeconds) * SECOND + first;
			if (now + delay > span.end - SPAN_END_MARGIN) continue;
			waiting.delete(personId);
			drainingId = personId;
			drainSpanStart = span.start;
			return timeReply(personId, conversation, delay, 'backlog');
		}
	};

	/** Their backlog turn is over, if they had one: the next may start. */
	const release = (personId: number) => {
		if (drainingId !== personId) return;
		drainingId = null;
		drain();
	};

	/** Their turn is already coming: timed, due, or in the backlog. */
	const queued = (personId: number) => pending.has(personId) || waiting.has(personId) || settling.has(personId) || ready.has(personId);

	/**
	 * Times their turn: after `delay` when given (a retry), else as pacing says while a span is open on their channel, else
	 * into the backlog. A turn already coming answers their newer messages too. During their turn under way, a newer
	 * message makes its draft start over while it may (`pacing.burst`), or else gets a turn of its own once that one ends.
	 */
	const schedule = (personId: number, conversation: Conversation, delay?: number) => {
		if (queued(personId)) {
			runtime.log(persona.id, 'reply_batched', { personId, platform: conversation.channel.id });
			return;
		}
		// A retry keeps its own delay; if no span is open by then, `due` parks it
		if (delay !== undefined) return timeReply(personId, conversation, delay, 'retry');
		const during = active.get(personId);
		if (during) {
			if (burst.restartOnNewMessage && during.writing && during.restarts < burst.maxRestarts) {
				if (!during.superseded) runtime.log(persona.id, 'reply_superseded', { personId, platform: conversation.channel.id });
				during.superseded = true;
			} else {
				owedAfter.set(personId, conversation);
				runtime.log(persona.id, 'reply_after_turn', { personId, platform: conversation.channel.id });
			}
			return;
		}
		const now = runtime.now();
		const span = spanAt(persona, now, conversation.channel.id);
		if (!span) return park(personId, conversation, 'offline');
		// It may still be watching their chat after its last turn with them, unless it was away since; on a short break it is on its phone anyway
		const last = lastWith.get(personId);
		const since = last !== undefined && !interruptedBetween(persona, last, now, pacing) ? now - last : null;
		const timing = span.kind === 'break' ? { ms: watchingMs(runtime.rng, pacing), watching: true } : replyDelay(runtime.rng, since, pacing);
		// Always due before the span ends
		const wait = fitDelay(timing.ms, span.end - SPAN_END_MARGIN - now, pacing.glance.delaySeconds[0] * SECOND);
		if (wait === null) park(personId, conversation, 'span_ending');
		else timeReply(personId, conversation, wait, 'pacing', timing.watching);
	};

	return {
		/** Acts on what the brain decided for an incoming message. */
		async handle(decision: Decision, conversation: Conversation, text: string) {
			runtime.log(persona.id, 'dm_received', {
				platform: conversation.channel.id,
				text,
				decision: decision.kind,
				...(decision.kind === 'ignore' ? { reason: decision.reason } : { personId: decision.person.id }),
			});
			if (decision.kind === 'ignore') return;
			const personId = decision.person.id;
			if (decision.kind === 'final') {
				invitations.delete(personId);
				waiting.delete(personId);
				settling.delete(personId);
				ready.delete(personId);
				owedAfter.delete(personId);
				const entry = quiet.get(personId);
				quiet.delete(personId);
				if (entry) clearTimeout(entry.timer);
				// A turn under way waiting for their quiet ends now: they ended it
				for (const resolve of entry?.ended ?? []) resolve();
				clearTimeout(pending.get(personId));
				pending.delete(personId);
				// A backlog turn it cancelled lets the next one start (one under way does as it ends)
				if (!active.has(personId)) release(personId);
				// A final answer goes out soon, in or out of hours: it ends the conversation. One cut by HALT is dropped: they are stopped or denied already
				await sleep(between(runtime.rng, 2_000, 10_000));
				await deliver(conversation, decision.messages, personId, { markRead: true });
				return;
			}
			if (conversation.invitation) invitations.set(personId, conversation.invitation);
			heard(personId, conversation.channel.id);
			schedule(personId, conversation);
		},
		schedule,
		/** Everyone who last wrote on `channel` and is still owed a turn since the persona was last online, into the backlog, oldest first. */
		async requeue(channel: ChannelId, conversationOf: (person: Person) => Promise<Conversation | null>) {
			for (const { person, channel: lastOn } of runtime.store.unanswered(persona.id, backlogSince)) {
				if (lastOn !== channel) continue;
				// null: they can't be reached there any more
				const conversation = await conversationOf(person);
				// Someone who wrote since the start already has their turn
				if (conversation && !queued(person.id) && !active.has(person.id)) park(person.id, conversation, 'restart');
			}
		},
		/**
		 * Once every channel is up: every 30 s, records when the persona was last online and answering (not halted, not a
		 * dry run), for the next start's backlogSince, and moves the backlog and the ready turns on. Once only, and never after `stop`.
		 */
		start() {
			if (tick || stopped) return;
			tick = setInterval(() => {
				const now = runtime.now();
				if (!runtime.dryRun && spanAt(persona, now) && !runtime.halted()) runtime.store.set(persona.id, 'lastOnlineAt', String(now));
				drain();
				next();
			}, 30_000);
		},
		stop() {
			stopped = true;
			clearInterval(tick);
			clearTimeout(lease);
			clearTimeout(comeback);
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
			// A turn waiting for someone's quiet goes on, to find the queue stopped
			for (const entry of quiet.values()) {
				clearTimeout(entry.timer);
				for (const resolve of entry.ended) resolve();
			}
			quiet.clear();
			waiting.clear();
			settling.clear();
			ready.clear();
			owedAfter.clear();
			drainingId = null;
			invitations.clear();
		},
	};
}

export type ReplyQueue = ReturnType<typeof createReplyQueue>;

/**
 * Calls `onChange(span)` once at start and whenever the span open on `channel` changes (checked every 30 seconds),
 * logging hours_open with its kind and end, or hours_closed with the next start there.
 */
export function watchSpans(hours: Hours, channel: ChannelId, runtime: Runtime, onChange: (span: Span | null) => void) {
	// Told apart by their start: a day's agenda drawn again gives equal spans, not the same objects
	let current: number | null | undefined;
	const check = () => {
		const at = runtime.now();
		const span = spanAt(hours, at, channel);
		if ((span?.start ?? null) === current) return;
		current = span?.start ?? null;
		const next = span ? null : nextSpan(hours, at, { channel });
		runtime.log(hours.id, span ? 'hours_open' : 'hours_closed', {
			platform: channel,
			...(span ? { kind: span.kind, closesAt: new Date(span.end).toISOString() } : { nextOpenAt: next ? new Date(next.start).toISOString() : null }),
		});
		onChange(span);
	};
	check();
	const timer = setInterval(check, 30_000);
	return () => clearInterval(timer);
}
