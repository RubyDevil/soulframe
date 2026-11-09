/**
 * A persona as the package takes it: its config, the data the code computes with (PersonaConfigSchema), and its
 * prompt, free Markdown (its voice and background). `parsePersona` checks the two, from wherever the app keeps them.
 * The one file format the package reads, and only if the app wants it: a Markdown file per persona, `<id>.md`, its
 * config as YAML frontmatter at the top and its prompt the rest (`parsePersonaMarkdown`; `loadPersonas` for a folder
 * of them).
 *
 * The config holds only what the code computes with: who it is to the code (its id and name), its hours and their
 * time zone, and optionally its own pacing, relationship and initiative over its brain's settings (settings.ts), which hold
 * everything else about how its brain runs. Everything it says is its prompt's. The app says which channels each
 * persona is on: the names its hours' `on:` may use.
 *
 * Every problem is returned, never thrown, each with its path (after its source, when given); a key the schema
 * doesn't know is an error, with the nearest known one, and a key that earlier versions read says where it went.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ChannelId } from '../channel.js';
import { isPlainObject } from '../merge.js';
import { DEFAULT_SETTINGS, mergedSettings, type PersonaSettings, type Settings } from '../settings.js';
import { refuseSchool, ScheduleSchema, type ScheduleConfig } from './hours.js';
import { readConfig, sourced, suggest, type Problem } from './issues.js';

/** A persona's id: the key of everything stored about it and the seed of its days; a persona file's name without .md. */
export const PERSONA_ID = /^[a-z0-9-]{2,32}$/;
/** What PERSONA_ID asks, in the problems that refuse one. */
const ID_RULE = 'a persona id: 2 to 32 of a-z, 0-9 and -';

const isTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
};

/** Its own pacing, relationship or initiative: only the keys it changes, merged over its brain's settings and checked with them (mergedSettings). */
const ownOf = <Key extends keyof PersonaSettings>() => z.record(z.string(), z.unknown()).transform((value) => value as NonNullable<PersonaSettings[Key]>).optional();

/** A persona's config: only what the code computes with. */
const PersonaConfigSchema = z.object({
	/** The key of everything stored about it and the seed of its days (`PERSONA_ID`); a persona file's name gives it. */
	id: z.string().regex(PERSONA_ID, ID_RULE),
	/** The name it goes by: in its identity line, and how group chats and the typed checks name it. */
	name: z.string().min(1).max(32),
	/** IANA time zone, e.g. America/Toronto. Intl's list only suggests one: it lacks some valid zones (UTC, Asia/Kolkata). */
	timezone: z.string().refine(isTimeZone, (zone) => ({ message: `not an IANA time zone${suggest(zone, Intl.supportedValuesOf('timeZone'))}` })),
	/** Its hours by weekday: online time, breaks and busy blocks (config/hours.ts). */
	schedule: ScheduleSchema,
	/** How it texts, over its brain's `pacing`: only the keys it changes (how fast it types, how long it takes to look…). */
	pacing: ownOf<'pacing'>(),
	/** How it bonds, over its brain's `relationship`: only the keys it changes (how fast familiarity grows and fades…). */
	relationship: ownOf<'relationship'>(),
	/** Whether and how it texts first, over its brain's `initiative`: only the keys it changes (off for a shy one…). */
	initiative: ownOf<'initiative'>(),
});

/** With `adult`, refusing busy reasons about school too (config/hours.ts refuseSchool). */
const ADULT_SCHEMA = PersonaConfigSchema.superRefine(refuseSchool);

/** A persona's config, checked: what the code computes with. */
export type PersonaConfig = z.output<typeof PersonaConfigSchema>;

/** A persona: its config and its prompt. What `createBrain` takes. */
export interface Persona extends PersonaConfig {
	/** Its voice and background, free Markdown, trimmed: first in every system prompt. */
	prompt: string;
}

/** Keys that the persona files of the 0.1 betas held, each with where it went: an error saying so, rather than only "unknown key". */
const MOVED: Readonly<Record<string, string>> = {
	window: 'no longer read: write the same hours as a schedule, `schedule: { skipDayChance, days: { mon-sun: { online: [{ start, end }] } } }`',
	prompt: "is no path any more: the prompt is the text after the frontmatter (parsePersona's `prompt`)",
	chattiness: "no longer read: say how much it talks in group chats in its prompt (with the group-chat gate on, how readily it speaks is its brain's decisions.groupChatGate.chimeInAt)",
	sfw: "is the brain's policy now: createBrain({ policy: { sfw: true } })",
	character: 'no longer read: write its facts, interests and boundaries in its prompt (moods are gone)',
	settings: "no longer read: its own pacing and relationship are keys of its config now; any other setting is its brain's: createBrain({ settings })",
};

/** The `on:` names of these hours that are none of `channels`, each with its path. */
const unknownChannels = (schedule: ScheduleConfig, channels: readonly ChannelId[]) =>
	Object.entries(schedule.days).flatMap(([key, plan]) =>
		(['online', 'breaks'] as const).flatMap((kind) =>
			plan[kind].flatMap((block, index) => (block.on ?? []).filter((on) => !channels.includes(on)).map((name) => ({ path: ['schedule', 'days', key, kind, index, 'on'], name }))),
		),
	);

/** What `parsePersona` and `parsePersonaMarkdown` answer: the persona, or why there is none. */
type Parsed = { persona?: Persona; issues: string[] };

/**
 * A persona from its config and its prompt, checked, from wherever the app keeps them (its own loader, a database,
 * values in code). `channels` are the channels the app puts it on: the names its hours' `on:` may use. With `adult`
 * (personas used in 18+ conversations), a busy reason about school is refused too. Its own pacing and relationship
 * are checked over `settings` (the defaults unless given). `source` names where it came from in the problems (a file,
 * say). Never throws: with any problem there is no persona, and `issues` say what is wrong.
 */
export function parsePersona({
	config,
	prompt,
	channels,
	adult,
	settings = DEFAULT_SETTINGS,
	source,
}: {
	config: unknown;
	prompt: string;
	channels: readonly ChannelId[];
	/** For 18+ conversations: busy reasons about school are refused. */
	adult?: boolean;
	/** The settings its brain will run with: its own pacing, relationship and initiative are checked over them. */
	settings?: Settings;
	/** Where it came from, before each problem ("robin.md › schedule: Required"). */
	source?: string;
}): Parsed {
	const issues = (problems: Problem[]) => ({ issues: problems.map((problem) => sourced(source, problem)) });
	if (!isPlainObject(config)) return issues([{ path: [], message: "the config must be a mapping (the persona's id, name, timezone, schedule…)" }]);
	const { value, problems } = readConfig(adult ? ADULT_SCHEMA : PersonaConfigSchema, config, {
		// A key the 0.1 betas read says where it went
		moved: MOVED,
		check: (persona) => [
			// Its hours may only name its own channels
			...unknownChannels(persona.schedule, channels).map(({ path, name }) => ({ path, message: `"${name}" is not one of this persona's channels (${channels.join(', ') || 'none'})${suggest(name, channels)}` })),
			...mergedSettings(persona, settings).problems,
		],
	});
	if (typeof prompt !== 'string') problems.push({ path: ['prompt'], message: "must be text: the persona's voice and background, in Markdown" });
	if (!value || problems.length) return issues(problems);
	return { persona: { ...value, prompt: prompt.trim() }, issues: [] };
}

/** The YAML between the `---` line a persona file starts with and the next one, and the text after it; else what is wrong. */
const splitFrontmatter = (text: string): { yaml: string; body: string } | string => {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	if (lines[0]?.trimEnd() !== '---') return 'no frontmatter: a persona file starts with its config between two --- lines';
	const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
	if (end === -1) return 'its frontmatter never ends: no --- line after the config';
	return { yaml: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
};

/**
 * A persona from the text of its Markdown file: its config as YAML frontmatter, between the `---` line the file starts
 * with and the next one, and its prompt the rest. `id` is its id (the file's name without .md): the frontmatter may
 * leave it out, and must not say another. Otherwise as `parsePersona`; as with every parser here, a problem of the file
 * as a whole starts "<source>: ", one of a key "<source> › <path>: ".
 */
export function parsePersonaMarkdown(
	text: string,
	{ id, channels, adult, settings, source }: { id: string; channels: readonly ChannelId[]; adult?: boolean; settings?: Settings; source?: string },
): Parsed {
	const whole = (message: string) => ({ issues: [sourced(source, { path: [], message })] });
	const split = splitFrontmatter(text);
	if (typeof split === 'string') return whole(split);
	let config: unknown;
	try {
		// A line before it, so the line numbers of a YAML error are the file's: the frontmatter starts on line 2
		config = parse(`\n${split.yaml}`) ?? {};
	} catch (error) {
		return whole(error instanceof Error ? error.message : String(error));
	}
	if (!isPlainObject(config)) return whole("its frontmatter must be a mapping (the persona's config: name, timezone, schedule…)");
	const parsed = parsePersona({ config: { ...config, id }, prompt: split.body, channels, adult, settings, source });
	if (config.id === undefined || config.id === id) return parsed;
	// Another id is one problem among the others: every one shows at once
	return { issues: [sourced(source, { path: ['id'], message: `${JSON.stringify(config.id)} but its id is "${id}" (its file's name without .md)` }), ...parsed.issues] };
}

/** Reads files for loadPersonas (injected so tests stay off the disk). */
export interface ConfigFiles {
	read(path: string): string;
	exists(path: string): boolean;
}

export const nodeFiles: ConfigFiles = { read: (path) => readFileSync(path, 'utf8'), exists: (path) => existsSync(path) };

export interface LoadedPersonas {
	/** Every problem, as text: a persona with a problem is left out of `personas`. */
	issues: string[];
	/** The valid personas, in the order asked for. */
	personas: Persona[];
}

/** What a 0.1 beta folder held beside the personas: what it may have set (sfw, limits, settings) is never quietly lost. */
const SHARED_LEFT = "no longer read, and what it set applies to no persona: each persona's config is its own; settings go to createBrain({ settings }), sfw to its policy, a limit every persona keeps to policy.rules";

/**
 * Reads <dir>/<id>.md for each key of `channels` (`parsePersonaMarkdown`), whose value lists the channel ids that
 * persona is on: the names its hours' `on:` may use. Never throws on a config problem: the caller reports `issues`.
 * A file of the 0.1 betas' layout is a problem, so nothing it set is lost without a word: a `<id>.yaml` leaves its
 * persona out, a `_shared.yaml` every persona.
 */
export function loadPersonas({
	dir,
	channels,
	files = nodeFiles,
	adult,
	settings,
}: {
	dir: string;
	channels: Readonly<Record<string, readonly ChannelId[]>>;
	files?: ConfigFiles;
	/** For 18+ conversations: busy reasons about school are refused. */
	adult?: boolean;
	/** As parsePersona's. */
	settings?: Settings;
}): LoadedPersonas {
	const issues: string[] = [];
	const personas: Persona[] = [];
	const shared = join(dir, '_shared.yaml');
	const sharedLeft = files.exists(shared);
	if (sharedLeft) issues.push(sourced(shared, { path: [], message: SHARED_LEFT }));
	for (const [id, own] of Object.entries(channels)) {
		const file = join(dir, `${id}.md`);
		const old = join(dir, `${id}.yaml`);
		if (!PERSONA_ID.test(id)) {
			issues.push(`"${id}" is not ${ID_RULE} (its file's name without .md)`);
			continue;
		}
		const left = files.exists(old) ? `no longer read: write its config as the frontmatter of ${file}, its prompt after it` : undefined;
		if (!files.exists(file)) {
			issues.push(`no file ${file}${left ? ` (${old} is ${left})` : ''}`);
			continue;
		}
		if (left) {
			issues.push(sourced(old, { path: [], message: left }));
			continue;
		}
		let text: string;
		try {
			text = files.read(file);
		} catch (error) {
			issues.push(sourced(file, { path: [], message: `can't read it (${(error as { code?: string }).code ?? String(error)})` }));
			continue;
		}
		const loaded = parsePersonaMarkdown(text, { id, channels: own, adult, settings, source: file });
		issues.push(...loaded.issues);
		if (loaded.persona) personas.push(loaded.persona);
	}
	// What _shared.yaml set may have applied to any of them
	return { issues, personas: sharedLeft ? [] : personas };
}
