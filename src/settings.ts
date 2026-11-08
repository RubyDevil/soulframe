/**
 * Every setting of a persona's brain, with its default, in one place. They are set in the `settings:` block of
 * the persona folder's `_shared.yaml` (config/personas.ts); anything left out keeps the default below. Secrets (API
 * keys, passwords, tokens) never go there: only the names of the environment variables that hold them. The app's own
 * settings (message limits, its channels' timings, retention, the request rate) are not here (the app's config).
 *
 * A persona may override the groups in `PERSONA_SETTINGS` (models, memory, pacing…) in the `settings:` block of its
 * own file, deep-merged over these. The groups in `GLOBAL_SETTINGS` (the text provider and its daily cap, the Decisions
 * checks) are set once for all personas, and no persona can change them.
 *
 * Text generation (`llm`, `models`) and the Decisions API (`decisions`) are configured apart: neither reads
 * the other's block.
 */

import { z } from 'zod';

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

/** One model, for one kind of text generation task. */
const ModelSchema = (defaults: { maxTokens: number; temperature: number }) =>
	z
		.object({
			/** The model's name at the provider. */
			model: z.string().min(1).optional(),
			/** Another provider for this task only (its OpenAI-compatible base URL); else `llm.baseUrl`. */
			baseUrl: z.string().url().optional(),
			/** The key's environment variable; else `llm.apiKeyEnv`. Empty disables authentication. */
			apiKeyEnv: z.string().optional(),
			/** Ask this task's provider for strict JSON; else `llm.jsonMode` when the task uses `llm.baseUrl`, off with its own `baseUrl`. */
			jsonMode: z.boolean().optional(),
			/** The most tokens the answer may hold. */
			maxTokens: z.number().int().min(16).max(4000).default(defaults.maxTokens),
			/** 0 to 2: higher is more varied, lower more predictable. */
			temperature: z.number().min(0).max(2).default(defaults.temperature),
		})
		.default({});

export const SettingsSchema = z
	.object({
		/**
		 * The text provider, for text generation only: any OpenAI-compatible chat completions API; the provider and its
		 * model decide what content they allow. The Decisions API (`decisions`) never reads it.
		 */
		llm: z
			.object({
				/** e.g. https://api.provider.example/v1 */
				baseUrl: z.string().url().optional(),
				/** The key's environment variable; empty for a local provider without authentication. */
				apiKeyEnv: z.string().default('LLM_API_KEY'),
				/** The model used by every task that doesn't name its own. */
				model: z.string().min(1).optional(),
				/** Seconds before a request is given up (it is retried once). */
				timeoutSeconds: z.number().min(5).max(300).default(60),
				/**
				 * Tokens per day for text generation; 0 for no limit. One pool for every persona (there are no per-persona
				 * meters), reset at 00:00 UTC, first come first served: personas online right after the reset spend it first.
				 * At the shipped prompt sizes a DM turn is about 3.5-4K tokens, so the default buys about 55 DM turns a day
				 * for all personas together: size it to the fleet. Past it, replies wait and group chats stay quiet.
				 */
				dailyTokens: z.number().int().min(0).default(200_000),
				/** The share of dailyTokens kept for DMs, 0 to 0.9: group chats and posts stop once the rest is spent. */
				directMessageReserve: z.number().min(0).max(0.9).default(0.3),
				/** The most text model requests in flight at once, for all personas together; the others wait their turn. */
				concurrency: z.number().int().min(1).max(32).default(4),
				/**
				 * Ask for strict JSON answers (`response_format: json_object`); only for providers that support it. A task
				 * with its own `baseUrl` doesn't inherit it (it sets its own `models.<task>.jsonMode`).
				 */
				jsonMode: z.boolean().default(false),
			})
			.default({}),

		/**
		 * A text generation model per kind of task, so the frequent cheap ones (group chats, mostly "stay quiet") can
		 * use a cheaper model than direct messages, where quality shows.
		 */
		models: z
			.object({
				/** A turn of a direct message conversation (the reply, the notes, the action). */
				directMessage: ModelSchema({ maxTokens: 400, temperature: 0.9 }),
				/** Whether to say something in a group chat, and what. */
				groupChat: ModelSchema({ maxTokens: 100, temperature: 0.9 }),
				/** A post in a channel. */
				post: ModelSchema({ maxTokens: 160, temperature: 1 }),
			})
			.default({}),

		/**
		 * Optional typed checks by a Decisions API (OpenAI's by default): a classifier that answers questions with
		 * probabilities and writes no text (the questions are in prompts.ts). This block is its only configuration:
		 * nothing falls back to `llm` or `models`, and while `enabled` is false nothing is sent to /decisions (no group-chat
		 * gate either). Off by default: turning it on sends people's messages, the personas' replies and group chats to
		 * `baseUrl`. Additive only: the code's own checks (safety.ts) run first and stay authoritative; any failure,
		 * timeout, refusal or spent budget behaves exactly as if this were off.
		 * The age check runs only on 18+ channels (`Channel.adult`); elsewhere its settings do not apply.
		 * The thresholds are not calibrated: tune them from the audit rows, which record each probability.
		 */
		decisions: z
			.object({
				/** Whether to use it at all (needs the key named by `apiKeyEnv`): the switch for every Decisions call. */
				enabled: z.boolean().default(false),
				/** The Decisions API's base URL ({baseUrl}/decisions): OpenAI's, or a gateway or mock that speaks it. */
				baseUrl: z.string().url().default('https://api.openai.com/v1'),
				/** The environment variable holding its key; empty for no authentication. */
				apiKeyEnv: z.string().default('OPENAI_API_KEY'),
				/** The only model OpenAI's API offers. */
				model: z.string().min(1).default('gpt-6-luna'),
				/** Seconds before a request is given up (it is retried once); the path without it then runs. */
				timeoutSeconds: z.number().min(1).max(30).default(5),
				/** Input tokens all personas may spend per UTC day on every Decisions call (the checks and the group-chat gate), counted apart from llm.dailyTokens; 0 for no limit. Past it, as if off. */
				dailyTokens: z.number().int().min(0).default(2_000_000),
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
						/** Whether to ask it at all (only ever with `decisions.enabled`). */
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
						/** "Chime in" score (0 intrude, 1 optional, 2 opening, 3 expected) at or above which it speaks, by the persona's chattiness. */
						chimeInAt: z
							.object({
								/** For a `quiet` persona: only a clear opening. */
								quiet: z.number().min(0).max(3).default(2.2),
								/** For an `easygoing` persona. */
								easygoing: z.number().min(0).max(3).default(1.7),
								/** For a `talkative` persona: even an optional remark. */
								talkative: z.number().min(0).max(3).default(1.2),
							})
							.default({}),
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

/**
 * The setting groups a persona may set for itself (its file's `settings:`), deep-merged over `_shared.yaml`'s
 * (config/personas.ts). Everything else is set once for every persona.
 */
export const PERSONA_SETTINGS = ['models', 'memory', 'relationship', 'pacing', 'context', 'retries'] as const;
/** Set once for every persona: the text provider and its daily cap, the Decisions checks. */
export const GLOBAL_SETTINGS = ['llm', 'decisions'] as const;
/** Why a group can't be set per persona, for the error message. */
export const GLOBAL_ONLY_REASONS: Record<(typeof GLOBAL_SETTINGS)[number], string> = {
	decisions: 'the safety checks are the same for every persona (set them under the global settings.decisions)',
	llm: 'the text provider and its daily cap are shared (a persona may name its own models in settings.models)',
};
// A new setting must be classified as per persona or global: a compile error otherwise
type Unclassified = Exclude<keyof Settings, (typeof PERSONA_SETTINGS)[number] | (typeof GLOBAL_SETTINGS)[number]>;
export const SETTINGS_CLASSIFIED: [Unclassified] extends [never] ? true : never = true;

/** Rules across settings that the schema can't express. */
export function checkSettings(settings: Settings): { path: (string | number)[]; message: string }[] {
	const issues: { path: (string | number)[]; message: string }[] = [];
	const { llm, models } = settings;
	for (const [task, model] of Object.entries(models)) {
		if (llm.baseUrl === undefined && model.baseUrl === undefined) continue;
		if (!model.model && !llm.model) issues.push({ path: ['models', task], message: 'no model named (set it, or settings.llm.model)' });
	}
	return issues;
}

/** Every setting at its default (tests, and anything built without a config file). */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse(undefined);

/** Milliseconds from seconds, minutes, hours or days, for the ranges above. */
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
