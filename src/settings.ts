/**
 * Every setting, with its default, in one place, in two kinds:
 * - a brain's `Settings`: what a brain, its reply queue and its model client run with, the same object for every
 *   persona or one of their own (`createBrain({ settings })`, and the same to `llmsFor`), read with `parseSettings`;
 * - the `ServiceSettings`: what every persona shares, set once (the text provider's budget, the Decisions client), read
 *   with `parseServiceSettings`; the app builds the token meters, the model clients and the Decisions client from it.
 * Neither is part of a persona's config. Anything left out keeps the default below. Secrets (API keys, passwords,
 * tokens) never go there: only the names of the environment variables that hold them. The app's own settings
 * (message limits, its channels' timings, retention, the request rate) are not here (the app's config).
 *
 * Text generation (`models`, `ServiceSettings.text`) and the Decisions API (`decisions`, `ServiceSettings.decisions`)
 * are configured apart: neither reads the other's block.
 */

import { z } from 'zod';
import { ConfigError, schemaProblems, sourced, unknownKeyProblems, unknownKeys, type Problem } from './config/issues.js';
import { deepMerge } from './merge.js';

/** [least, most]: the bounds a value is kept within, or drawn from evenly (soulframe's own drawn ranges are `drawn`, with a shape). */
export const range = (min: number, max: number, floor = 0) =>
	z
		.tuple([z.number().min(floor), z.number().min(floor)])
		.default([min, max])
		.refine(([low, high]) => low <= high, 'the first number must not be above the second');

/**
 * How the values of a drawn range spread between its least and its most: `uniform`, any value as likely as any other;
 * `normal`, most near the middle (a bell curve, about 95% inside the range), for a speed someone keeps close to;
 * `lognormal`, skewed like the times people take (most near a typical value, a few much longer), its median the
 * geometric middle of the range (pacing.ts drawIn).
 */
export const SHAPES = ['uniform', 'normal', 'lognormal'] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * A range a value is drawn from each time, with the shape of its draws: `[least, most]` keeps this setting's own shape,
 * `{ range: [least, most], shape }` sets it. Read as `{ range, shape }` either way.
 */
export const drawn = (min: number, max: number, shape: Shape, floor = 0) => {
	const pair = z
		.tuple([z.number().min(floor), z.number().min(floor)])
		.refine(([low, high]) => low <= high, 'the first number must not be above the second');
	return z
		.union([pair, z.object({ range: pair, shape: z.enum(SHAPES).default(shape) }).strict()])
		.default([min, max])
		.transform((value): { range: [number, number]; shape: Shape } => (Array.isArray(value) ? { range: value, shape } : value));
};

/**
 * A probability up to 1 at or above which a check acts. The floor (0.3 unless given) keeps one mistyped
 * value from making a check hit everyone: at 0, even a probability of 0 would count.
 */
const at = (value: number, min = 0.3) => z.number().min(min).max(1).default(value);

/**
 * Levels a value is described by in the prompt, lowest first: each from its `from` up to the next one's, its `text`
 * with {name} for the person's name (an empty text says nothing). The first starts at `min`, the lowest the value goes.
 */
const levels = (min: number) =>
	z
		.array(z.object({ from: z.number().min(min).max(1), text: z.string().max(400) }).strict())
		.min(2)
		.max(12)
		.refine((list) => list[0]?.from === min, `the first level must start at ${min}`)
		.refine((list) => list.every((level, i) => i === 0 || level.from > list[i - 1]!.from), 'each level must start above the one before');

/** The text tasks, each with its model settings (`models.<task>`), the photo describer (`vision`) among them. */
export const TASKS = ['directMessage', 'groupChat', 'post', 'vision'] as const;
export type Task = (typeof TASKS)[number];

/** The provider and model every task uses unless it names its own (`models.default`). */
const DefaultModelSchema = z
	.object({
		/** The provider's OpenAI-compatible base URL, e.g. https://api.provider.example/v1. */
		baseUrl: z.string().url().optional(),
		/** The key's environment variable; empty for a local provider without authentication. */
		apiKeyEnv: z.string().default('LLM_API_KEY'),
		/** The model of every text task that doesn't name its own (never `vision`'s: it may not take images). */
		model: z.string().min(1).optional(),
		/** Ask the provider for strict JSON answers (`response_format: json_object`); only for providers that support it. */
		jsonMode: z.boolean().default(false),
		/** Seconds before a request is given up (it is retried once). */
		timeoutSeconds: z.number().min(5).max(300).default(60),
	})
	.default({});

/**
 * One kind of text generation task: its own answer limits, and the model it uses, `models.default`'s unless it names
 * its own. With a `baseUrl` of its own it is on another provider: it then takes nothing of that provider from
 * `default` (no key, no model, no jsonMode), and names its own `model` and `apiKeyEnv` (empty for none), so the
 * default provider's key never reaches another host.
 */
const TaskModelSchema = (defaults: { maxTokens: number; temperature: number }) =>
	z
		.object({
			/** The model's name at its provider; else `default.model` (never for `vision`, nor on a provider of its own). */
			model: z.string().min(1).optional(),
			/** Another provider for this task only (its OpenAI-compatible base URL); else `default.baseUrl`. */
			baseUrl: z.string().url().optional(),
			/** The key's environment variable; else `default.apiKeyEnv` on the default provider. Empty disables authentication. */
			apiKeyEnv: z.string().optional(),
			/** Ask its provider for strict JSON; else `default.jsonMode` on the default provider, off on its own. */
			jsonMode: z.boolean().optional(),
			/** Seconds before its request is given up; else `default.timeoutSeconds`. */
			timeoutSeconds: z.number().min(5).max(300).optional(),
			/** The most tokens the answer may hold. */
			maxTokens: z.number().int().min(16).max(4000).default(defaults.maxTokens),
			/** 0 to 2: higher is more varied, lower more predictable. */
			temperature: z.number().min(0).max(2).default(defaults.temperature),
		})
		.default({});

export const SettingsSchema = z
	.object({
		/**
		 * The text provider and a model per kind of task, for text generation only: any OpenAI-compatible chat
		 * completions API (the provider and its model decide what content they allow). `default` is the provider and the
		 * model of every task that names none; a task may name a cheaper model (group chats, mostly "stay quiet") or
		 * another provider. The Decisions API (`decisions`) never reads it. The budget every persona shares is the
		 * service settings' (`ServiceSettings.text`).
		 */
		models: z
			.object({
				/** The provider and model of every task that names none. Not a task itself. */
				default: DefaultModelSchema,
				/** A turn of a direct message conversation (the reply, the notes, the action). */
				directMessage: TaskModelSchema({ maxTokens: 400, temperature: 0.9 }),
				/** Whether to say something in a group chat, and what. */
				groupChat: TaskModelSchema({ maxTokens: 100, temperature: 0.9 }),
				/** A post in a channel. */
				post: TaskModelSchema({ maxTokens: 160, temperature: 1 }),
				/**
				 * Describing a photo someone sent in a DM, once, when it is looked at. Called only with `model` set here (never
				 * `default.model`, which may not take images): left out, photos show as not loading. A chat model that takes
				 * images can be named here too.
				 */
				vision: TaskModelSchema({ maxTokens: 200, temperature: 0.2 }),
			})
			.default({}),

		/** What comes with a message in a DM: its photos (`models.vision`) and the preview cards of its links, which is all it knows of a link. */
		perception: z
			.object({
				/** Characters of a photo's description, stored with the message and sent with every turn it stays in the history. */
				descriptionChars: z.number().int().min(40).max(2000).default(400),
				/** The most photos of one message that are looked at; 0 for none. */
				imagesPerMessage: z.number().int().min(0).max(10).default(4),
				/** The most links of one message it notices; 0 leaves them plain text, with no rule against claiming to have opened them. */
				linksPerMessage: z.number().int().min(0).max(10).default(3),
				/** Seconds a photo's description or a link's card may take; past them it goes on without it. */
				timeoutSeconds: z.number().min(1).max(120).default(15),
			})
			.strict()
			.default({}),

		/**
		 * Which typed checks a brain asks of the Decisions client, and the thresholds that act on its answers (the
		 * questions are in prompts.ts). Whether any check runs at all, and the client itself (its endpoint, key, model,
		 * timeout and daily tokens), are the service settings' (`ServiceSettings.decisions`): one client for every
		 * persona. Additive only: the code's own checks (safety.ts) run first and stay authoritative; any failure,
		 * timeout, refusal or spent budget behaves exactly as if the checks were off. The age check runs only on 18+
		 * channels (`Channel.adult`); elsewhere its settings do not apply. The thresholds are not calibrated: tune them
		 * from the audit rows, which record each probability.
		 */
		decisions: z
			.object({
				/** The person's newest messages (since the persona's last reply) sent with each DM check. */
				dmMessages: z.number().int().min(1).max(20).default(6),
				/** Signs the writer is under 18, in DMs and in group chats, after the code's own check: on 18+ channels only (`Channel.adult`). */
				minor: z
					.object({
						/** Whether to run the age check at all. */
						enabled: z.boolean().default(true),
						/** At or above: the same as the code's own check (they are told goodbye and deny-listed for good, every persona, every channel). 0.5 to 1. */
						denyAt: at(0.9, 0.5),
						/**
						 * At or above, below denyAt: the person is flagged for every persona, and their DM prompt then says no sexual or
						 * suggestive talk with them (prompts.ts MINOR_CAUTION_PROMPT); for a group-chat line, `checkGroupChatLine`
						 * answers 'caution' and the app is meant never to answer it in that chat. Nobody is deny-listed. 0.3 to 1.
						 */
						cautionAt: at(0.5),
						/** Also check each line people write in group chats. */
						groupChats: z.boolean().default(true),
					})
					.default({})
					.refine((m) => m.cautionAt <= m.denyAt, 'minor.cautionAt must not be above minor.denyAt'),
				/** Asking to stop being messaged, however it is worded (stopping is for good, hence the high bar). */
				stop: z
					.object({
						/** Whether to run the stop check at all. */
						enabled: z.boolean().default(true),
						/** Probability at or above which it is treated as a stop (for good). 0.5 to 1. */
						at: at(0.9, 0.5),
					})
					.default({}),
				/**
				 * How much their newest messages matter (small talk to something big, like a confession), asked with the other DM
				 * checks when their turn comes due while others wait, so the queue knows before the model writes (`pacing.priority`).
				 * Off, or on any failure, the model's own rating of their last turn is used. Its own switch: off here costs nothing
				 * extra even with the checks on, and with the stop and age checks off it is a request of its own.
				 */
				importance: z
					.object({
						/** Whether to ask it at all (only ever with the Decisions client on: `ServiceSettings.decisions.enabled`). */
						enabled: z.boolean().default(true),
					})
					.default({}),
				/** The group-chat gate: a cheap check decides quiet vs speak before the group-chat model is called (a failure lets the model decide as before). */
				groupChatGate: z
					.object({
						/** Whether to gate group chats at all; off, the model decides every time as before. */
						enabled: z.boolean().default(true),
						/** Probability the newest lines are addressed to the persona at or above which it speaks. 0 to 1 (0 always speaks, as without the gate). */
						addressedAt: at(0.5, 0),
						/**
						 * "Chime in" score (0 intrude, 1 optional, 2 opening, 3 expected) at or above which it speaks: higher for a
						 * persona that rarely speaks unasked (about 2.2 waits for a clear opening), lower for a chatty one (about
						 * 1.2 takes even an optional remark).
						 */
						chimeInAt: z
							.number({
								// The 0.1 betas' one per chattiness says where it went; any other wrong value gets the usual message
								errorMap: (issue, ctx) => ({
									message: issue.code === 'invalid_type' && issue.received === 'object' ? 'one number: a threshold per chattiness is gone (give a brain its own)' : ctx.defaultError,
								}),
							})
							.min(0)
							.max(3)
							.default(1.7),
						/** The most gate checks per group chat per hour (counted by `wantsToSpeak`, per its `chatId`); past it, the model decides as before. */
						perHour: z.number().int().min(1).default(120),
					})
					.default({}),
			})
			.default({}),

		/** The model's own small memory, rewritten by it each turn. */
		memory: z
			.object({
				/** Characters of notes on each person. */
				personNotes: z.number().int().min(0).max(2000).default(280),
				/** Characters of notes on itself (the made-up details it must keep consistent), shared by all its conversations. */
				selfNotes: z.number().int().min(0).max(2000).default(800),
				/** Messages of the conversation sent with each turn (the notes carry what matters from older ones). */
				historyMessages: z.number().int().min(2).max(100).default(20),
				/** Hours without a message from them after which their next one starts a new conversation (the relationship shown is set again at each). */
				conversationGapHours: z.number().min(0.5).max(168).default(6),
			})
			.default({}),

		/**
		 * How it comes to know and like each person, kept for each of them. Familiarity (0 to 1) is counted by the code:
		 * each turn it keeps adds to it, more when the conversation mattered (the turn's importance), and it fades while
		 * they are apart. Affinity (-1 to 1) is moved one small step per turn by the model, never set outright. Both decide
		 * who it answers first when several wait (`pacing.priority`), and the DM prompt describes them as levels, set once
		 * per conversation: the shipped ones (prompts.ts) unless replaced here, thresholds and words alike.
		 */
		relationship: z
			.object({
				familiarity: z
					.object({
						/** The share of what is left to know that an ordinary turn (importance 1) adds: small talk adds a quarter of it, a turn that matters a lot five times. */
						growth: z.number().min(0).max(0.5).default(0.012),
						/** Days apart over which it halves, counted when they next write; 0 never fades. */
						fadeHalfLifeDays: z.number().min(0).max(3650).default(60),
						/** The levels the prompt describes, lowest first: each from its `from` (0 to 1, the first 0), its `text` with {name} for their name. Left out: the shipped seven. */
						levels: levels(0).optional(),
					})
					.strict()
					.default({}),
				affinity: z
					.object({
						/** Whether to keep it at all: off, the model is asked nothing about it, the prompt says nothing of it, and it weighs nothing. */
						enabled: z.boolean().default(true),
						/** How far one turn may move it: the model answers -1, 0 or 1. */
						step: z.number().min(0.001).max(0.5).default(0.05),
						/** Days apart over which it drifts halfway back to neutral, counted when they next write; 0 never. */
						fadeHalfLifeDays: z.number().min(0).max(3650).default(0),
						/** The levels the prompt describes, lowest first: each from its `from` (-1 to 1, the first -1), its `text` with {name}; an empty text says nothing. Left out: the shipped five. */
						levels: levels(-1).optional(),
					})
					.strict()
					.default({}),
				/** How far below a level's threshold a value must fall before the level shown goes back down: no flip-flop around one. */
				hysteresis: z.number().min(0).max(0.5).default(0.05),
			})
			.strict()
			.default({}),

		/** How fast it answers and types. */
		pacing: z
			.object({
				/**
				 * While it is on its phone, a new message from anyone is noticed after a short lag: right after a turn with
				 * anyone the chance starts at 1 and halves every `halfLifeSeconds` (1 while it writes a reply), so a live
				 * conversation with one person doesn't leave another waiting for its next glance, and a pause of a few minutes
				 * means it put the phone down. An interruption since then (`interruptions`) means it looked away.
				 */
				watching: z
					.object({
						/** Seconds after its last turn with anyone over which the chance that it is still on its phone halves. */
						halfLifeSeconds: z.number().min(1).max(3600).default(90),
						/** Seconds after its last turn with someone over which the chance that it still has their chat open halves: their weight when several wait (`priority`). */
						chatHalfLifeSeconds: z.number().min(1).max(3600).default(90),
						/** The lag before it answers while watching (also every delay on a short break, when it is on its phone anyway): half are shorter than this, in seconds. */
						medianSeconds: z.number().min(0.1).max(600).default(4),
						/** …and nine in ten shorter than this (above the median): how far the slow ones go. */
						p90Seconds: z.number().min(0.1).max(3600).default(8),
						/** The shortest and longest, in seconds. */
						delaySeconds: range(2, 20),
					})
					.strict()
					.default({})
					.refine((watching) => watching.p90Seconds > watching.medianSeconds, 'p90Seconds must be above medianSeconds'),
				/**
				 * Not watching: the time until it next glances at its messages. Skewed like real answer times (a log-normal
				 * distribution): most come within a minute, around a typical time, and a few take much longer.
				 */
				glance: z
					.object({
						/** Half of its glances come sooner than this, in seconds. */
						medianSeconds: z.number().min(1).max(3600).default(40),
						/** …and nine in ten sooner than this (above the median): how long the tail is. */
						p90Seconds: z.number().min(1).max(7200).default(150),
						/** The shortest and longest, in seconds; the least is also the shortest time a reply must still fit in its span. */
						delaySeconds: range(4, 900),
					})
					.strict()
					.default({})
					.refine((glance) => glance.p90Seconds > glance.medianSeconds, 'p90Seconds must be above medianSeconds'),
				/**
				 * Now and then, while online (not on a short break), something takes it away from its messages for a few
				 * minutes: nobody's turn starts until it is back (one under way is finished first), and it is watching no chat
				 * when it comes back. Drawn per day from a seed, like its agenda, so a restart finds the same ones. Not in
				 * the middle of a conversation that matters: one that comes then waits until it calms down. A planned leave
				 * (the end of its online time) is its agenda's, and comes whatever the conversation.
				 */
				interruptions: z
					.object({
						/** Minutes of online time between two, on average (they come at random moments: a memoryless clock); 0 for none. */
						meanMinutes: z
							.number()
							.min(0)
							.max(1440)
							.default(40)
							.refine((minutes) => minutes === 0 || minutes >= 1, 'must be 0 (none) or at least 1'),
						/** How long each lasts, in minutes (never past the end of its span). */
						minutes: drawn(2, 8, 'lognormal'),
						/**
						 * The importance (0 small talk to 3 something that matters a lot) at or above which a conversation holds an
						 * interruption off: 2, something personal, by default; 4 never holds one off.
						 */
						holdAtImportance: z.number().min(0).max(4).default(2),
						/** Minutes without an exchange after which such a conversation has calmed down, and a held interruption may come. */
						calmMinutes: z.number().min(0.5).max(120).default(5),
					})
					.strict()
					.default({}),
				/** Who goes first when several are due at once (one person at a time: while it answers one, the others wait). */
				priority: z
					.object({
						/**
						 * Picked at random by weight: how close it is to them (`relationship`), how much their conversation matters now
						 * (its importance), whether it is still watching their chat, and how long they have waited. false: in the order
						 * they came due.
						 */
						weighted: z.boolean().default(true),
						/** Minutes of waiting that add their whole weight again (it grows as 1 + waited / agingMinutes), so nobody waits forever. */
						agingMinutes: z.number().min(0.1).max(120).default(2),
						/** Minutes over which the importance of their conversation fades halfway back to that of an ordinary chat. */
						importanceHalfLifeMinutes: z.number().min(1).max(1440).default(30),
					})
					.strict()
					.default({}),
				/** Typing speed, in characters per second; the typing indicator shows for as long as the message would take. */
				typingCharsPerSecond: drawn(3.5, 7, 'normal', 0.5),
				/** The shortest and longest the typing indicator shows for one message, in seconds (thinking pauses come on top). */
				typingDurationSeconds: range(1.5, 45),
				/** Reading speed, in characters per second: before it types, it spends as long as it takes to read what they wrote (the unread messages together). */
				readingCharsPerSecond: drawn(15, 25, 'normal', 1),
				/** The shortest and longest the reading takes, in seconds. */
				readingDurationSeconds: range(1, 20),
				/** Seconds it spends on each photo, on top of the reading. */
				looking: drawn(1.5, 5, 'lognormal'),
				/** Pauses while typing a long message: the indicator goes off a moment, as when someone stops to think, then on again. */
				thinkingPauses: z
					.object({
						/** The chance of each pause (up to `max` in one message); 0, the default, for none. */
						chance: z.number().min(0).max(1).default(0),
						/** The shortest message, in characters, that may have one. */
						minChars: z.number().int().min(1).default(120),
						/** The most pauses in one message. */
						max: z.number().int().min(1).max(3).default(2),
						/** How long each pause lasts, typing off. */
						seconds: drawn(2, 6, 'lognormal'),
					})
					.strict()
					.default({}),
				/**
				 * Someone who writes in bursts, several messages in a row: how long it waits for them to finish before it starts the
				 * reply, and what a message that comes in while it writes one does.
				 */
				burst: z
					.object({
						/** Seconds of quiet after their newest message before it starts writing the reply; a message in that time starts the wait again. [0, 0] for none. */
						settleSeconds: drawn(2, 5, 'lognormal'),
						/** The most messages that may start the wait again; past them it starts writing anyway, so someone who never stops still gets a reply. */
						maxSettleResets: z.number().int().min(0).max(20).default(3),
						/**
						 * A message that comes in while it writes the reply, before the first message of it is sent: the draft is dropped
						 * and written again with that message read. Off, that message gets a turn of its own once this one is sent.
						 */
						restartOnNewMessage: z.boolean().default(true),
						/** The most times in a row one reply may be written again so. Each costs a whole DM turn of tokens (the dropped draft is paid for): personaWarnings warns above 1. */
						maxRestarts: z.number().int().min(1).max(5).default(1),
					})
					.strict()
					.default({}),
				/** Seconds between two messages of the same reply. */
				betweenReplyMessagesSeconds: drawn(0.8, 3.5, 'lognormal'),
				/** Chance that a long reply (over 90 characters) is sent as two messages. */
				replySplitChance: z.number().min(0).max(1).default(0.35),
				/** Extra minutes after a span opens, before the first backlog reply of that span; [0, 0] disables the extra wait. */
				returnOnlineReplyDelayMinutes: drawn(0, 0, 'lognormal'),
				/** Seconds before each backlog conversation: messages that came in offline are answered one person at a time, oldest first. */
				backlogGapSeconds: drawn(30, 150, 'lognormal'),
			})
			.strict()
			.default({}),

		/** What the model is told: false leaves that text out of the prompt, and nothing else changes (hours, presence and pacing included). */
		context: z
			.object({
				/**
				 * What it is doing now, while online: "Right now you're at work, on a short break until about 12:50 PM…"; and in a DM in
				 * the last 10 minutes of a span (the last third of a shorter one), the wrap-up: "Your break is nearly over…".
				 */
				situation: z.boolean().default(true),
				/** What comes next: "After that you're back at work until about 5:30 PM. You'll be online again today around 8:00 PM." */
				upcoming: z.boolean().default(true),
				/** In DMs, that their messages came in while it was offline: "These messages came in while you were at work (from 12:16 PM)…". */
				awayContext: z.boolean().default(true),
				/** How well it knows and likes the person, in DMs: "Sam is one of your regulars… You like Sam." (`relationship`). */
				relationship: z.boolean().default(true),
				/** How long since each side wrote in DMs ("Their last message was 25 minutes ago…"), and since the last line in a group chat. */
				timeSince: z.boolean().default(true),
			})
			.default({}),

		/** When an answer fails. */
		retries: z
			.object({
				/** Failed tries at one answer before giving up (the person can write again); a spent budget or a provider outage counts none. */
				attempts: z.number().int().min(1).max(10).default(3),
				/** Minutes before the next try (times the attempt number); while the provider is down, doubled after each try, up to 16 times. */
				delayMinutes: drawn(1, 4, 'uniform'),
				/** While the day's tokens are spent, minutes between checks. */
				budgetCheckMinutes: z.number().min(1).default(60),
			})
			.default({}),
	})
	.default({});

export type Settings = z.infer<typeof SettingsSchema>;

/** What a task uses to call its model (`taskModel`): its provider, key, model and request options, as resolved. */
export interface TaskModel {
	baseUrl?: string;
	/** Undefined only on a provider of its own that names no key (a settings problem: `checkSettings`). */
	apiKeyEnv?: string;
	model?: string;
	jsonMode: boolean;
	timeoutSeconds: number;
	maxTokens: number;
	temperature: number;
	/** It names a `baseUrl` of its own: nothing of the default provider (key, model, jsonMode) is used for it. */
	ownProvider: boolean;
}

/**
 * The model a task calls: what it names, else `models.default`'s, but on a provider of its own (its own `baseUrl`)
 * only what it names (the default key, model and jsonMode belong to the default provider), and for `vision` never the
 * default model (it may not take images). The timeout comes from `default` either way.
 */
export function taskModel(settings: Settings, task: Task): TaskModel {
	const { default: base } = settings.models;
	const own = settings.models[task];
	const ownProvider = own.baseUrl !== undefined;
	return {
		baseUrl: own.baseUrl ?? base.baseUrl,
		apiKeyEnv: own.apiKeyEnv ?? (ownProvider ? undefined : base.apiKeyEnv),
		model: own.model ?? (ownProvider || task === 'vision' ? undefined : base.model),
		jsonMode: own.jsonMode ?? (ownProvider ? false : base.jsonMode),
		timeoutSeconds: own.timeoutSeconds ?? base.timeoutSeconds,
		maxTokens: own.maxTokens,
		temperature: own.temperature,
		ownProvider,
	};
}

/**
 * Rules across settings that the schema can't express: a task on a provider of its own names its own key and model
 * (the default provider's never reach another host), and once a provider is set every text task has a model.
 */
export function checkSettings(settings: Settings): Problem[] {
	const issues: Problem[] = [];
	for (const task of TASKS) {
		const at = ['models', task];
		const own = settings.models[task];
		const used = taskModel(settings, task);
		if (used.ownProvider) {
			if (own.apiKeyEnv === undefined) issues.push({ path: [...at, 'apiKeyEnv'], message: "on a provider of its own (its baseUrl), it names its own key variable ('' for none): the default one is never sent to another host" });
			if (own.model === undefined) issues.push({ path: [...at, 'model'], message: 'on a provider of its own (its baseUrl), it names its own model' });
		} else if (task !== 'vision' && used.baseUrl !== undefined && used.model === undefined) {
			// vision is optional: off without a model of its own
			issues.push({ path: at, message: 'no model named (set it, or models.default.model)' });
		}
	}
	return issues;
}

/** Every setting at its default: a brain's settings when it is given none (tests, demos). */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse(undefined);

/** What a key of the 0.1 betas' settings became: refused with where it went, not only as unknown. */
const SERVICE_KEY = "moved to the service settings' decisions (parseServiceSettings): one Decisions client serves every persona";
const MOVED_SETTINGS: Readonly<Record<string, string>> = {
	llm: "moved: its baseUrl, apiKeyEnv, model, jsonMode and timeoutSeconds to models.default; dailyTokens, directMessageReserve and concurrency to the service settings' text (parseServiceSettings)",
	...Object.fromEntries(['enabled', 'baseUrl', 'apiKeyEnv', 'model', 'timeoutSeconds', 'dailyTokens'].map((key) => [`decisions.${key}`, SERVICE_KEY])),
};

/**
 * `raw` read with `schema`: every value it leaves out at its default (nothing at all, or `null` as an empty YAML file
 * reads, is every default), or else every problem, each with its path, after `source` when given. A key the schema
 * doesn't know is a problem too: one an earlier version read says where it went (`moved`), any other gets the
 * nearest known key. Never throws.
 */
const parseWith = <S extends z.ZodTypeAny>(schema: S, raw: unknown, source: string | undefined, moved: Readonly<Record<string, string>>, check: (value: z.output<S>) => Problem[]) => {
	const { value, problems } = readWith(schema, raw, moved, check);
	return { value, issues: problems.map((problem) => sourced(source, problem)) };
};

/** parseWith's work, its problems not yet worded. */
const readWith = <S extends z.ZodTypeAny>(schema: S, raw: unknown, moved: Readonly<Record<string, string>>, check: (value: z.output<S>) => Problem[]) => {
	const value = raw === null ? undefined : raw;
	const parsed = schema.safeParse(value);
	const problems = [...schemaProblems(parsed.error, value), ...unknownKeyProblems(unknownKeys(schema, value), moved), ...(parsed.success ? check(parsed.data) : [])];
	return { value: parsed.success && !problems.length ? (parsed.data as z.output<S>) : undefined, problems };
};

/**
 * `raw` read as a brain's settings: every setting it leaves out at its default (nothing at all, or `null` as an empty
 * YAML file reads, is every default), or else every problem, each with its path, after `source › ` when given. A key
 * the schema doesn't know is a problem too, with the nearest known one, or where it went for a key of the 0.1 betas.
 * Never throws.
 */
export function parseSettings(raw: unknown, { source }: { source?: string } = {}): { settings?: Settings; issues: string[] } {
	const { value, issues } = parseWith(SettingsSchema, raw, source, MOVED_SETTINGS, checkSettings);
	return value ? { settings: value, issues } : { issues };
}

/**
 * What the whole service shares, set once and never per brain: the text provider's budget, which every persona's
 * model client spends together (one meter, one limit of requests in flight), and the Decisions client, one for every
 * persona. The app builds from it the token meters (`createTokenMeter`), the model clients (`llmsFor`'s `budget`) and
 * the Decisions client (`createConfiguredDecisions`).
 */
export const ServiceSettingsSchema = z
	.object({
		/** The text provider's budget, for every persona together. */
		text: z
			.object({
				/**
				 * Tokens per day for text generation; 0 for no limit. One pool for every persona, reset at 00:00 UTC, first
				 * come first served: personas online right after the reset spend it first. At the shipped prompt sizes a DM
				 * turn is about 3.5-4K tokens, so the default buys about 55 DM turns a day for all personas together: size it
				 * to the fleet. Past it, replies wait and group chats stay quiet. Spent through the meter the app builds with
				 * it (`createTokenMeter`).
				 */
				dailyTokens: z.number().int().min(0).default(200_000),
				/** The share of dailyTokens kept for DMs and their photos, 0 to 0.9: group chats and posts stop once the rest is spent. */
				directMessageReserve: z.number().min(0).max(0.9).default(0.3),
				/** The most text model requests in flight at once, for every persona together; the others wait their turn. */
				concurrency: z.number().int().min(1).max(32).default(4),
			})
			.default({}),
		/**
		 * The Decisions API client (OpenAI's by default): a classifier that answers typed questions with probabilities
		 * and writes no text. Its only configuration: nothing falls back to `models`. Off by default: turning it on sends
		 * people's messages, the personas' replies and group chats to `baseUrl`. Which checks each brain asks, and their
		 * thresholds, are that brain's `Settings.decisions`.
		 */
		decisions: z
			.object({
				/** Whether to use it at all (needs the key named by `apiKeyEnv`): off, nothing is sent to /decisions, for any persona. */
				enabled: z.boolean().default(false),
				/** The Decisions API's base URL ({baseUrl}/decisions): OpenAI's, or a gateway or mock that speaks it. */
				baseUrl: z.string().url().default('https://api.openai.com/v1'),
				/** The environment variable holding its key; empty for no authentication. */
				apiKeyEnv: z.string().default('OPENAI_API_KEY'),
				/** The only model OpenAI's API offers. */
				model: z.string().min(1).default('gpt-6-luna'),
				/** Seconds before a request is given up (it is retried once); the path without it then runs. */
				timeoutSeconds: z.number().min(1).max(30).default(5),
				/** Input tokens every persona together may spend per UTC day on every Decisions call (the checks and the group-chat gate), counted apart from text generation; 0 for no limit. Past it, as if off. */
				dailyTokens: z.number().int().min(0).default(2_000_000),
			})
			.default({}),
	})
	.default({});

export type ServiceSettings = z.infer<typeof ServiceSettingsSchema>;

/** The service settings at their defaults (tests, demos). */
export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = ServiceSettingsSchema.parse(undefined);

/** `raw` read as the service settings, as `parseSettings` reads a brain's. Never throws. */
export function parseServiceSettings(raw: unknown, { source }: { source?: string } = {}): { service?: ServiceSettings; issues: string[] } {
	const { value, issues } = parseWith(ServiceSettingsSchema, raw, source, {}, () => []);
	return value ? { service: value, issues } : { issues };
}

type SettingsInput = NonNullable<z.input<typeof SettingsSchema>>;
/** A persona's own pacing and relationship, as its config writes them: only the keys it changes. */
export type PersonaSettings = { pacing?: NonNullable<SettingsInput['pacing']>; relationship?: NonNullable<SettingsInput['relationship']> };

/**
 * `settings` with a persona's own pacing and relationship merged over them, key by key (a list or a range replaces;
 * a bare `[least, most]` takes the setting's own shape), checked again: a rule across keys may depend on both.
 */
export function mergedSettings({ pacing, relationship }: PersonaSettings, settings: Settings): { value?: Settings; problems: Problem[] } {
	if (pacing === undefined && relationship === undefined) return { value: settings, problems: [] };
	return readWith(SettingsSchema, deepMerge(settings, { pacing, relationship }), {}, checkSettings);
}

/** mergedSettings' value, else a ConfigError naming the persona: what createBrain and personaReport run with. */
export function ownSettings(persona: PersonaSettings & { id: string }, settings: Settings): Settings {
	const { value, problems } = mergedSettings(persona, settings);
	if (!value) throw new ConfigError(`the settings of persona "${persona.id}"`, problems.map((problem) => sourced(undefined, problem)));
	return value;
}

/** Milliseconds from seconds, minutes, hours or days, for the ranges above. */
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
