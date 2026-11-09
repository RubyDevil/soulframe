import { existsSync } from 'node:fs';
import { inspect } from 'node:util';
import { unhandled, type Brain, type Decision, type PersonAction, type Turn } from './brain.js';
import type { Channel, ChannelId } from './channel.js';
import { LlmBudgetError, ModelNotConfiguredError, ProviderUnavailableError } from './llm.js';
import type { PersonaConfig } from './config/personas.js';
import { betweenMessagesMs, drawIn, fitDelay, glanceMs, interruptionAt, lookingMs, quietMs, readingMs, typingPlan, watchingChance, watchingMs, type Interruption } from './pacing.js';
import { readableChars } from './perception.js';
import { between, sleep, weightedPick, type Rng } from './rng.js';
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
	 * Shows the person their messages were read (a read receipt): called as it starts writing each draft of a reply (and
	 * before the code's goodbye), as the reading starts, which lasts as long as `pacing.readingCharsPerSecond` says while
	 * the model writes. A rejection counts as a failed delivery, as `typing`'s.
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
 * together. While a span is open on their channel, a turn is due after a delay that ends before the span does: a short
 * lag while it still watches their chat, else when it next glances at its messages (only the lag on a short break),
 * and once they stopped writing (`pacing.burst`). Due turns start as soon as the persona is free and back from any
 * interruption, the next drawn by weight among several (`pacing.priority`). Otherwise they wait in the backlog,
 * answered once a span opens: one person at a time, oldest first, with a pause before each. It reads their messages
 * while it writes, and types each message for a time proportional to it.
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
	const { burst, priority } = pacing;
	/** Whether a turn that comes due while others wait is weighed by the Decisions importance check (`brain.assess`, which asks nothing while the checks are off). */
	const assessing = persona.settings.decisions.importance.enabled;
	/** By person: the timer of a turn's delay, a retry or a backlog gap. */
	const pending = new Map<number, NodeJS.Timeout>();
	/** The backlog: people owed a turn while no span was open for it, oldest first. */
	const waiting = new Map<number, Conversation>();
	/** Due while they were still writing: due once their quiet ends. */
	const settling = new Map<number, Conversation>();
	/** Due, in the order they came due, and since when: one of them starts as soon as the persona is free (`pacing.priority`). */
	const ready = new Map<number, { conversation: Conversation; since: number }>();
	/** How many messages they had written when `brain.assess` was last asked about them, by person: never twice for the same. */
	const assessedAt = new Map<number, number>();
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
	/**
	 * Interruptions as they happen (`pacing.interruptions`): the one it is in, and the timer that moves the queue on as it
	 * ends; when the last one began (it watches no chat it had open before); one held off by a conversation that matters,
	 * with the time it has left; and the scheduled ones already met, each taken or held once.
	 */
	let away: Interruption | null = null;
	let comeback: NodeJS.Timeout | undefined;
	/** When the last interruption ends (or ended): a chat last open before then is not being watched any more. */
	let lastAwayEnd = 0;
	let held: { ms: number } | null = null;
	const met = new Set<number>();
	/** Why each pending timer was set (only a turn's own delay or a backlog gap is a turn coming soon), when it is due, and for which conversation. */
	const pendingWhy = new Map<number, { why: 'pacing' | 'retry' | 'backlog'; at: number; conversation: Conversation }>();
	/** When its last turn with anyone ended: while that is recent it is on its phone (`pacing.watching`). */
	let lastActive: number | undefined;
	/**
	 * Off its phone, its next look at its messages (`pacing.glance`): one for everyone, drawn when the first message comes
	 * in, and everyone who wrote before it is noticed then, together; with its timer, and who waits for it.
	 */
	let nextGlance: { at: number; timer: NodeJS.Timeout } | null = null;
	const glancing = new Map<number, Conversation>();
	/** When each person due first came due, kept while they write again: how long they waited (`pacing.priority`). */
	const firstDue = new Map<number, number>();
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

	/** Whether it may still be watching a chat it last had open at `last`: not if an interruption began since, or was on then (a turn under way is finished first). */
	const awaySince = (last: number) => last < lastAwayEnd;

	/**
	 * Who holds an interruption off now, if anyone: someone whose conversation matters (their importance, rated within the
	 * last `priority.importanceHalfLifeMinutes`, at or above `interruptions.holdAtImportance`) and goes on, with a turn under
	 * way or coming soon (not a retry or a wait for the budget), or an exchange in the last `calmMinutes`.
	 */
	const holder = (now: number) => {
		const { holdAtImportance, calmMinutes } = pacing.interruptions;
		if (holdAtImportance > 3) return null;
		const soon = [...[...pending.keys()].filter((personId) => pendingWhy.get(personId)?.why !== 'retry'), ...glancing.keys()];
		const coming = new Set([...active.keys(), ...ready.keys(), ...settling.keys(), ...soon]);
		for (const [personId, last] of lastWith) if (now - last < calmMinutes * MINUTE) coming.add(personId);
		for (const personId of coming) {
			const { importance, importanceAt } = runtime.store.personById(personId);
			if (importance >= holdAtImportance && now - importanceAt < priority.importanceHalfLifeMinutes * MINUTE) return personId;
		}
		return null;
	};

	/** It is away from now to `end`: logged, and the queue moves on as it comes back. */
	const leave = (now: number, end: number) => {
		away = { start: now, end };
		lastAwayEnd = end;
		runtime.log(persona.id, 'away', { from: new Date(now).toISOString(), until: new Date(end).toISOString() });
		clearTimeout(comeback);
		comeback = setTimeout(() => {
			// Back, whatever the clock reads as the timer fires
			away = null;
			drain();
			next();
		}, end - now);
	};

	/**
	 * Whether something took it away from its messages now (`pacing.interruptions`): no turn starts until it is back (one
	 * under way is finished). A scheduled interruption that comes while a conversation matters is held off, and taken
	 * once that conversation calms down, for the time it had left, never past the end of its online time (one held when
	 * its online time ends is dropped); a planned leave (the end of its span) is the agenda's, whatever the conversation.
	 * One held at a time: another that comes meanwhile is dropped. Checked at each tick too, so an interruption comes
	 * whether or not anyone is waiting.
	 */
	const isAway = () => {
		const now = runtime.now();
		if (away && now < away.end) return true;
		away = null;
		const scheduled = interruptionAt(persona, now, pacing);
		const fresh = scheduled && !met.has(scheduled.start) ? scheduled : null;
		if (fresh) met.add(fresh.start);
		// Those of the days before are long over
		for (const start of met) if (start < now - 3 * 24 * 60 * MINUTE) met.delete(start);
		if (!held && !fresh) return false;
		const holding = holder(now);
		if (holding !== null) {
			if (fresh && !held) {
				held = { ms: fresh.end - now };
				runtime.log(persona.id, 'interruption_held', { personId: holding, minutes: Number((held.ms / MINUTE).toFixed(1)) });
			}
			return false;
		}
		const span = spanAt(persona, now);
		const ms = held?.ms ?? fresh!.end - now;
		held = null;
		// Its online time is over: what was held is dropped
		if (span?.kind !== 'online') return false;
		leave(now, Math.min(now + ms, span.end));
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
			paused() ?? (!stillWanted() ? 'ended' : state?.superseded && state.sent === 0 ? 'superseded' : 'done');

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
				// From here it goes out, and can't be taken back: a newer message gets a turn of its own
				if (state) state.writing = false;
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
	 * What a turn does while the model writes: shows their messages read (`markRead`), then reads `chars` characters and
	 * looks at `images` photos for as long as that takes. Answers as `deliver`'s waits, or 'failed' / 'unreachable' when
	 * the read receipt was refused.
	 */
	const read = async (conversation: Conversation, personId: number, chars: number, images: number, cut: () => Stop): Promise<Stop> => {
		try {
			await conversation.markRead?.();
		} catch (error) {
			return failedDelivery(error, personId, conversation.channel.id, 0);
		}
		await sleep(readingMs(chars, runtime.rng, pacing) + lookingMs(images, runtime.rng, pacing));
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
	const due = (personId: number, conversation: Conversation, startNext = true) => {
		pending.delete(personId);
		if (runtime.halted()) return haltPark(personId, conversation);
		if (!spanAt(persona, runtime.now(), conversation.channel.id)) return park(personId, conversation, 'offline');
		// Still writing: due once they stop
		if (quiet.has(personId)) return void settling.set(personId, conversation);
		const since = firstDue.get(personId) ?? runtime.now();
		firstDue.set(personId, since);
		ready.set(personId, { conversation, since });
		// Others wait for the persona too: how much their messages matter weighs each turn due (asked once per newest message)
		if (assessing && (occupied() || ready.size > 1)) {
			for (const [id, entry] of ready) {
				const { incoming } = runtime.store.personById(id);
				if (assessedAt.get(id) === incoming) continue;
				assessedAt.set(id, incoming);
				void brain.assess(id, entry.conversation.channel);
			}
		}
		// An earlier turn of theirs is still under way (stuck): the backlog moves on meanwhile
		if (active.has(personId)) release(personId);
		if (startNext) next();
	};

	/** It looks at its messages: everyone who waited for this look is noticed at once, then the next turn is picked among them. */
	const glance = () => {
		nextGlance = null;
		const noticed = [...glancing];
		glancing.clear();
		for (const [personId, conversation] of noticed) due(personId, conversation, false);
		next();
	};

	/**
	 * How much someone due weighs against the others (`pacing.priority`): how close it is to them (familiarity, and
	 * affinity when kept), how much their conversation matters now (their last importance, fading back to an ordinary
	 * chat's), up to three times as much while it still watches their chat, and more the longer they waited.
	 */
	const weightOf = (personId: number, since: number, now: number) => {
		const person = runtime.store.personById(personId);
		const bond = (1 + person.familiarity) * (persona.settings.relationship.affinity.enabled ? 1 + person.affinity / 2 : 1);
		const fading = 0.5 ** (Math.max(0, now - person.importanceAt) / (priority.importanceHalfLifeMinutes * MINUTE));
		const importance = 2 + (person.importance - 1) * fading;
		const last = lastWith.get(personId);
		const watching = last !== undefined && !awaySince(last) ? watchingChance(now - last, pacing, pacing.watching.chatHalfLifeSeconds) : 0;
		const waited = 1 + Math.max(0, now - since) / (priority.agingMinutes * MINUTE);
		return bond * importance * (1 + 2 * watching) * waited;
	};

	/**
	 * Starts the next ready turn once the persona is free (no turn under way, or one past PRESENCE_LEASE): of several due,
	 * one drawn by weight (`pacing.priority`), else the first that came due. Anyone whose span closed while they waited goes
	 * back into the backlog, and while halted everyone does; someone writing again waits for their quiet once more.
	 */
	const next = () => {
		if (stopped || occupied() || (ready.size && isAway())) return;
		const now = runtime.now();
		const due: { personId: number; conversation: Conversation; since: number }[] = [];
		for (const [personId, { conversation, since }] of ready) {
			// Their earlier turn, stuck past PRESENCE_LEASE, is still under way: this one waits for it to end
			if (active.has(personId)) continue;
			const leaving = runtime.halted() || !spanAt(persona, now, conversation.channel.id) || quiet.has(personId);
			if (!leaving) {
				due.push({ personId, conversation, since });
				continue;
			}
			ready.delete(personId);
			if (runtime.halted()) haltPark(personId, conversation);
			else if (quiet.has(personId)) settling.set(personId, conversation);
			else park(personId, conversation, 'offline');
		}
		const chosen = due.length > 1 && priority.weighted ? pickByWeight(due, now) : due[0];
		if (!chosen) return;
		ready.delete(chosen.personId);
		firstDue.delete(chosen.personId);
		void answer(chosen.personId, chosen.conversation);
	};

	/** One of several due, drawn by weight (`weightOf`), logged with how many it was picked among. */
	const pickByWeight = (due: { personId: number; conversation: Conversation; since: number }[], now: number) => {
		const weighed = due.map((entry) => ({ weight: weightOf(entry.personId, entry.since, now), value: entry }));
		const chosen = weightedPick(runtime.rng, weighed) ?? due[0]!;
		runtime.log(persona.id, 'reply_picked', { personId: chosen.personId, among: due.length, weight: Number(weighed.find((entry) => entry.value === chosen)!.weight.toFixed(2)) });
		return chosen;
	};

	/**
	 * It picks up its phone for a turn: what was waiting for its next glance is noticed now, after the short lag it would
	 * have had watching (only ever sooner). The one it is answering, retries and backlog gaps keep their times.
	 */
	const noticeWaiting = (answering: number) => {
		const now = runtime.now();
		// The look it was going to take is this one
		if (nextGlance) clearTimeout(nextGlance.timer);
		nextGlance = null;
		const looking = [...glancing].filter(([personId]) => personId !== answering);
		glancing.clear();
		for (const [personId, conversation] of looking) timeReply(personId, conversation, watchingMs(runtime.rng, pacing), 'pacing', true);
		for (const [personId, { why, at, conversation }] of pendingWhy) {
			if (why !== 'pacing' || personId === answering || !pending.has(personId)) continue;
			const lag = watchingMs(runtime.rng, pacing);
			if (at <= now + lag) continue;
			clearTimeout(pending.get(personId));
			pending.delete(personId);
			timeReply(personId, conversation, lag, 'pacing', true);
		}
	};

	/** One turn under way: the others wait until it ends (or has run PRESENCE_LEASE), then the next starts. */
	const answer = async (personId: number, conversation: Conversation) => {
		const state: TurnState = { since: runtime.now(), through: 0, sent: 0, writing: false, superseded: false, restarts: 0 };
		active.set(personId, state);
		present = state;
		noticeWaiting(personId);
		clearTimeout(lease);
		lease = setTimeout(() => {
			// Ended turns clear it, so this one is stuck: the others go on, whatever the clock reads as the timer fires
			if (present === state) present = null;
			next();
		}, PRESENCE_LEASE);
		try {
			await turn(personId, conversation, state);
		} catch (error) {
			runtime.log(persona.id, 'delivery_failed', { personId, error: String(error) });
		} finally {
			active.delete(personId);
			lastWith.set(personId, runtime.now());
			lastActive = runtime.now();
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
			drain();
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
			const toRead = unhandled(runtime.store.history(personId, persona.settings.memory.historyMessages), Math.max(handledAt, readUpTo));
			const readChars = toRead.reduce((sum, m) => sum + readableChars(m), 0);
			const photos = toRead.reduce((sum, m) => sum + (m.media?.images.length ?? 0), 0);
			readUpTo = through;
			runtime.log(persona.id, 'reply_processing', { personId, platform: channel });
			// It reads them while the model writes
			const reading = read(conversation, personId, readChars, photos, cut);
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
				// A newer message that came as it was too late to start over: its own turn, once this one ends
				if (state.superseded) {
					state.superseded = false;
					owedAfter.set(personId, conversation);
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
			return schedule(personId, conversation, drawIn(runtime.rng, retries.delayMinutes) * MINUTE * Math.min(2 ** waits, 16));
		}
		const attempt = (failures.get(personId) ?? 0) + 1;
		runtime.log(persona.id, 'reply_failed', { personId, attempt, error: String(error) });
		const unconfigured = error instanceof ModelNotConfiguredError;
		if (attempt < retries.attempts && !unconfigured) {
			failures.set(personId, attempt);
			schedule(personId, conversation, drawIn(runtime.rng, retries.delayMinutes) * MINUTE * attempt);
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
		pendingWhy.set(personId, { why: reason, at: runtime.now() + delayMs, conversation });
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
		firstDue.delete(personId);
		waiting.set(personId, conversation);
		const next = nextSpan(persona, runtime.now(), { channel: conversation.channel.id });
		runtime.log(persona.id, 'reply_waiting', { personId, platform: conversation.channel.id, reason, backlog: waiting.size, nextOpenAt: next ? new Date(next.start).toISOString() : null });
		release(personId);
	};

	/** Starts the next backlog turn unless one is in progress: the oldest waiting person whose channel has a span open with time left for it. */
	const drain = () => {
		if (drainingId !== null || runtime.halted() || occupied() || (waiting.size && isAway())) return;
		const now = runtime.now();
		for (const [personId, conversation] of waiting) {
			const span = spanAt(persona, now, conversation.channel.id);
			if (!span) continue;
			// The first backlog reply of a span may wait longer, as someone just back
			const first = span.start !== drainSpanStart ? drawIn(runtime.rng, pacing.returnOnlineReplyDelayMinutes) * MINUTE : 0;
			const delay = drawIn(runtime.rng, pacing.backlogGapSeconds) * SECOND + first;
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
	const queued = (personId: number) => pending.has(personId) || glancing.has(personId) || waiting.has(personId) || settling.has(personId) || ready.has(personId);

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
		// On its phone while it writes a reply to anyone, and for a while after, unless it was away since; on a short break it is on it anyway
		const since = occupied() ? 0 : lastActive !== undefined && !awaySince(lastActive) ? now - lastActive : null;
		const onPhone = span.kind === 'break' || (since !== null && runtime.rng() < watchingChance(since, pacing));
		// Off it, they wait for its next look, which everyone shares: drawn now unless one is coming
		const glanceAt = onPhone ? null : (nextGlance?.at ?? now + glanceMs(runtime.rng, pacing));
		const ms = glanceAt === null ? watchingMs(runtime.rng, pacing) : glanceAt - now;
		// Always due before the span ends: one its look would come too late for gets a time of its own
		const wait = fitDelay(ms, span.end - SPAN_END_MARGIN - now, pacing.glance.delaySeconds[0] * SECOND);
		if (wait === null) return park(personId, conversation, 'span_ending');
		if (glanceAt === null || wait < ms || stopped) return timeReply(personId, conversation, wait, 'pacing', onPhone);
		if (!nextGlance) nextGlance = { at: glanceAt, timer: setTimeout(glance, ms) };
		glancing.set(personId, conversation);
		runtime.log(persona.id, 'reply_scheduled', { personId, platform: conversation.channel.id, delayMs: Math.round(ms), dueAt: new Date(glanceAt).toISOString(), reason: 'pacing', watching: false });
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
				glancing.delete(personId);
				firstDue.delete(personId);
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
				isAway();
				drain();
				next();
			}, 30_000);
		},
		stop() {
			stopped = true;
			clearInterval(tick);
			clearTimeout(lease);
			clearTimeout(comeback);
			if (nextGlance) clearTimeout(nextGlance.timer);
			nextGlance = null;
			glancing.clear();
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
			firstDue.clear();
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
