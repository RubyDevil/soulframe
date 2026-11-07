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

/** [least, most]: a random value between the two is picked each time. */
export const range = (min: number, max: number, floor = 0) =>
	z
		.tuple([z.number().min(floor), z.number().min(floor)])
		.default([min, max])
		.refine(([low, high]) => low <= high, 'the first number must not be above the second');

/**
 * A probability up to 1 at or above which a check acts. The floor (0.3 unless given) keeps one mistyped
 * value from making a check hit everyone: at 0, even a probability of 0 would count.
 */
const at = (value: number, min = 0.3) => z.number().min(min).max(1).default(value);

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
				/** Hours without a message from them after which their next one starts a new conversation (counted for the relationship). */
				conversationGapHours: z.number().min(0.5).max(168).default(6),
				/** Conversations after which the relationship is acquainted, regular, close (counted by the code, see brain.ts relationshipOf). */
				relationshipAfter: z
					.tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)])
					.default([2, 5, 12])
					.refine(([a, b, c]) => a <= b && b <= c, 'each must not be below the one before'),
			})
			.default({}),

		/** How fast it answers and types. */
		pacing: z
			.object({
				/** Probability of the quick delay; slow has its own probability and the remainder uses the busy delay. */
				quickReplyChance: z.number().min(0).max(1).default(0.65),
				slowReplyChance: z.number().min(0).max(1).default(0.27),
				quickReplyDelaySeconds: range(4, 45),
				slowReplyDelaySeconds: range(60, 240),
				busyReplyDelaySeconds: range(300, 900),
				/** Typing speed, in characters per second; the typing indicator shows for as long as the message would take. */
				typingCharsPerSecond: range(3.5, 7, 0.5),
				/** The shortest and longest the typing indicator shows for one message, in seconds (thinking pauses come on top). */
				typingDurationSeconds: range(1.5, 45),
				/**
				 * Seconds between showing that their messages were read (`Conversation.markRead`) and starting to type the reply;
				 * only on a conversation that has `markRead`.
				 */
				readBeforeTypingSeconds: range(1, 3),
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
						seconds: range(2, 6),
					})
					.strict()
					.default({}),
				/**
				 * One person at a time: while it is composing or sending a reply to someone, it starts nobody else's, so what it
				 * learns about itself is never overwritten by a turn that began before it (self notes are read when a turn starts and
				 * written when it ends). Others wait their turn, a few seconds at a time. Turn it off only if you accept that:
				 * parallel turns can lose each other's self notes. A turn stuck for over 10 minutes stops blocking the others.
				 */
				singlePresence: z.boolean().default(true),
				/** Seconds between two messages of the same reply. */
				betweenReplyMessagesSeconds: range(0.8, 3.5),
				/** Chance that a long reply (over 90 characters) is sent as two messages. */
				replySplitChance: z.number().min(0).max(1).default(0.35),
				/** Extra minutes after a span opens, before the first backlog reply of that span; [0, 0] disables the extra wait. */
				returnOnlineReplyDelayMinutes: range(0, 0),
				/** Seconds before each backlog conversation: messages that came in offline are answered one person at a time, oldest first. */
				backlogGapSeconds: range(30, 150),
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
				/** How well it knows the person, in DMs: "Sam is one of your regulars…" (memory.relationshipAfter). */
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
				delayMinutes: range(1, 4),
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
export const PERSONA_SETTINGS = ['models', 'memory', 'pacing', 'context', 'retries'] as const;
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
	const { pacing, llm, models } = settings;
	if (pacing.quickReplyChance + pacing.slowReplyChance > 1) issues.push({ path: ['pacing'], message: 'quickReplyChance and slowReplyChance add up to more than 1' });
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
