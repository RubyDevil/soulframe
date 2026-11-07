/**
 * The layers under each persona, each over the one before: settings.ts defaults → `_shared.yaml` → the persona's file.
 * A persona's own settings hold only the groups in settings.ts PERSONA_SETTINGS. A problem of a layer is reported
 * once, where it is written, never again for a persona that only inherits it.
 */

import { z } from 'zod';
import { deepMerge, isPlainObject, pickKeys, valueAt } from '../merge.js';
import { checkSettings, GLOBAL_ONLY_REASONS, GLOBAL_SETTINGS, PERSONA_SETTINGS, SettingsSchema, type Settings } from '../settings.js';
import { addQuietIssue, describe, inFile, issueKey, suggest } from './issues.js';

/** The key check of a persona's own settings: only settings.ts PERSONA_SETTINGS. */
const personaSettingKeyIssues = (settings: Record<string, unknown>) =>
	Object.keys(settings)
		.filter((key) => !(PERSONA_SETTINGS as readonly string[]).includes(key))
		.map((key) => ({
			key,
			message: (GLOBAL_SETTINGS as readonly string[]).includes(key)
				? `cannot be set per persona: ${GLOBAL_ONLY_REASONS[key as (typeof GLOBAL_SETTINGS)[number]]}`
				: `not a setting${suggest(key, PERSONA_SETTINGS)}`,
		}));

/** A persona's own settings: only the groups in settings.ts PERSONA_SETTINGS; the values are checked by SettingsSchema after the merge. */
export const PersonaSettingsSchema = z
	.record(z.unknown(), { invalid_type_error: 'must be a mapping of settings' })
	.superRefine((settings, ctx) => {
		for (const { key, message } of personaSettingKeyIssues(settings)) addQuietIssue(ctx, [key], message);
	})
	.optional();

/** A persona's own `settings` setting a global-only group to null: gone once merged (merge.ts), before the schema sees it, so refused here. */
export const clearedSettingIssues = (own: unknown) => {
	if (!isPlainObject(own)) return [];
	return personaSettingKeyIssues(Object.fromEntries(Object.entries(own).filter(([key, value]) => value === null && !(PERSONA_SETTINGS as readonly string[]).includes(key))));
};

/**
 * `persona` over `defaults`: deepMerge, except the hours, which come whole from one layer (a persona's own window or
 * schedule replaces the defaults' window and schedule), and `character.boundaries`, which add up (defaults first, no
 * duplicates), so a persona can't drop a shared limit by listing its own.
 */
export function applyPersonaDefaults(defaults: Record<string, unknown>, persona: unknown): unknown {
	if (!isPlainObject(persona)) return persona;
	// Its own hours remove the defaults' (a null key is removed, merge.ts)
	const ownHours = persona.window !== undefined || persona.schedule !== undefined;
	const merged = deepMerge(ownHours ? deepMerge(defaults, { window: null, schedule: null }) : defaults, persona);
	const shared = valueAt(defaults, ['character', 'boundaries']);
	const own = valueAt(persona, ['character', 'boundaries']);
	if (!Array.isArray(shared) || !isPlainObject(merged)) return merged;
	// `character: null` (or `boundaries: null`) clears the persona's own, never the shared ones
	if (merged.character !== undefined && !isPlainObject(merged.character)) return merged;
	// Not a list (`boundaries: "no hands"`): left as written, so CharacterSchema refuses it rather than the limit being lost
	if (own !== undefined && own !== null && !Array.isArray(own)) return merged;
	const boundaries = [...new Set([...shared, ...(Array.isArray(own) ? own : [])])];
	return { ...merged, character: { ...merged.character, boundaries } };
}

/**
 * The settings in effect for each persona: the layers as written (`shared`, then each persona's `own` settings, of
 * which only the PERSONA_SETTINGS groups count) merged, then parsed once by SettingsSchema. While the shared settings
 * have problems there are none, for any persona. Each problem is reported in its file (`files`); unknown keys are
 * reported apart, once, with a suggestion.
 */
export function layerSettings(shared: unknown, own: readonly unknown[], files: { shared: string; personas: readonly string[] }): { shared?: Settings; personas: (Settings | undefined)[]; issues: string[] } {
	const issues: string[] = [];
	const parsed = SettingsSchema.safeParse(shared);
	for (const issue of parsed.success ? [] : parsed.error.issues.filter((found) => found.code !== 'unrecognized_keys')) {
		issues.push(inFile(files.shared, describe(['settings', ...issue.path], issue.message, valueAt(shared, issue.path))));
	}
	const sharedChecks = parsed.success ? checkSettings(parsed.data) : [];
	for (const issue of sharedChecks) issues.push(inFile(files.shared, describe(['settings', ...issue.path], issue.message, undefined)));
	// A persona that only inherits a shared problem isn't reported again for it
	const inherited = new Set(sharedChecks.map((issue) => issueKey(issue.path, issue.message)));
	const personas = own.map((settings, index) => {
		if (!parsed.success) return undefined;
		const file = files.personas[index]!;
		// Each layer merged in turn (not the persona already merged with its defaults), so a `null` of its own clears a shared value too
		const merged = deepMerge(shared, pickKeys(settings, PERSONA_SETTINGS));
		const result = SettingsSchema.safeParse(merged);
		if (!result.success) {
			for (const issue of result.error.issues) {
				if (issue.code === 'unrecognized_keys') continue;
				issues.push(inFile(file, describe(['settings', ...issue.path], issue.message, valueAt(merged, issue.path))));
			}
			return undefined;
		}
		for (const issue of checkSettings(result.data)) {
			if (!inherited.has(issueKey(issue.path, issue.message))) issues.push(inFile(file, describe(['settings', ...issue.path], issue.message, undefined)));
		}
		return result.data;
	});
	return { shared: parsed.success ? parsed.data : undefined, personas, issues };
}
