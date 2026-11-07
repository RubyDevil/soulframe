import type { Channel, ChannelId } from './channel.js';
import type { PersonaConfig } from './config/personas.js';
import { DISABLED_DECISIONS, probabilityOf, scoreOf, type Decisions, type DecisionsUse, type Question } from './decisions.js';
import type { Llm, LlmMessage } from './llm.js';
import { moodOf } from './mood.js';
import { splitReply } from './pacing.js';
import { hostOf, isStopRequest, MINOR_EXIT, minorSignal, STOP_ACK, stripForeignLinks } from './safety.js';
import { busyAt, fullyOnline, situationAt } from './schedule.js';
import { HOUR, MINUTE } from './settings.js';
import {
	ADDRESSED_QUESTION,
	ADULTS_ONLY_RULE,
	CHIME_IN_QUESTION,
	dateTimeText,
	dayPrompt,
	directMessageTask,
	directMessageTimePrompt,
	dmCheckInput,
	dmMinorQuestion,
	groupChatGateQuestions,
	groupChatLineInput,
	groupChatMinorQuestion,
	groupChatTask,
	groupChatTimePrompt,
	groupChatTranscript,
	MINOR_QUESTION,
	POST_REQUEST,
	postTask,
	SFW_RULE,
	STOP_QUESTION,
	stopQuestion,
	systemPrompt,
	type Relationship,
} from './prompts.js';
import type { Runtime } from './runtime.js';
import type { Person } from './store.js';

export type Decision =
	| { kind: 'ignore'; reason: string }
	/** Send these and nothing more: the conversation is over. */
	| { kind: 'final'; person: Person; messages: string[] }
	/** Answer later (`compose`). */
	| { kind: 'reply'; person: Person };

/**
 * What the persona chose to do besides talking: "none", "block" (offered everywhere; it ends the conversation for
 * good), or the name of one of the channel's own `actions`.
 */
export type PersonAction = string;

export interface Turn {
	/** The messages to send, in order; empty to leave it on read. */
	messages: string[];
	action: PersonAction;
	acceptInvite?: true;
	/** The pending invitation could not be answered yet (a short break): it waits for full online time. */
	inviteWaits?: true;
	/** The code's goodbye: it goes out even though the person is no longer active. */
	final?: true;
}

export interface ParsedTurn {
	/** `null` to say nothing. */
	reply: string | null;
	/** Rewritten notes, or `undefined` to keep them. */
	notes?: string;
	self?: string;
	action: PersonAction;
	acceptInvite?: true;
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'null' ? value.trim() : null);

/** The parsed JSON, or undefined when it isn't JSON. */
const jsonOf = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const LINE_BREAK_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r' };

/** `json` with the raw line breaks inside its string literals escaped, and everything else as it is (pretty-printed JSON stays valid). */
const escapeBreaksInStrings = (json: string) => {
	let out = '';
	let inString = false;
	let escaped = false;
	for (const char of json) {
		out += (inString && LINE_BREAK_ESCAPES[char]) || char;
		if (escaped) escaped = false;
		else if (char === '\\') escaped = inString;
		else if (char === '"') inString = !inString;
	}
	return out;
};

/** The reply alone of a broken answer (cut off, say), when it holds the whole reply; `null` otherwise. */
const replyOnly = (text: string): ParsedTurn | null => {
	const literal = /"reply"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
	const reply = literal === undefined ? undefined : jsonOf(escapeBreaksInStrings(literal));
	return reply === undefined ? null : { reply: textOrNull(reply), action: 'none' };
};

/** A line that starts like one of the answer's fields ("notes: …", `"reply": …`): JSON that lost its braces. */
const FIELD_LINE = /^\s*"?(?:reply|notes|self|action|acceptInvite)"?\s*:/im;

/**
 * The model's JSON answer, read leniently: the text from its first `{` to its last `}`, raw line breaks in its strings
 * allowed. From a broken one only a whole reply is kept, and `null` when not even that can be read: text with a `{` is
 * never taken as the reply. A model that answered plain text without any `{` is taken as a reply, unless a line of it
 * starts like one of the fields (FIELD_LINE): its private notes are never sent. An action is "block", one of `actions`
 * (the channel's own), or else "none".
 */
export function parseTurn(raw: string, actions: readonly string[] = []): ParsedTurn | null {
	const start = raw.indexOf('{');
	if (start === -1) return FIELD_LINE.test(raw) ? null : { reply: textOrNull(raw), action: 'none' };
	const end = raw.lastIndexOf('}');
	const body = end > start ? raw.slice(start, end + 1) : null;
	// An object whenever it parses: it starts with `{`
	const json = (body === null ? undefined : (jsonOf(body) ?? jsonOf(escapeBreaksInStrings(body)))) as Record<string, unknown> | undefined;
	if (json === undefined) return replyOnly(raw.slice(start));
	const action = typeof json.action === 'string' && (json.action === 'block' || actions.includes(json.action)) ? json.action : 'none';
	const notes = textOrNull(json.notes);
	const self = textOrNull(json.self);
	return {
		reply: textOrNull(json.reply),
		action,
		...(notes !== null && { notes }),
		...(self !== null && { self }),
		...(json.acceptInvite === true && { acceptInvite: true as const }),
	};
}

export interface GroupChatLine {
	name: string;
	text: string;
	mine: boolean;
	/** A notice of the chat itself ("Sam joined"), not a message. */
	system?: boolean;
	/** When it was written (ms since the epoch). */
	at?: number;
}

export interface Brain {
	/**
	 * A message they wrote on `channel` as `name` (the name they go by there: the person keeps the one of their newest
	 * message), now unless `at` says when (one read late). Synchronous: a catch-up keeps its order.
	 */
	incoming(channel: Channel, externalId: string, name: string, text: string, at?: number): Decision;
	/**
	 * What to do now in the conversation with the person on `channel`. Stores nothing it says: the reply queue records
	 * each message once sent. `invitation`: a pending group-chat invitation's name, heeded only where `channel.invitations`;
	 * `extraLines`: the app's lines for this turn (`Conversation.extraLines`), given the person as compose reads them.
	 */
	compose(personId: number, channel: Channel, options?: { invitation?: string; extraLines?: (person: Person) => readonly string[] }): Promise<Turn>;
	/** A post in its own voice for `channel` (with its `notes`), following its rules and not repeating its recent posts, or null. The app picked where and when. */
	composePost(channel: Channel, post: { rules: string; examples: readonly string[]; recent: readonly string[] }): Promise<string | null>;
	/** What to say in a group chat (`chat`, with its `notes`), or `null` to stay quiet; `quiet` when the chat went silent a while, `hosted` in its own. */
	composeGroupChatLine(chat: Channel, recent: GroupChatLine[], quiet: boolean, hosted: boolean): Promise<string | null>;
	/**
	 * Group-chat gate (settings.decisions.groupChatGate) on the chat `chatId` (the app's own id for that chat, the same on
	 * every call: its `perHour` cap counts per chat): null when off, past that cap, or on any failure or refusal; the
	 * caller then lets the model decide.
	 */
	wantsToSpeak(chatId: string, recent: GroupChatLine[]): Promise<{ speak: boolean; addressed: number; chimeIn: number } | null>;
	/** Age check of one group-chat line (settings.decisions.minor.groupChats): level 'none', nothing asked, unless `chat.adult`; 'none' too when off or on any failure or refusal. */
	checkGroupChatLine(chat: Channel, text: string): Promise<{ level: 'deny' | 'caution' | 'none'; probability: number | null }>;
}

/** How near the end of its span a DM turn is asked to wrap up (prompts.ts dayPrompt `endingSoon`); in a span under three times as long, its last third. */
const WRAP_UP_MS = 10 * MINUTE;

/** The soft limit of a group-chat line on `chat` (prompts.ts groupChatTask): its `targetLength`, else 150 or four fifths of its `maxLength`, whichever is less. */
const lineTarget = (chat: Channel) => chat.targetLength ?? Math.min(150, Math.floor(chat.maxLength * 0.8));

/** Their messages in a history that had no turn yet: those after `handledAt`. */
const unhandled = <M extends { direction: 'in' | 'out'; at: number }>(history: M[], handledAt: number) =>
	history.filter((m) => m.direction === 'in' && m.at > handledAt);

/** The relationship from the conversations so far: acquainted, regular and close from each count in `after`. */
export const relationshipOf = (conversations: number, [acquainted, regular, close]: readonly [number, number, number]): Relationship =>
	conversations >= close ? 'close' : conversations >= regular ? 'regular' : conversations >= acquainted ? 'acquainted' : 'new';

/** The app's content policy. soulframe applies none of its own beyond `Channel.adult` and the persona's `sfw`. */
export interface Policy {
	/** Lines of "Rules you never break:", each rendered "- line", after soulframe's own (the 18+ line, the sfw line). */
	rules?: readonly string[];
	/**
	 * URLs whose host (subdomains included) a DM reply or group-chat line may link to: every other link is removed, and a post
	 * then carries none (its task says "No links in the post."). Left out, links are left as written.
	 */
	allowedLinks?: readonly string[];
}

export function createBrain({
	persona,
	identity,
	style,
	runtime,
	llm,
	decisions = DISABLED_DECISIONS,
	policy = {},
}: {
	persona: PersonaConfig;
	/** The app's phrase on what the persona is, after its name in the identity line ("You are Robin, <identity>, chatting by text in …"); none for the name alone. */
	identity?: string;
	/** The app's block on how the persona writes, word for word after the identity line; none by default. */
	style?: string;
	/**
	 * The runtime its reply queue runs on (`createReplyQueue`'s): the brain reads its clock, randomness and store, so the
	 * two can never run on different clocks.
	 */
	runtime: Pick<Runtime, 'now' | 'rng' | 'store'>;
	llm: Llm;
	/** Typed checks that only add strictness (`settings.decisions`); none by default. */
	decisions?: Decisions;
	/** The app's rules and allowed links; none by default. */
	policy?: Policy;
}): Brain {
	const { store } = runtime;
	// Read at each use: a clock swapped on the runtime is the brain's too
	const now = () => runtime.now();
	// Its own settings: the global ones with its overrides merged in when the config was loaded
	const settings = persona.settings;
	// Which checks run and their thresholds; whether any runs at all is `decisions.enabled` (the caller builds a real client only when the setting is on).
	// Global only (settings.ts GLOBAL_SETTINGS): the same for every persona
	const checks = settings.decisions;
	const ctx = (use: DecisionsUse) => ({ use, personaId: persona.id });
	const localTime = () => dateTimeText(now(), persona.timezone);
	const allowedHosts = policy.allowedLinks?.map(hostOf);
	/** `text` without the links the policy doesn't allow (in a `post`, any link); as written without `policy.allowedLinks`. */
	const allowedLinksOnly = (text: string, post = false) => (allowedHosts ? stripForeignLinks(text, post ? [] : allowedHosts) : text);
	const selfNotes = () => store.get(persona.id, 'selfNotes') ?? '';
	/** When the group-chat gate asked over the last hour, by chat (`wantsToSpeak`'s `chatId`, settings.decisions.groupChatGate.perHour). */
	const gateAsked = new Map<string, number[]>();

	/** The rules on `channel`: the 18+ line on an adult one, the sfw line of an sfw persona, then the app's. */
	const rulesOn = (channel: Channel) => [...(channel.adult ? [ADULTS_ONLY_RULE] : []), ...(persona.sfw ? [SFW_RULE] : []), ...(policy.rules ?? [])];

	// Every prompt's text is in prompts.ts (and the channel's, in the app's Channel); this only fills in the persona
	const system = (channel: Channel, rules: readonly string[], task: string) =>
		systemPrompt({ personaPrompt: persona.promptText, character: persona.character, name: persona.name, identity, style, channel, rules, task });

	const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

	/** Ends it for good with someone under 18: every persona deny-lists each of their accounts (this person denied with them). */
	const denyMinor = (person: Person, on: ChannelId, detail: Record<string, unknown>) => {
		for (const [channel, externalId] of Object.entries(person.ids)) store.deny(channel, externalId, 'minor');
		store.audit(persona.id, 'denied_minor', { personId: person.id, platform: on, ...detail });
		return store.personById(person.id);
	};

	/** Ends it for good at their request: this persona never messages them again. */
	const stop = (person: Person, on: ChannelId, detail: Record<string, unknown>) => {
		const stopped = store.updatePerson(person.id, { state: 'stopped' });
		store.audit(persona.id, 'stopped', { personId: person.id, platform: on, ...detail });
		return stopped;
	};

	// Someone possibly under 18 (settings.decisions.minor.cautionAt): flagged for every persona (store.cautionMinor), from DMs here and from group chats
	const minorCautioned = (person: Person) => Object.entries(person.ids).some(([channel, externalId]) => store.isMinorCautioned(channel, externalId));
	/** Flags each of their accounts, unless one already is. */
	const flagMinorCaution = (person: Person, on: ChannelId, probability: number) => {
		if (minorCautioned(person)) return;
		for (const [channel, externalId] of Object.entries(person.ids)) store.cautionMinor(channel, externalId, probability);
		store.audit(persona.id, 'minor_caution', { personId: person.id, platform: on, source: 'decisions', probability });
	};

	/** One request for the checks on their new messages (age on an 18+ channel, stop), each when it is on; the persona's last reply is context only. */
	const checkIncoming = async (channel: Channel, theirNew: { text: string }[], yourLast: { text: string } | undefined) => {
		if (!decisions.enabled) return null;
		const questions: Question[] = [
			...(channel.adult && checks.minor.enabled ? [dmMinorQuestion] : []),
			...(checks.stop.enabled ? [stopQuestion] : []),
		];
		const judged = theirNew.slice(-checks.dmMessages).map((m) => clip(m.text, 500));
		if (!questions.length || !judged.length) return null;
		return decisions.ask(dmCheckInput({ personaName: persona.name, yourLast: yourLast ? clip(yourLast.text, 300) : null, theirNew: judged }), questions, ctx('dmCheck'));
	};

	/**
	 * Its day on `channel` (prompts.ts dayPrompt), each part as settings.context shows it; none outside its online time.
	 * `dm` only for a DM turn: it adds the line saying their messages waited (`firstNew`, when their first message not
	 * handled yet came) and the wrap-up near the end of its span (WRAP_UP_MS).
	 */
	const dayLines = (channel: ChannelId, dm?: { firstNew: number | undefined }) => {
		const at = now();
		const situation = situationAt(persona, at, channel);
		if (!situation) return '';
		const { context } = settings;
		const { start, end } = situation.span;
		const firstNew = dm?.firstNew;
		const waited = context.awayContext && firstNew !== undefined && firstNew < start;
		const away = waited ? { since: firstNew, reason: busyAt(persona, firstNew)?.reason ?? null } : null;
		const endingSoon = !!dm && end - at <= Math.min(WRAP_UP_MS, (end - start) / 3);
		return dayPrompt(situation, persona.timezone, { now: context.situation, upcoming: context.upcoming, away, endingSoon });
	};

	return {
		incoming({ id: channel, adult }, externalId, name, text, at = now()) {
			if (store.isDenied(channel, externalId)) return { kind: 'ignore', reason: 'denied' };
			let person = store.person(persona.id, channel, externalId) ?? store.createPerson(persona.id, channel, externalId, name);
			if (person.state !== 'active') return { kind: 'ignore', reason: person.state };
			// A message after a long silence from them starts a new conversation (the relationship counts these). One read
			// late, older than one already had, keeps their last message the newer one, and their name: the newest message
			// has the name they go by now (for someone linked across channels, the one where they last wrote)
			const newConversation = at - person.lastInAt >= settings.memory.conversationGapHours * HOUR;
			const renamed = at >= person.lastInAt && name !== '' && name !== person.name;
			person = store.updatePerson(person.id, {
				lastInAt: Math.max(person.lastInAt, at),
				...(newConversation && { conversations: person.conversations + 1 }),
				...(renamed && { name }),
			});
			store.addMessage(person.id, channel, 'in', text, at);

			// The code's own checks, first and at once (the age one on an 18+ channel); the typed checks (settings.decisions) only add to them in `compose`
			if (adult && minorSignal(text)) {
				person = denyMinor(person, channel, { source: 'regex' });
				return { kind: 'final', person, messages: [MINOR_EXIT] };
			}
			if (isStopRequest(text)) {
				person = stop(person, channel, { source: 'regex' });
				return { kind: 'final', person, messages: [STOP_ACK] };
			}
			return { kind: 'reply', person: store.personById(person.id) };
		},

		async compose(personId, channel, options = {}) {
			let person = store.personById(personId);
			if (person.state !== 'active') return { messages: [], action: 'none' };
			// The notes carry what matters from older messages, so a short window keeps each call cheap
			const history = store.history(person.id, settings.memory.historyMessages);
			const theirLast = history.findLast((m) => m.direction === 'in');
			const yourLast = history.findLast((m) => m.direction === 'out');
			// What they wrote since their last turn: one that comes in while this one is composed has a turn of its own
			const theirNew = unhandled(history, person.handledAt);

			// Typed checks of their new messages, in any wording (settings.decisions); with no answer, the turn is as without them
			const checked = await checkIncoming(channel, theirNew, yourLast);
			// The code's own checks may have ended it during the wait (a newer message), even if the check failed: theirs stands, nothing more is sent
			person = store.personById(person.id);
			if (person.state !== 'active') return { messages: [], action: 'none' };
			const pMinor = probabilityOf(checked, MINOR_QUESTION);
			const pStop = probabilityOf(checked, STOP_QUESTION);
			// Ended like the code's own checks in `incoming`, without calling the model
			if (pMinor !== null && pMinor >= checks.minor.denyAt) {
				denyMinor(person, channel.id, { source: 'decisions', probability: pMinor });
				return { messages: [MINOR_EXIT], action: 'none', final: true };
			}
			if (pStop !== null && pStop >= checks.stop.at) {
				stop(person, channel.id, { source: 'decisions', probability: pStop });
				return { messages: [STOP_ACK], action: 'none', final: true };
			}
			if (pMinor !== null && pMinor >= checks.minor.cautionAt) flagMinorCaution(person, channel.id, pMinor);
			// Read whether or not the check ran now (another persona may have flagged them), on an 18+ channel only
			const caution = !!channel.adult && minorCautioned(person);
			// Group chats only in full online time: on a short break an invitation waits (inviteWaits)
			const joinNow = fullyOnline(persona, channel.id, now());
			const invitation = channel.invitations ? options.invitation : undefined;
			const rules = rulesOn(channel);

			const task = directMessageTask({
				selfNotes: selfNotes(),
				personName: person.name,
				personNotes: person.summary,
				channel,
				memory: settings.memory,
				extraLines: options.extraLines?.(person) ?? [],
				invitation,
				joinNow,
				time: directMessageTimePrompt({
					localTime: localTime(),
					gaps: settings.context.timeSince
						? { theirLast: theirLast ? now() - theirLast.at : null, yourLast: yourLast ? now() - yourLast.at : null }
						: undefined,
					day: dayLines(channel.id, { firstNew: theirNew[0]?.at }),
					mood: moodOf(persona, now()),
					rules: rules.length > 0,
				}),
				minorCaution: caution,
				// Counted by the code, never by the model; it changes nothing in the rules or the checks
				relationship: settings.context.relationship
					? {
						relationship: relationshipOf(person.conversations, settings.memory.relationshipAfter),
						conversations: person.conversations,
						knownFor: now() - person.firstSeenAt,
					}
					: undefined,
			});
			const messages: LlmMessage[] = [
				{ role: 'system', content: system(channel, rules, task) },
				...history.map((m): LlmMessage => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text })),
			];
			const turn = parseTurn(await llm.complete(messages, { task: 'directMessage', json: true }), channel.actions?.map(({ name }) => name));
			// Ended by the code while the model wrote (a newer message): nothing is stored or sent
			if (store.personById(person.id).state !== 'active') return { messages: [], action: 'none' };
			// Never sent as it is (it would carry its notes): the queue tries again, as after any failed model call
			if (!turn) throw new Error('LLM answered unreadable JSON');

			if (turn.notes !== undefined) person = store.updatePerson(person.id, { summary: clip(turn.notes, settings.memory.personNotes) });
			if (turn.self !== undefined) store.set(persona.id, 'selfNotes', clip(turn.self, settings.memory.selfNotes));

			const reply = !turn.reply ? '' : clip(allowedLinksOnly(turn.reply), channel.maxLength);

			const { action } = turn;
			const invite = invitation === undefined ? {} : !joinNow ? { inviteWaits: true as const } : turn.acceptInvite && action === 'none' ? { acceptInvite: true as const } : {};
			if (action === 'block') {
				store.updatePerson(person.id, { state: 'blocked' });
				store.audit(persona.id, 'blocked', { personId: person.id, platform: channel.id });
			} else if (action !== 'none') store.audit(persona.id, 'action', { personId: person.id, platform: channel.id, action });
			if (!reply) return { messages: [], action, ...invite };

			return { messages: splitReply(reply, runtime.rng, settings.pacing), action, ...invite };
		},

		async composePost(channel, { rules, examples, recent }) {
			const task = postTask({ selfNotes: selfNotes(), notes: channel.notes ?? [], rules, examples, recentPosts: recent, noLinks: !!allowedHosts });
			const raw = await llm.complete(
				[
					{ role: 'system', content: system(channel, rulesOn(channel), task) },
					{ role: 'user', content: POST_REQUEST },
				],
				{ task: 'post' },
			);
			const text = allowedLinksOnly(raw.replace(/^["']|["']$/g, ''), true).trim();
			if (!text) return null;
			const post = clip(text, channel.maxLength);
			return post.length >= 10 ? post : null;
		},

		async composeGroupChatLine(chat, recent, quiet, hosted) {
			const lastMessage = recent.findLast((line) => !line.system);
			if (!lastMessage || lastMessage.mine) return null;
			const lastAt = Math.max(0, ...recent.map((line) => line.at ?? 0));
			// Nothing about timing when no line says when it was written
			const silentFor = settings.context.timeSince && lastAt ? now() - lastAt : undefined;
			const rules = rulesOn(chat);
			const time = groupChatTimePrompt({ localTime: localTime(), silentFor, day: dayLines(chat.id), mood: moodOf(persona, now()), rules: rules.length > 0 });
			const transcript = groupChatTranscript(recent, persona.name);
			// The group-chat gate, if any, ran before this (wantsToSpeak, settings.decisions.groupChatGate): here the model decides
			const task = groupChatTask({
				selfNotes: selfNotes(),
				chattiness: persona.chattiness,
				quiet,
				hosted,
				notes: chat.notes ?? [],
				targetLength: lineTarget(chat),
				time,
			});
			const raw = await llm.complete(
				[
					{ role: 'system', content: system(chat, rules, task) },
					{ role: 'user', content: transcript },
				],
				{ task: 'groupChat', json: true },
			);
			// An answer it can't read stays quiet too
			const reply = parseTurn(raw)?.reply;
			if (!reply) return null;
			return clip(allowedLinksOnly(reply).replace(/\n+/g, ' '), chat.maxLength) || null;
		},

		async wantsToSpeak(chatId, recent) {
			const gate = checks.groupChatGate;
			if (!decisions.enabled || !gate.enabled) return null;
			// At most `perHour` checks per chat in any hour, counted when asked whatever comes back; past it, as without the gate
			const at = now();
			for (const [id, times] of gateAsked) {
				const kept = times.filter((t) => at - t < HOUR);
				if (kept.length) gateAsked.set(id, kept);
				else gateAsked.delete(id);
			}
			const asked = gateAsked.get(chatId) ?? [];
			if (asked.length >= gate.perHour) return null;
			gateAsked.set(chatId, [...asked, at]);
			const answers = await decisions.ask(groupChatTranscript(recent, persona.name), groupChatGateQuestions(persona.name), ctx('groupChatGate'));
			const addressed = probabilityOf(answers, ADDRESSED_QUESTION);
			const chimeIn = scoreOf(answers, CHIME_IN_QUESTION);
			if (addressed === null || chimeIn === null) return null;
			// Chattiness is only this threshold, never in the questions
			return { speak: addressed >= gate.addressedAt || chimeIn >= gate.chimeInAt[persona.chattiness], addressed, chimeIn };
		},

		async checkGroupChatLine(chat, text) {
			const { minor } = checks;
			if (!chat.adult || !decisions.enabled || !minor.enabled || !minor.groupChats) return { level: 'none', probability: null };
			const probability = probabilityOf(await decisions.ask(groupChatLineInput(clip(text, 500)), [groupChatMinorQuestion], ctx('groupChatLine')), MINOR_QUESTION);
			if (probability === null) return { level: 'none', probability };
			return { level: probability >= minor.denyAt ? 'deny' : probability >= minor.cautionAt ? 'caution' : 'none', probability };
		},
	};
}
