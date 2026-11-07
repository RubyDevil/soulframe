/**
 * The persona module's own config: a folder holding `_shared.yaml` (optional: what every persona there has unless its
 * own file sets it) and `<id>.yaml` per persona, its prompt `<id>.md` beside it by default. The layers, each over the
 * one before (config/layers.ts):
 *
 *   settings.ts defaults → _shared.yaml → <id>.yaml
 *
 * Plain objects merge key by key; [a, b] ranges, lists and values replace, and `null` removes an inherited value
 * (back to the default) (merge.ts); `character.boundaries` add up, so a persona can't drop a shared limit. The hours
 * (`window` or `schedule`, config/hours.ts) come whole from the nearest layer that sets one, never merged day by day.
 * A persona's `settings:` may only hold the groups in settings.ts `PERSONA_SETTINGS`: the provider and its cap and the
 * Decisions checks are set once, in `_shared.yaml`, and the schema offers no way to change the stop handling or the
 * 18+ safeguard per persona (they are code, in safety.ts, run on the app's channels: `Channel.adult`).
 *
 * Everything else (the accounts, the channels and their limits, who runs) is the app's. The app says which channels
 * each persona has: the names its hours' `on:` may use. Every problem is returned, never thrown, each with its file
 * and path; a key the schema doesn't know is an error, with the nearest known one. `_shared.yaml`'s values are
 * reported once, there.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ChannelId } from '../channel.js';
import { isPlainObject, pickKeys, valueAt } from '../merge.js';
import { scheduleOfWindow } from '../schedule.js';
import { PERSONA_SETTINGS, SettingsSchema, type Settings } from '../settings.js';
import { refuseSchool, ScheduleSchema, WindowSchema, type ScheduleConfig } from './hours.js';
import { addQuietIssue, describe, inFile, issueKey, same, shownValue, suggest, unknownKeyIssues, unknownKeys } from './issues.js';
import { applyPersonaDefaults, clearedSettingIssues, layerSettings, PersonaSettingsSchema } from './layers.js';

/** A persona's id: its file's name without .yaml (`_shared.yaml` never is one). */
export const PERSONA_ID = /^[a-z0-9-]{2,32}$/;

const isTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
};

const Line = z.string().trim().min(1).max(200);

const MoodSchema = z.union([
	z
		.string()
		.trim()
		.min(1)
		.max(80)
		.transform((mood) => ({ mood, weight: 1 })),
	z.object({ mood: z.string().trim().min(1).max(80), weight: z.number().min(0).default(1) }),
]);

/** What stays true of the persona whatever its own notes say: rendered into every prompt by prompts.ts, before the rules. */
const CharacterSchema = z
	.object({
		/** Facts about it that never change and the model can't rewrite (its age, where it lives, a pet). Its notes add the rest. */
		facts: z.array(Line).max(20).default([]),
		/** Things it's into and brings up when they fit. */
		interests: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
		/** Its own limits, on top of the rules every persona keeps, if any: they only add, never relax (and add up with _shared.yaml's). Never about being an AI. */
		boundaries: z.array(Line).max(20).default([]),
		/** One picked per day (the agenda day of its online time), by weight, the same after a restart; none for no mood line. */
		moods: z.array(MoodSchema).max(12).default([]),
	})
	.default({});

const PersonaFields = z.object({
	/** Optional: the file's name without .yaml, which it must be. */
	id: z.string().optional(),
	name: z.string().min(1).max(32),
	/** The persona's voice and background, a Markdown file relative to its file; `<id>.md` beside it by default. */
	prompt: z.string().optional(),
	/** IANA time zone, e.g. America/Toronto. Intl's list only suggests one: it lacks some valid zones (UTC, Asia/Kolkata). */
	timezone: z.string().refine(isTimeZone, (zone) => ({ message: `not an IANA time zone${suggest(zone, Intl.supportedValuesOf('timeZone'))}` })),
	/** Its hours, the same every day (loaded as a schedule by schedule.ts scheduleOfWindow), or `schedule`: exactly one of them. */
	window: WindowSchema.optional(),
	/** Its hours by weekday: online time, breaks and busy blocks. */
	schedule: ScheduleSchema.optional(),
	/** How much it talks in group chats: a trait in the group-chat task, and the key of the group-chat gate's threshold (settings.decisions.groupChatGate.chimeInAt). */
	chattiness: z.enum(['quiet', 'easygoing', 'talkative']).default('easygoing'),
	/** Safe for work only: every prompt (DMs, group chats, posts) gets the rule to keep the conversation free of sexual or explicit content (prompts.ts SFW_RULE). */
	sfw: z.boolean().default(false),
	/** Overrides of _shared.yaml's settings for this persona only (settings.ts PERSONA_SETTINGS), deep-merged over them. */
	settings: PersonaSettingsSchema,
	/** What stays true of it whatever its notes say (prompts.ts characterPrompt) and its moods. */
	character: CharacterSchema,
});

/** The hours are a window or a schedule, never both (_shared.yaml may have neither). */
const refuseBothHours = (hours: { window?: unknown; schedule?: unknown }, ctx: z.RefinementCtx) => {
	if (hours.window && hours.schedule) addQuietIssue(ctx, ['schedule'], 'set window or schedule, not both');
};

const PersonaSchema = PersonaFields.superRefine((persona, ctx) => {
	refuseBothHours(persona, ctx);
	if (!persona.window && !persona.schedule) addQuietIssue(ctx, ['window'], 'needs window (the same hours every day) or schedule');
});

/** The persona fields `_shared.yaml` may hold (beside `settings`): never who a persona is. */
const SHARED_FIELDS = ['timezone', 'window', 'schedule', 'chattiness', 'sfw', 'character'] as const;
const SHARED_KEYS = ['settings', ...SHARED_FIELDS];
const OWN_KEYS = ['id', 'name', 'prompt'];
/**
 * `_shared.yaml`'s persona fields (any of them may be left out, at any depth, except inside the hours: a window or a
 * schedule is whole), checked once there, then again per persona after `applyPersonaDefaults`.
 */
const SharedFieldsSchema = PersonaFields.pick({ timezone: true, chattiness: true, sfw: true, character: true })
	.deepPartial()
	.extend({ window: PersonaFields.shape.window, schedule: PersonaFields.shape.schedule })
	// Here rather than per persona, so a persona that inherits both isn't told again
	.superRefine(refuseBothHours);

/** A persona's file and _shared.yaml's fields; with the loader's `adult`, refusing busy reasons about school too (config/hours.ts refuseSchool). */
const SCHEMAS = { persona: PersonaSchema, shared: SharedFieldsSchema };
const ADULT_SCHEMAS = { persona: PersonaSchema.superRefine(refuseSchool), shared: SharedFieldsSchema.superRefine(refuseSchool) };

export type Chattiness = z.output<typeof PersonaFields>['chattiness'];
export interface PersonaConfig {
	/** The file name without .yaml. */
	id: string;
	name: string;
	/** The Markdown prompt's resolved path; `<id>.md` beside the file by default. */
	prompt: string;
	promptText: string;
	timezone: string;
	/** How much it talks in group chats: a trait in the group-chat task and the key of the group-chat gate's threshold. */
	chattiness: Chattiness;
	/** Safe for work only: its prompts keep every conversation free of sexual or explicit content (prompts.ts SFW_RULE). */
	sfw: boolean;
	/** What stays true of it whatever its notes say, and its moods. */
	character: z.output<typeof CharacterSchema>;
	/** Its hours; a `window` is converted (schedule.ts scheduleOfWindow). */
	schedule: ScheduleConfig;
	/** In effect for it: settings.ts defaults ← _shared.yaml settings ← its own. llm and decisions are always the shared ones. */
	settings: Settings;
	/** Its file, for messages. */
	source: string;
}

/** Reads files for loadPersonas (injected so tests stay off the disk). */
export interface ConfigFiles {
	read(path: string): string;
	exists(path: string): boolean;
}

export const nodeFiles: ConfigFiles = { read: (path) => readFileSync(path, 'utf8'), exists: (path) => existsSync(path) };

export interface LoadedPersonas {
	/** Every problem, as text: a persona with a problem of its own is left out of `personas`. */
	issues: string[];
	/** _shared.yaml's settings over the defaults (the global llm and decisions, everyone's starting point); undefined while they have problems. */
	shared?: Settings;
	/** The valid personas, in the order asked for. */
	personas: PersonaConfig[];
}

/** `_shared.yaml` as written: its key check, its persona fields' values (each problem's key kept, so a persona that only inherits it isn't told again) and their unknown keys. */
function sharedIssues(shared: Record<string, unknown>, file: string, schema: z.ZodTypeAny): { issues: string[]; reported: Set<string> } {
	const issues: string[] = [];
	for (const key of Object.keys(shared).filter((key) => !SHARED_KEYS.includes(key))) {
		issues.push(inFile(file, describe([key], OWN_KEYS.includes(key) ? "is each persona's own, not a default" : `unknown key${suggest(key, SHARED_KEYS)}`, undefined)));
	}
	const fields = pickKeys(shared, SHARED_FIELDS);
	const parsed = schema.safeParse(fields);
	const reported = new Set<string>();
	for (const issue of parsed.success ? [] : parsed.error.issues) {
		if (issue.code === 'unrecognized_keys') continue;
		reported.add(issueKey(issue.path, issue.message));
		issues.push(inFile(file, describe(issue.path, issue.message, shownValue(issue, fields))));
	}
	const unknown = unknownKeyIssues([...unknownKeys(SharedFieldsSchema, fields), ...unknownKeys(SettingsSchema, shared.settings, ['settings'])], []);
	return { issues: [...issues, ...unknown.map((problem) => inFile(file, problem))], reported };
}

/** The `on:` names of these hours that are none of `channels`, each with its path. */
const unknownChannels = (schedule: ScheduleConfig, channels: readonly ChannelId[]) =>
	Object.entries(schedule.days).flatMap(([key, plan]) =>
		(['online', 'breaks'] as const).flatMap((kind) =>
			plan[kind].flatMap((block, index) => (block.on ?? []).filter((on) => !channels.includes(on)).map((name) => ({ path: ['schedule', 'days', key, kind, index, 'on'], name }))),
		),
	);

/** The same as loadPersonas, from values already read (tests; loadPersonas calls it). */
export function parsePersonas(options: {
	shared?: unknown;
	sharedFile?: string;
	personas: readonly { id: string; raw: unknown; file: string }[];
	channels: Readonly<Record<string, readonly ChannelId[]>>;
	readPrompt: (path: string) => string;
	/** For 18+ conversations: busy reasons about school are refused. */
	adult?: boolean;
}): LoadedPersonas {
	const sharedFile = options.sharedFile ?? '_shared.yaml';
	const issues: string[] = [];
	const shared = options.shared ?? {};
	if (!isPlainObject(shared)) return { issues: [`${sharedFile}: must be a mapping (what every persona has unless it sets its own)`], personas: [] };
	const schemas = options.adult ? ADULT_SCHEMAS : SCHEMAS;
	const fromShared = sharedIssues(shared, sharedFile, schemas.shared);
	issues.push(...fromShared.issues);
	// Only what a default may set reaches the personas (its settings are layered apart: llm and decisions are no persona's own)
	const defaults = pickKeys(shared, SHARED_FIELDS);

	const entries = options.personas.map(({ id, raw, file }) => {
		const own: string[] = [];
		const report = (path: (string | number)[], message: string, got?: unknown) => own.push(inFile(file, describe(path, message, got)));
		if (!isPlainObject(raw)) return { id, file, own: [`${file}: must be a mapping (a persona's fields)`] };
		if (raw.id !== undefined && raw.id !== id) return { id, file, own: [inFile(file, describe(['id'], `${JSON.stringify(raw.id)} but the file is ${basename(file)}`, undefined))] };
		const merged = applyPersonaDefaults(defaults, raw);
		const parsed = schemas.persona.safeParse(merged);
		for (const issue of parsed.success ? [] : parsed.error.issues) {
			if (issue.code === 'unrecognized_keys') continue;
			// _shared.yaml's own problem, only inherited here: reported once, there
			if (fromShared.reported.has(issueKey(issue.path, issue.message)) && same(valueAt(merged, issue.path), valueAt(defaults, issue.path))) continue;
			report(issue.path, issue.message, shownValue(issue, merged));
		}
		for (const { key, message } of clearedSettingIssues(raw.settings)) report(['settings', key], message);
		own.push(...unknownKeyIssues([...unknownKeys(PersonaSchema, { ...raw, settings: undefined }), ...unknownKeys(SettingsSchema, pickKeys(raw.settings, PERSONA_SETTINGS), ['settings'])], []).map((problem) => inFile(file, problem)));
		const written = typeof raw.prompt === 'string' ? raw.prompt : `${id}.md`;
		const prompt = isAbsolute(written) ? written : resolve(dirname(file), written);
		let promptText = '';
		try {
			promptText = options.readPrompt(prompt);
		} catch (error) {
			report(['prompt'], `can't read ${prompt} (${(error as { code?: string }).code ?? String(error)})`);
		}
		return { id, file, own, raw, prompt, promptText, parsed: parsed.success ? parsed.data : undefined, inherits: raw.window === undefined && raw.schedule === undefined };
	});

	const settings = layerSettings(shared.settings, entries.map((entry) => valueAt(entry.raw, ['settings'])), { shared: sharedFile, personas: entries.map((entry) => entry.file) });
	issues.push(...settings.issues);

	// Its hours may only name its own channels; hours from _shared.yaml are reported there, once per name for every persona they fail for
	const failedShared = new Map<string, { path: (string | number)[]; name: string; channels: string; ids: string[] }>();
	for (const entry of entries) {
		const channels = options.channels[entry.id] ?? [];
		const schedule = entry.parsed && (entry.parsed.schedule ?? scheduleOfWindow(entry.parsed.window!));
		for (const { path, name } of schedule ? unknownChannels(schedule, channels) : []) {
			if (!entry.inherits) {
				entry.own.push(inFile(entry.file, describe(path, `"${name}" is not one of this persona's channels (${channels.join(', ')})${suggest(name, channels)}`, undefined)));
				continue;
			}
			const key = `${path.join('.')}\0${name}\0${channels.join(', ')}`;
			const failed = failedShared.get(key) ?? { path, name, channels: channels.join(', '), ids: [] };
			failedShared.set(key, { ...failed, ids: [...failed.ids, entry.id] });
		}
	}
	for (const { path, name, channels, ids } of failedShared.values()) {
		issues.push(inFile(sharedFile, describe(path, `"${name}" is not one of the channels of ${ids.join(', ')} (${channels})${suggest(name, channels.split(', '))}`, undefined)));
	}
	const failing = new Set([...failedShared.values()].flatMap(({ ids }) => ids));

	const personas: PersonaConfig[] = [];
	entries.forEach((entry, index) => {
		issues.push(...entry.own);
		const own = settings.personas[index];
		if (entry.own.length || !entry.parsed || !own || failing.has(entry.id)) return;
		const { name, timezone, window, schedule, chattiness, sfw, character } = entry.parsed;
		personas.push({ id: entry.id, name, prompt: entry.prompt!, promptText: entry.promptText!, timezone, chattiness, sfw, character, schedule: schedule ?? scheduleOfWindow(window!), settings: own, source: entry.file });
	});
	return { issues, personas, ...(settings.shared && { shared: settings.shared }) };
}

/**
 * Reads <dir>/_shared.yaml (optional) and <dir>/<id>.yaml for each key of `channels`, whose value lists the channel ids
 * that persona's hours (`on:`) may name. Never throws on a config problem: the caller reports `issues`.
 */
export function loadPersonas({
	dir,
	channels,
	files = nodeFiles,
	adult,
}: {
	dir: string;
	channels: Readonly<Record<string, readonly ChannelId[]>>;
	files?: ConfigFiles;
	/** For 18+ conversations: busy reasons about school are refused. */
	adult?: boolean;
}): LoadedPersonas {
	const issues: string[] = [];
	const read = (file: string): { raw: unknown } | null => {
		try {
			return { raw: parse(files.read(file)) };
		} catch (error) {
			issues.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	};
	const sharedFile = join(dir, '_shared.yaml');
	const shared = files.exists(sharedFile) ? read(sharedFile) : { raw: undefined };
	const personas: { id: string; raw: unknown; file: string }[] = [];
	for (const id of Object.keys(channels)) {
		const file = join(dir, `${id}.yaml`);
		if (!PERSONA_ID.test(id)) issues.push(`"${id}" is not a persona id: 2 to 32 of a-z, 0-9 and - (its file's name without .yaml)`);
		else if (!files.exists(file)) issues.push(`no file ${file}`);
		else {
			const found = read(file);
			if (found) personas.push({ id, raw: found.raw, file });
		}
	}
	if (!shared) return { issues, personas: [] };
	const loaded = parsePersonas({ shared: shared.raw, sharedFile, personas, channels, readPrompt: (path) => files.read(path), adult });
	return { ...loaded, issues: [...issues, ...loaded.issues] };
}
