import { existsSync } from 'node:fs';
import { inspect } from 'node:util';
import type { Brain, Decision, PersonAction } from './brain.js';
import type { Channel, ChannelId } from './channel.js';
import { LlmBudgetError, ModelNotConfiguredError, ProviderUnavailableError } from './llm.js';
import type { PersonaConfig } from './config/personas.js';
import { betweenMessagesMs, fitDelay, quickReplyMs, readPauseMs, replyDelayMs, typingPlan } from './pacing.js';
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
	 * Shows the person their messages were read (a read receipt): called once per reply, before its first message is
	 * typed, which starts `pacing.readBeforeTypingSeconds` later. A rejection counts as a failed delivery, as `typing`'s.
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
/** A reply under way for longer than this no longer holds the others back (`pacing.singlePresence`): a send that never returned must not silence the persona. */
const PRESENCE_LEASE = 10 * MINUTE;

/**
 * Answers people at a human pace: one turn per person at a time (more messages from them while it waits are answered
 * together). While a span is open on their channel, after a random delay (only quick ones on a short break) that ends
 * before the span does. Otherwise they wait in the backlog, answered once a span opens: one person at a time, oldest
 * first, with a pause before each. The typing indicator shows for a time proportional to each message.
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
	const pending = new Map<number, NodeJS.Timeout>();
	/** The backlog: people owed a turn while no span was open for it, oldest first. */
	const waiting = new Map<number, Conversation>();
	const busy = new Set<number>();
	/** The backlog turn in progress (one at a time), and the start of the span it was taken in. */
	let drainingId: number | null = null;
	/** With `pacing.singlePresence`: who it is composing or sending a reply to, and since when. */
	let present: { personId: number; since: number } | null = null;
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
	/** Someone else's reply is under way, with `pacing.singlePresence`, and not for so long that it must be stuck (it stops blocking after PRESENCE_LEASE). */
	const occupied = () => present !== null && runtime.now() - present.since < PRESENCE_LEASE;
	const paused = () => (stopped ? 'stopped' : runtime.halted() ? 'halt_switch' : null);

	/**
	 * Sends the messages in order, typing before each, and records each one once sent (a dry run only logs it); either
	 * way the conversation is told it was `delivered`. With `markRead`, their messages are shown read before the first
	 * one is typed. The rest is dropped once paused or no longer `stillWanted`, checked again after each wait, or once a
	 * send fails: that is never retried, since a send that timed out may still have landed. Typing always ends, sent or
	 * not. Answers how many went out and why it stopped.
	 */
	const deliver = async (conversation: Conversation, messages: string[], personId: number, stillWanted = () => true) => {
		const channel = conversation.channel.id;
		const cut = () => paused() ?? (stillWanted() ? 'done' : 'ended');
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
			let reason: ReturnType<typeof cut> = await typeFor(plan.typing[0]!);
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
		let stop: 'done' | 'halt_switch' | 'stopped' | 'ended' | 'unreachable' | 'failed' = 'done';
		for (const text of messages) {
			if (sent) await sleep(betweenMessagesMs(runtime.rng, pacing));
			if ((stop = cut()) !== 'done') break;
			try {
				// Once, before the first message is typed (nothing follows a failed one)
				if (!sent && conversation.markRead) {
					await conversation.markRead();
					if ((stop = await wait(readPauseMs(runtime.rng, pacing))) !== 'done') break;
				}
				if ((stop = await typeOut(text)) !== 'done') break;
				if (runtime.dryRun) runtime.log(persona.id, 'dry_send', { personId, platform: channel, text });
				else {
					await conversation.send(text);
					runtime.store.addMessage(personId, channel, 'out', text);
					runtime.log(persona.id, 'dm_sent', { personId, platform: channel, text });
				}
				conversation.delivered?.(text);
				sent++;
			} catch (error) {
				if (error instanceof UnreachableError) {
					stop = 'unreachable';
					// A goodbye refused keeps them denied or blocked
					if (runtime.store.personById(personId).state === 'active') runtime.store.updatePerson(personId, { state: 'stopped' });
					runtime.log(persona.id, 'unreachable', { personId, platform: channel, code: error.code });
				} else {
					stop = 'failed';
					runtime.log(persona.id, 'delivery_failed', { personId, platform: channel, sent, error: String(error) });
				}
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

	/** A turn that is due: answered while a span is open on its channel, else back into the backlog. A backlog turn ends here, whatever happened. */
	const fire = async (personId: number, conversation: Conversation) => {
		pending.delete(personId);
		try {
			if (runtime.halted()) {
				runtime.log(persona.id, 'reply_paused', { personId, platform: conversation.channel.id, reason: 'halt_switch' });
				park(personId, conversation, 'halt_switch');
			} else if (!spanAt(persona, runtime.now(), conversation.channel.id)) park(personId, conversation, 'offline');
			else if (busy.has(personId) || occupied()) schedule(personId, conversation, 5_000);
			else await answer(personId, conversation);
		} finally {
			release(personId);
		}
	};

	/**
	 * Composes their turn and carries it out: the reply, the persona's action, an invitation it accepted. The turn is
	 * committed (their messages it answered marked handled) once its delivery was attempted: sent, failed or cut short.
	 * Only a turn paused before its first send stays owed: back in the backlog after HALT, for the next start after
	 * `stop`; one cut by a restart before its delivery ended is queued again at the next start. Nothing more is carried
	 * out once paused. The history holds only what was actually sent. A dry run marks nothing handled.
	 */
	const answer = async (personId: number, conversation: Conversation) => {
		const channel = conversation.channel.id;
		busy.add(personId);
		if (pacing.singlePresence) present = { personId, since: runtime.now() };
		try {
			let turn: Awaited<ReturnType<Brain['compose']>>;
			const invitation = conversation.channel.invitations ? invitations.get(personId) : undefined;
			// Their newest message the model sees: compose reads them before its first wait
			const through = runtime.store.personById(personId).lastInAt;
			try {
				runtime.log(persona.id, 'reply_processing', { personId, platform: channel });
				turn = await brain.compose(personId, conversation.channel, { invitation: invitation?.name, extraLines: conversation.extraLines });
				failures.delete(personId);
				providerWaits.delete(personId);
			} catch (error) {
				// A stopped queue tries nothing again: they are still owed at the next start
				if (!stopped) retry(personId, conversation, error, through);
				return;
			}
			/** Those messages had their turn (one that came in meanwhile is still owed), and so had the invitation, unless it waits for full online time. */
			const commit = () => {
				if (!runtime.dryRun) runtime.store.updatePerson(personId, { handledAt: through });
				if (!turn.inviteWaits && invitations.get(personId) === invitation) invitations.delete(personId);
			};
			// Anything but the code's goodbye is dropped once they end it meanwhile (a block the persona chose still sends its reply)
			const stillWanted = () => !endedIt(runtime.store.personById(personId).state);
			if (turn.messages.length) {
				const { sent, stop } = await deliver(conversation, turn.messages, personId, turn.final ? undefined : stillWanted);
				if ((stop === 'halt_switch' || stop === 'stopped') && !sent && runtime.store.personById(personId).state === 'active') {
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
			if (turn.action !== 'none') {
				// The store has it already (compose ends the conversation on a block), but nothing new starts on the channel
				if (pause) runtime.log(persona.id, 'action_skipped', { personId, action: turn.action, reason: pause });
				else if (runtime.dryRun) runtime.log(persona.id, `dry_${turn.action}`, { personId });
				else await act(personId, turn.action);
			}
			if (invitation && turn.acceptInvite && turn.action === 'none' && !pause && stillWanted()) {
				runtime.log(persona.id, 'invite_accepted', { personId, invitation: invitation.name, dryRun: runtime.dryRun });
				if (!runtime.dryRun) await invitation.join();
			} else if (invitation) runtime.log(persona.id, 'invite_not_joined', { personId, invitation: invitation.name });
		} catch (error) {
			runtime.log(persona.id, 'delivery_failed', { personId, error: String(error) });
		} finally {
			busy.delete(personId);
			if (present?.personId === personId) present = null;
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

	/** Their turn comes after `wait` ms (never once stopped). */
	const timeReply = (personId: number, conversation: Conversation, wait: number, reason: 'pacing' | 'retry' | 'backlog') => {
		if (stopped) return;
		// setTimeout holds at most about 24.8 days
		const delayMs = Math.round(Math.min(wait, 2_000_000_000));
		pending.set(personId, setTimeout(() => void fire(personId, conversation), delayMs));
		runtime.log(persona.id, 'reply_scheduled', { personId, platform: conversation.channel.id, delayMs, dueAt: new Date(runtime.now() + delayMs).toISOString(), reason });
	};

	/** Into the backlog: answered once a span with time for it is open on their channel (`drain`); never once stopped. */
	const park = (personId: number, conversation: Conversation, reason: 'offline' | 'span_ending' | 'halt_switch' | 'restart') => {
		if (stopped) return;
		waiting.set(personId, conversation);
		const next = nextSpan(persona, runtime.now(), { channel: conversation.channel.id });
		runtime.log(persona.id, 'reply_waiting', { personId, platform: conversation.channel.id, reason, backlog: waiting.size, nextOpenAt: next ? new Date(next.start).toISOString() : null });
	};

	/** Starts the next backlog turn unless one is in progress: the oldest waiting person whose channel has a span open with time left for it. */
	const drain = () => {
		if (drainingId !== null || runtime.halted() || occupied()) return;
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

	/** Their turn is already coming: timed, or in the backlog. */
	const queued = (personId: number) => pending.has(personId) || waiting.has(personId);

	const schedule = (personId: number, conversation: Conversation, delay?: number) => {
		if (queued(personId)) {
			runtime.log(persona.id, 'reply_batched', { personId, platform: conversation.channel.id });
			return;
		}
		// A retry keeps its own delay; if no span is open by then, `fire` parks it
		if (delay !== undefined) return timeReply(personId, conversation, delay, 'retry');
		const now = runtime.now();
		const span = spanAt(persona, now, conversation.channel.id);
		// Only quick replies on a short break, and always due before the span ends
		const wait =
			span &&
			fitDelay(
				span.kind === 'break' ? quickReplyMs(runtime.rng, pacing) : replyDelayMs(runtime.rng, pacing),
				span.end - SPAN_END_MARGIN - now,
				pacing.quickReplyDelaySeconds[0] * SECOND,
			);
		if (wait === null) park(personId, conversation, span ? 'span_ending' : 'offline');
		else timeReply(personId, conversation, wait, 'pacing');
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
			if (decision.kind === 'final') {
				invitations.delete(decision.person.id);
				waiting.delete(decision.person.id);
				const timer = pending.get(decision.person.id);
				pending.delete(decision.person.id);
				if (timer) {
					clearTimeout(timer);
					// A backlog turn it cancelled lets the next one start
					release(decision.person.id);
				}
				// A final answer goes out soon, in or out of hours: it ends the conversation. One cut by HALT is dropped: they are stopped or denied already
				await sleep(between(runtime.rng, 2_000, 10_000));
				await deliver(conversation, decision.messages, decision.person.id);
				return;
			}
			if (conversation.invitation) invitations.set(decision.person.id, conversation.invitation);
			schedule(decision.person.id, conversation);
		},
		schedule,
		/** Everyone who last wrote on `channel` and is still owed a turn since the persona was last online, into the backlog, oldest first. */
		async requeue(channel: ChannelId, conversationOf: (person: Person) => Promise<Conversation | null>) {
			for (const { person, channel: lastOn } of runtime.store.unanswered(persona.id, backlogSince)) {
				if (lastOn !== channel) continue;
				// null: they can't be reached there any more
				const conversation = await conversationOf(person);
				// Someone who wrote since the start already has their turn
				if (conversation && !queued(person.id) && !busy.has(person.id)) park(person.id, conversation, 'restart');
			}
		},
		/**
		 * Once every channel is up: every 30 s, records when the persona was last online and answering (not halted, not a
		 * dry run), for the next start's backlogSince, and moves the backlog on. Once only, and never after `stop`.
		 */
		start() {
			if (tick || stopped) return;
			tick = setInterval(() => {
				const now = runtime.now();
				if (!runtime.dryRun && spanAt(persona, now) && !runtime.halted()) runtime.store.set(persona.id, 'lastOnlineAt', String(now));
				drain();
			}, 30_000);
		},
		stop() {
			stopped = true;
			clearInterval(tick);
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
			waiting.clear();
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
