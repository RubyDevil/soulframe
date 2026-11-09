import type { Channel, ChannelId } from './channel.js';
import type { Persona } from './config/personas.js';
import { DISABLED_DECISIONS, probabilityOf, scoreOf, type Decisions, type DecisionsUse, type Question } from './decisions.js';
import type { Llm, LlmMessage } from './llm.js';
import { splitReply } from './pacing.js';
import { clip, lookedCard, mediaOf, seenIn, timeLimited, unseen, type IncomingMessage, type MessageMedia, type PreviewLink, type SeenImage, type SeenLink } from './perception.js';
import { hostOf, isStopRequest, MINOR_EXIT, minorSignal, STOP_ACK, stripForeignLinks } from './safety.js';
import { followUpWindow } from './initiative.js';
import { busyAt, fullyOnline, situationAt } from './schedule.js';
import { DAY, HOUR, MINUTE, ownSettings, SECOND, taskModel, type Settings } from './settings.js';
import {
	ADDRESSED_QUESTION,
	ADULTS_ONLY_RULE,
	AFFINITY_LEVELS,
	CHIME_IN_QUESTION,
	dateTimeText,
	dayPrompt,
	directMessageTask,
	directMessageTimePrompt,
	dmCheckInput,
	dmMinorQuestion,
	FAMILIARITY_LEVELS,
	OPENER_REQUEST,
	openerTask,
	planDayText,
	groupChatGateQuestions,
	groupChatLineInput,
	groupChatMinorQuestion,
	groupChatTask,
	groupChatTimePrompt,
	groupChatTranscript,
	imagePrompt,
	IMPORTANCE_QUESTION,
	importanceQuestion,
	judgedMessage,
	messageWithMedia,
	MINOR_QUESTION,
	POST_REQUEST,
	postTask,
	SFW_RULE,
	STOP_QUESTION,
	stopQuestion,
	systemPrompt,
	type Level,
	type Trend,
} from './prompts.js';
import type { Runtime } from './runtime.js';
import type { Opener, Person, StoredMessage } from './store.js';

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
	/**
	 * Saves what the turn wrote and decided (its notes on the person and on itself, a block or an action, audited):
	 * nothing of it is stored before. The reply queue calls it once the turn is kept (its first message sent, or its
	 * messages marked handled), never for a draft it drops to write the reply again. Calling it again does nothing.
	 */
	keep?: () => void;
}

export interface ParsedTurn {
	/** `null` to say nothing. */
	reply: string | null;
	/** Rewritten notes, or `undefined` to keep them. */
	notes?: string;
	self?: string;
	/** How much the conversation matters now, 0 to 3, as the model rated it; `undefined` when it didn't. */
	importance?: number;
	/** How the exchange changed its feelings: -1 cooler, 0 none, 1 warmer; `undefined` when it didn't say. */
	affinity?: -1 | 0 | 1;
	action: PersonAction;
	acceptInvite?: true;
	/** A plan to text them first later (settings.initiative.followUps): `days` ahead and why, or false to drop the plan pending; `undefined` keeps it. */
	followUp?: { days: number; about: string } | false;
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
const FIELD_LINE = /^\s*"?(?:reply|notes|self|importance|affinity|action|followUp|acceptInvite)"?\s*:/im;

/** A number the model gave, written as one or as a numeric string; else null. */
const numberOf = (value: unknown) => {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : null;
};

/** A follow-up the model planned: `{ days, about }` with a whole number of days from 0 and a note, false (or "false") to drop it; else none. */
const followUpOf = (value: unknown): ParsedTurn['followUp'] => {
	if (value === false || value === 'false') return false;
	if (typeof value !== 'object' || value === null) return undefined;
	const { days, about } = value as Record<string, unknown>;
	const number = numberOf(days);
	const note = textOrNull(about);
	return number === null || number < 0 || note === null ? undefined : { days: Math.round(number), about: note };
};

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
	const importance = numberOf(json.importance);
	const affinity = numberOf(json.affinity);
	const followUp = followUpOf(json.followUp);
	return {
		reply: textOrNull(json.reply),
		action,
		...(notes !== null && { notes }),
		...(self !== null && { self }),
		// 0 to 3, whole; a change of feeling only ever one step
		...(importance !== null && { importance: Math.min(3, Math.max(0, Math.round(importance))) }),
		...(affinity !== null && { affinity: Math.sign(affinity) as -1 | 0 | 1 }),
		...(json.acceptInvite === true && { acceptInvite: true as const }),
		...(followUp !== undefined && { followUp }),
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
	/** The persona it is the brain of, as `createBrain` was given it. */
	readonly persona: Persona;
	/** The settings it runs with, the persona's own pacing and relationship over `createBrain`'s: its reply queue reads them here. */
	readonly settings: Settings;
	/**
	 * A message they wrote on `channel` as `name` (the name they go by there: the person keeps the one of their newest
	 * message), now unless `at` says when (one read late). `message` is their words, or those with the photos and link
	 * cards that came with them. Synchronous: a catch-up keeps its order; the looking is done in its turn.
	 */
	incoming(channel: Channel, externalId: string, name: string, message: string | IncomingMessage, at?: number): Decision;
	/**
	 * A message its account sent them on `channel` from outside the reply queue (typed by hand, say), now unless `at`
	 * says when, so later turns read it in the history as its own. Creates the person if this is the first message
	 * between them. It changes nothing in the reply queue: a turn already owed still goes ahead. The queue records what
	 * it sends itself: don't pass those here. Answers the person, or undefined (nothing recorded) when they are denied.
	 */
	outgoing(channel: Channel, externalId: string, name: string, text: string, at?: number): Person | undefined;
	/**
	 * What to do now in the conversation with the person on `channel`. Stores nothing it says (the reply queue records
	 * each message once sent), nor what it wrote and decided until the turn's `keep` is called. `invitation`: a pending
	 * group-chat invitation's name, heeded only where `channel.invitations`; `extraLines`: the app's lines for this turn
	 * (`Conversation.extraLines`), given the person as compose reads them.
	 */
	compose(personId: number, channel: Channel, options?: { invitation?: string; extraLines?: (person: Person) => readonly string[] }): Promise<Turn>;
	/**
	 * Before their turn, while others wait for the persona too: how much their new messages matter, asked with the other
	 * DM checks (settings.decisions.importance) and stored on the person (`importance`), so the reply queue can weigh their
	 * turn. `compose` then uses those answers while no newer message came, asking nothing again. Nothing is asked unless
	 * the Decisions client is on (`ServiceSettings.decisions.enabled`) and `decisions.importance.enabled`; it never
	 * throws, and a failure leaves the model's own rating.
	 */
	assess(personId: number, channel: Channel): Promise<void>;
	/**
	 * A first message to the person on `channel`, about `opener` (settings.initiative): what to text them, or no message
	 * when the model chose not to, given the history, notes, relationship and time as a DM turn has them. Stores nothing
	 * until the turn's `keep` (its notes only: familiarity and affinity move with their answer, not with an opener).
	 * Throws when the answer can't be read. The reply queue calls it, once the code's guardrails allowed the opener.
	 */
	composeOpener(personId: number, channel: Channel, opener: Pick<Opener, 'kind' | 'about'>, options?: { extraLines?: (person: Person) => readonly string[] }): Promise<Turn>;
	/** A post in its own voice for `channel` (with its `notes`), following its rules and not repeating its recent posts, or null. The app picked where and when. */
	composePost(channel: Channel, post: { rules: string; examples: readonly string[]; recent: readonly string[] }): Promise<string | null>;
	/** What to say in a group chat (`chat`, with its `notes`), or `null` to stay quiet; `quiet` when the chat went silent a while, `hosted` in its own. */
	composeGroupChatLine(chat: Channel, recent: GroupChatLine[], quiet: boolean, hosted: boolean): Promise<string | null>;
	/**
	 * Group-chat gate (settings.decisions.groupChatGate) on the chat `chatId` (the app's own id for that chat, the same on
	 * every call: its `perHour` cap counts per chat): null when off, past that cap, or on any failure or refusal; the
	 * caller then lets the model decide. It speaks when addressed (`addressedAt`) or when chiming in fits (`chimeInAt`).
	 */
	wantsToSpeak(chatId: string, recent: GroupChatLine[]): Promise<{ speak: boolean; addressed: number; chimeIn: number } | null>;
	/** Age check of one group-chat line (settings.decisions.minor.groupChats): level 'none', nothing asked, unless `chat.adult`; 'none' too when off or on any failure or refusal. */
	checkGroupChatLine(chat: Channel, text: string): Promise<{ level: 'deny' | 'caution' | 'none'; probability: number | null }>;
}

/** Characters of a follow-up's note (prompts.ts followUpField's "about"). */
const FOLLOW_UP_CHARS = 200;

/** How near the end of its span a DM turn is asked to wrap up (prompts.ts dayPrompt `endingSoon`); in a span under three times as long, its last third. */
const WRAP_UP_MS = 10 * MINUTE;

/** The soft limit of a group-chat line on `chat` (prompts.ts groupChatTask): its `targetLength`, else 150 or four fifths of its `maxLength`, whichever is less. */
const lineTarget = (chat: Channel) => chat.targetLength ?? Math.min(150, Math.floor(chat.maxLength * 0.8));

/** Their messages in a history that had no turn yet: those after `handledAt`. */
export const unhandled = <M extends { direction: 'in' | 'out'; at: number }>(history: M[], handledAt: number) =>
	history.filter((m) => m.direction === 'in' && m.at > handledAt);

/**
 * The level `value` is on (its index in `levels`, lowest first), given the one shown before (`previous`, -1 for none):
 * up as soon as it reaches a level's `from`, but down only once it falls `margin` below the `from` of the one shown, so
 * a value near a threshold does not flip between two levels.
 */
export function levelIndex(levels: readonly Level[], value: number, previous: number, margin: number): number {
	let index = 0;
	for (const [i, level] of levels.entries()) if (value >= level.from) index = i;
	return previous > index && previous < levels.length && value >= levels[previous]!.from - margin ? previous : index;
}

/** How much a kept turn adds to familiarity, by its importance (0 to 3), times `relationship.familiarity.growth`. */
const IMPORTANCE_GROWTH = [0.25, 1, 2.5, 5] as const;
/** How far familiarity must have risen above its slow-moving average for the prompt to say they grew closer, or have faded while they were apart to say things feel more distant. */
const TREND_STEP = 0.05;
/** How much of the way to familiarity its average moves at each new conversation. */
const TREND_FOLLOW = 0.4;

/** The relationship as the DM prompt shows it, set once per conversation (kv `relationship:<person id>`). */
interface Shown {
	/** The conversation it was set for (`Person.conversations`). */
	conversation: number;
	/** The levels shown (indexes in the level lists). */
	familiarity: number;
	affinity: number;
	trend: Trend;
	/** Familiarity's slow-moving average, the trend's reference. */
	baseline: number;
}

/** The app's content policy. soulframe applies none of its own beyond `Channel.adult` and, when asked, `sfw`. */
export interface Policy {
	/**
	 * Safe for work only: every prompt (DMs, group chats, posts) gets the rule to keep the conversation free of sexual or
	 * explicit content (prompts.ts SFW_RULE), after the 18+ line and before `rules`. Off by default.
	 */
	sfw?: boolean;
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
	settings: given,
	identity,
	style,
	runtime,
	llm,
	decisions = DISABLED_DECISIONS,
	policy = {},
	previewLink,
}: {
	/** Its config and prompt (`parsePersona`, `loadPersonas`). */
	persona: Persona;
	/**
	 * What it runs with: models, limits, memory, pacing, the typed checks (`parseSettings`; `parseSettings({})` for every
	 * default), the persona's own pacing and relationship over them (a ConfigError if they don't fit). Its reply queue
	 * reads them from the brain; make its model client with the same (`llmsFor`).
	 */
	settings: Settings;
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
	/** The Decisions client (`createConfiguredDecisions`), whose checks only add strictness (which run: `settings.decisions`); none by default. */
	decisions?: Decisions;
	/** The app's rules and allowed links; none by default. */
	policy?: Policy;
	/** Gets the card of a link that came without one, while it reads; none by default: such a link is only its site's name. */
	previewLink?: PreviewLink;
}): Brain {
	const settings = ownSettings(persona, given);
	const { store } = runtime;
	// Read at each use: a clock swapped on the runtime is the brain's too
	const now = () => runtime.now();
	// Which checks run and their thresholds; whether any runs at all is the client's `enabled` (off while the service settings' decisions.enabled is)
	const checks = settings.decisions;
	const ctx = (use: DecisionsUse) => ({ use, personaId: persona.id });
	const localTime = () => dateTimeText(now(), persona.timezone);
	const allowedHosts = policy.allowedLinks?.map(hostOf);
	/** `text` without the links the policy doesn't allow (in a `post`, any link); as written without `policy.allowedLinks`. */
	const allowedLinksOnly = (text: string, post = false) => (allowedHosts ? stripForeignLinks(text, post ? [] : allowedHosts) : text);
	const selfNotes = () => store.get(persona.id, 'selfNotes') ?? '';
	/** When the group-chat gate asked over the last hour, by chat (`wantsToSpeak`'s `chatId`, settings.decisions.groupChatGate.perHour). */
	const gateAsked = new Map<string, number[]>();

	/** The rules on `channel`: the 18+ line on an adult one, the sfw line of an sfw policy, then the app's. */
	const rulesOn = (channel: Channel) => [...(channel.adult ? [ADULTS_ONLY_RULE] : []), ...(policy.sfw ? [SFW_RULE] : []), ...(policy.rules ?? [])];

	// Every prompt's text is in prompts.ts (and the channel's, in the app's Channel); this only fills in the persona
	const system = (channel: Channel, task: string) =>
		systemPrompt({ personaPrompt: persona.prompt, name: persona.name, identity, style, channel, rules: rulesOn(channel), task });

	const { initiative } = settings;
	/** Whether a DM turn may plan a follow-up (settings.initiative.followUps): off, its prompt says nothing of it. */
	const followingUp = initiative.enabled && initiative.followUps.enabled;
	const lookLimit = settings.perception.timeoutSeconds * SECOND;
	const seesImages = !taskModel(settings, 'vision').off;

	/** Asks for a photo's description. No vision model, a failure, a refusal or too long a wait: its `alt`, else it didn't load. */
	const lookAtImage = async (personId: number, image: SeenImage): Promise<SeenImage> => {
		const { url, alt } = image;
		if (url === undefined) return image;
		let seen: string | null = null;
		if (seesImages) {
			try {
				const prompt = imagePrompt(settings.perception.descriptionChars);
				seen = seenIn(await timeLimited(() => llm.complete([{ role: 'user', content: prompt, images: [url] }], { task: 'vision', json: true }), lookLimit));
				if (seen === null) store.audit(persona.id, 'image_unseen', { personId, reason: 'no description' });
			} catch (error) {
				store.audit(persona.id, 'image_unseen', { personId, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		const known = seen ?? alt;
		return known ? { seen: clip(known, settings.perception.descriptionChars) } : { failed: true };
	};

	/** Asks the app for the card of a link that has none; without one, it stays its site's name. */
	const lookAtLink = async (link: SeenLink): Promise<SeenLink> => {
		if (link.looked || link.title) return link;
		try {
			const card = previewLink && (await timeLimited(() => previewLink(link.url), lookLimit));
			if (card) return lookedCard({ ...card, url: link.url });
		} catch {
			// As with no card at all
		}
		return { ...link, looked: true };
	};

	/** What is being looked at now, by message: a turn and its early checks share one look. */
	const looks = new Map<number, Promise<MessageMedia>>();

	/** `history` with every photo and link in it looked at, once, and stored: what the model and the checks read. */
	const perceive = (personId: number, history: StoredMessage[]) =>
		Promise.all(
			history.map(async (message) => {
				if (!unseen(message.media)) return message;
				let look = looks.get(message.id);
				if (!look) {
					const { images, links } = message.media!;
					look = Promise.all([Promise.all(images.map((image) => lookAtImage(personId, image))), Promise.all(links.map(lookAtLink))])
						.then(([seenImages, seenLinks]) => {
							const media = { images: seenImages, links: seenLinks };
							store.setMedia(message.id, media);
							return media;
						})
						.finally(() => looks.delete(message.id));
					looks.set(message.id, look);
				}
				return { ...message, media: await look };
			}),
		);

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
	/**
	 * One request for the checks on their new messages (age on an 18+ channel, stop), each when it is on, and with them how
	 * much the messages matter (`decisions.importance`): `alone` asks it even when no other check is on. The persona's
	 * last reply is context only.
	 */
	const checkIncoming = async (channel: Channel, theirNew: Pick<StoredMessage, 'text' | 'media'>[], yourLast: { text: string } | undefined, alone = false) => {
		if (!decisions.enabled) return null;
		const checksOn: Question[] = [
			...(channel.adult && checks.minor.enabled ? [dmMinorQuestion] : []),
			...(checks.stop.enabled ? [stopQuestion] : []),
		];
		const questions = checks.importance.enabled && (alone || checksOn.length) ? [...checksOn, importanceQuestion] : checksOn;
		const judged = theirNew.slice(-checks.dmMessages).map((m) => clip(judgedMessage(m), 500)).filter(Boolean);
		if (!questions.length || !judged.length) return null;
		return decisions.ask(dmCheckInput({ personaName: persona.name, yourLast: yourLast ? clip(yourLast.text, 300) : null, theirNew: judged }), questions, ctx('dmCheck'));
	};

	/**
	 * The checks `assess` asked ahead of a turn, by person, with how many messages they had written then: `compose` waits
	 * for one still in flight and uses its answers while nothing newer came.
	 */
	const assessed = new Map<number, Promise<{ incoming: number; answers: Awaited<ReturnType<typeof checkIncoming>> }>>();
	/** Stores how much their messages matter, as a check rated it (a stored check outcome, as a caution flag is). */
	const rateImportance = (personId: number, answers: Awaited<ReturnType<typeof checkIncoming>>) => {
		const rated = scoreOf(answers, IMPORTANCE_QUESTION);
		if (rated !== null) store.updatePerson(personId, { importance: rated, importanceAt: now() });
	};

	const { relationship } = settings;
	const familiarityLevels = relationship.familiarity.levels ?? FAMILIARITY_LEVELS;
	const affinityLevels = relationship.affinity.levels ?? AFFINITY_LEVELS;
	const relationshipKey = (personId: number) => `relationship:${personId}`;
	/** The relationship as shown in their conversation so far, if it was set. */
	const shownOf = (person: Person): Shown | undefined => {
		try {
			return JSON.parse(store.get(persona.id, relationshipKey(person.id)) ?? 'null') ?? undefined;
		} catch {
			return undefined;
		}
	};
	/**
	 * A new conversation with them, after `apartMs` apart: familiarity fades for that time, and affinity when it drifts
	 * (`fadeHalfLifeDays`), and the relationship the prompt shows is set for the whole conversation: each level from the
	 * one shown before (the hysteresis margin), and the way familiarity went against its slow-moving average.
	 */
	const startConversation = (person: Person, apartMs: number) => {
		const fade = (value: number, halfLifeDays: number) => (halfLifeDays > 0 ? value * 0.5 ** (apartMs / (halfLifeDays * DAY)) : value);
		const familiarity = fade(person.familiarity, relationship.familiarity.fadeHalfLifeDays);
		const affinity = fade(person.affinity, relationship.affinity.fadeHalfLifeDays);
		const before = shownOf(person);
		const baseline = before?.baseline ?? familiarity;
		const drift = familiarity - baseline;
		// Apart long enough to lose some: more distant; else closer when it rose well above its average
		const trend: Trend = person.familiarity - familiarity >= TREND_STEP ? 'distant' : drift >= TREND_STEP ? 'closer' : null;
		const shown: Shown = {
			conversation: person.conversations,
			familiarity: levelIndex(familiarityLevels, familiarity, before?.familiarity ?? -1, relationship.hysteresis),
			affinity: levelIndex(affinityLevels, affinity, before?.affinity ?? -1, relationship.hysteresis),
			trend,
			baseline: baseline + drift * TREND_FOLLOW,
		};
		store.set(persona.id, relationshipKey(person.id), JSON.stringify(shown));
		return { person: store.updatePerson(person.id, { familiarity, affinity }), shown };
	};

	/** How things stand with them as the DM prompt says it, set for their conversation (set now when it was not, as for someone known before levels were kept). */
	const relationshipNow = (person: Person) => {
		const shown = shownOf(person)?.conversation === person.conversations ? shownOf(person)! : startConversation(person, 0).shown;
		return {
			familiarity: familiarityLevels[shown.familiarity],
			...(relationship.affinity.enabled && { affinity: affinityLevels[shown.affinity] }),
			trend: shown.trend,
			conversations: person.conversations,
			knownFor: now() - person.firstSeenAt,
		};
	};

	/** The follow-up pending with them, as a DM turn shows it, if any. */
	const pendingPlan = (personId: number) => {
		const pending = store.pendingOpener(personId);
		return pending ? { when: planDayText(pending.dueAt, now(), persona.timezone), about: pending.about } : undefined;
	};
	/** A follow-up a kept turn planned (`days` ahead, at most followUps.maxDays), replacing the one pending; false drops it. */
	const planFollowUp = (personId: number, plan: { days: number; about: string } | false) => {
		if (plan === false) {
			const pending = store.pendingOpener(personId);
			if (!pending) return;
			store.closeOpener(pending.id, 'dropped');
			store.audit(persona.id, 'follow_up_dropped', { personId });
			return;
		}
		const days = Math.min(plan.days, initiative.followUps.maxDays);
		const opener = store.planOpener(persona.id, personId, { kind: 'followUp', about: clip(plan.about, FOLLOW_UP_CHARS), ...followUpWindow(now(), days, persona.timezone) });
		store.audit(persona.id, 'follow_up_planned', { personId, days, dueAt: opener.dueAt });
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
		persona,
		settings,

		incoming({ id: channel, adult }, externalId, name, message, at = now()) {
			const sent = typeof message === 'string' ? { text: message } : message;
			// The code's own checks below read only their words: a headline or a sign in a photo is not them saying it
			const { text } = sent;
			if (store.isDenied(channel, externalId)) return { kind: 'ignore', reason: 'denied' };
			let person = store.person(persona.id, channel, externalId) ?? store.createPerson(persona.id, channel, externalId, name);
			if (person.state !== 'active') return { kind: 'ignore', reason: person.state };
			// A message after a long silence from them starts a new conversation (the relationship counts these). One read
			// late, older than one already had, keeps their last message the newer one, and their name: the newest message
			// has the name they go by now (for someone linked across channels, the one where they last wrote)
			const newConversation = at - person.lastInAt >= settings.memory.conversationGapHours * HOUR;
			const apart = at - person.lastInAt;
			const renamed = at >= person.lastInAt && name !== '' && name !== person.name;
			person = store.updatePerson(person.id, {
				lastInAt: Math.max(person.lastInAt, at),
				...(newConversation && { conversations: person.conversations + 1 }),
				...(renamed && { name }),
			});
			// What they were apart fades, and how things stand is set for this conversation
			if (newConversation) person = startConversation(person, apart).person;
			store.addMessage(person.id, channel, 'in', text, at, mediaOf(sent, settings.perception));

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

		outgoing({ id: channel }, externalId, name, text, at = now()) {
			if (store.isDenied(channel, externalId)) return undefined;
			const person = store.person(persona.id, channel, externalId) ?? store.createPerson(persona.id, channel, externalId, name);
			store.addMessage(person.id, channel, 'out', text, at);
			return person;
		},

		async compose(personId, channel, options = {}) {
			let person = store.personById(personId);
			if (person.state !== 'active') return { messages: [], action: 'none' };
			// The notes carry what matters from older messages, so a short window keeps each call cheap. A photo or link that
			// came since is looked at here, while the reply queue shows it being read
			const history = await perceive(person.id, store.history(person.id, settings.memory.historyMessages));
			const theirLast = history.findLast((m) => m.direction === 'in');
			const yourLast = history.findLast((m) => m.direction === 'out');
			// What they wrote since their last turn: one that comes in while this one is composed has a turn of its own
			const theirNew = unhandled(history, person.handledAt);

			// Typed checks of their new messages, in any wording (settings.decisions); with no answer, the turn is as without them.
			// Those `assess` asked as their turn came due stand while no newer message came
			const early = await assessed.get(person.id);
			assessed.delete(person.id);
			const checked = early?.answers && early.incoming === person.incoming ? early.answers : await checkIncoming(channel, theirNew, yourLast);
			if (checked !== early?.answers) rateImportance(person.id, checked);
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
			const photos = history.some((m) => m.media?.images.length);
			const links = history.some((m) => m.media?.links.length);

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
				}),
				minorCaution: caution,
				// Counted by the code, never by the model; it changes nothing in the rules or the checks
				relationship: settings.context.relationship ? relationshipNow(person) : undefined,
				affinity: relationship.affinity.enabled,
				...(photos || links ? { media: { photos, links } } : {}),
				...(followingUp && { followUp: { maxDays: initiative.followUps.maxDays, pending: pendingPlan(person.id) } }),
			});
			const messages: LlmMessage[] = [
				{ role: 'system', content: system(channel, task) },
				...history.map((m): LlmMessage => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: messageWithMedia(m) })),
			];
			const turn = parseTurn(await llm.complete(messages, { task: 'directMessage', json: true }), channel.actions?.map(({ name }) => name));
			// Ended by the code while the model wrote (a newer message): nothing is stored or sent
			if (store.personById(person.id).state !== 'active') return { messages: [], action: 'none' };
			// Never sent as it is (it would carry its notes): the queue tries again, as after any failed model call
			if (!turn) throw new Error('LLM answered unreadable JSON');

			const reply = !turn.reply ? '' : clip(allowedLinksOnly(turn.reply), channel.maxLength);

			const { action } = turn;
			const invite = invitation === undefined ? {} : !joinNow ? { inviteWaits: true as const } : turn.acceptInvite && action === 'none' ? { acceptInvite: true as const } : {};
			let kept = false;
			// Stored only once the queue keeps the turn: a draft it drops leaves nothing behind
			const keep = () => {
				if (kept) return;
				kept = true;
				const id = person.id;
				if (turn.notes !== undefined) store.updatePerson(id, { summary: clip(turn.notes, settings.memory.personNotes) });
				if (turn.self !== undefined) store.set(persona.id, 'selfNotes', clip(turn.self, settings.memory.selfNotes));
				// What the turn meant: familiarity grows by its importance (unrated, an ordinary chat), affinity moves one step at most
				const { familiarity, affinity } = store.personById(id);
				const gain = Math.min(1, relationship.familiarity.growth * IMPORTANCE_GROWTH[turn.importance ?? 1]!);
				store.updatePerson(id, {
					familiarity: familiarity + (1 - familiarity) * gain,
					...(relationship.affinity.enabled && turn.affinity && { affinity: Math.min(1, Math.max(-1, affinity + relationship.affinity.step * turn.affinity)) }),
					...(turn.importance !== undefined && { importance: turn.importance, importanceAt: now() }),
				});
				if (followingUp && turn.followUp !== undefined) planFollowUp(id, turn.followUp);
				if (action === 'block') {
					store.updatePerson(id, { state: 'blocked' });
					store.audit(persona.id, 'blocked', { personId: id, platform: channel.id });
				} else if (action !== 'none') store.audit(persona.id, 'action', { personId: id, platform: channel.id, action });
			};
			if (!reply) return { messages: [], action, ...invite, keep };

			return { messages: splitReply(reply, runtime.rng, settings.pacing), action, ...invite, keep };
		},

		async assess(personId, channel) {
			if (!decisions.enabled || !checks.importance.enabled) return;
			const person = store.personById(personId);
			if (person.state !== 'active') return;
			const found = store.history(person.id, settings.memory.historyMessages);
			const check = (history: StoredMessage[]) =>
				checkIncoming(channel, unhandled(history, person.handledAt), history.findLast((m) => m.direction === 'out'), true).then((answers) => {
					rateImportance(person.id, answers);
					return { incoming: person.incoming, answers };
				});
			// Set before its first wait, so `compose` finds it; a photo is looked at once, for the two of them
			const asking = found.some((m) => unseen(m.media)) ? perceive(person.id, found).then(check) : check(found);
			assessed.set(person.id, asking);
			await asking;
		},

		async composeOpener(personId, channel, opener, options = {}) {
			const person = store.personById(personId);
			if (person.state !== 'active') return { messages: [], action: 'none' };
			const history = await perceive(person.id, store.history(person.id, settings.memory.historyMessages));
			const theirLast = history.findLast((m) => m.direction === 'in');
			const yourLast = history.findLast((m) => m.direction === 'out');
			const photos = history.some((m) => m.media?.images.length);
			const links = history.some((m) => m.media?.links.length);
			const task = openerTask({
				selfNotes: selfNotes(),
				personName: person.name,
				personNotes: person.summary,
				memory: settings.memory,
				extraLines: options.extraLines?.(person) ?? [],
				about: opener.about,
				time: directMessageTimePrompt({
					localTime: localTime(),
					gaps: settings.context.timeSince ? { theirLast: theirLast ? now() - theirLast.at : null, yourLast: yourLast ? now() - yourLast.at : null } : undefined,
					day: dayLines(channel.id),
				}),
				relationship: settings.context.relationship ? relationshipNow(person) : undefined,
				...(photos || links ? { media: { photos, links } } : {}),
			});
			const messages: LlmMessage[] = [
				{ role: 'system', content: system(channel, task) },
				...history.map((m): LlmMessage => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: messageWithMedia(m) })),
				{ role: 'user', content: OPENER_REQUEST },
			];
			const parsed = parseTurn(await llm.complete(messages, { task: 'initiative', json: true }));
			// Ended while the model wrote: nothing is stored or sent
			if (store.personById(person.id).state !== 'active') return { messages: [], action: 'none' };
			if (!parsed) throw new Error('LLM answered unreadable JSON');
			const reply = parsed.reply ? clip(allowedLinksOnly(parsed.reply), channel.maxLength) : '';
			let kept = false;
			const keep = () => {
				if (kept) return;
				kept = true;
				if (parsed.notes !== undefined) store.updatePerson(person.id, { summary: clip(parsed.notes, settings.memory.personNotes) });
				if (parsed.self !== undefined) store.set(persona.id, 'selfNotes', clip(parsed.self, settings.memory.selfNotes));
			};
			return { messages: reply ? splitReply(reply, runtime.rng, settings.pacing) : [], action: 'none', keep };
		},

		async composePost(channel, { rules, examples, recent }) {
			const task = postTask({ selfNotes: selfNotes(), notes: channel.notes ?? [], rules, examples, recentPosts: recent, noLinks: !!allowedHosts });
			const raw = await llm.complete(
				[
					{ role: 'system', content: system(channel, task) },
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
			const time = groupChatTimePrompt({ localTime: localTime(), silentFor, day: dayLines(chat.id) });
			const transcript = groupChatTranscript(recent, persona.name);
			// The group-chat gate, if any, ran before this (wantsToSpeak, settings.decisions.groupChatGate): here the model decides
			const task = groupChatTask({
				selfNotes: selfNotes(),
				quiet,
				hosted,
				notes: chat.notes ?? [],
				targetLength: lineTarget(chat),
				time,
			});
			const raw = await llm.complete(
				[
					{ role: 'system', content: system(chat, task) },
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
			// How readily it chimes in is only this threshold, never in the questions
			return { speak: addressed >= gate.addressedAt || chimeIn >= gate.chimeInAt, addressed, chimeIn };
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
