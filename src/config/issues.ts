/**
 * How config problems are worded and found: each with its path (and the file it is in, where that is not the
 * ConfigError's own), and keys the schema doesn't know (zod drops them), each an error with the nearest known one.
 */

import { z } from 'zod';
import { isPlainObject, valueAt } from '../merge.js';

// ---------------------------------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------------------------------

export class ConfigError extends Error {
	constructor(
		readonly file: string,
		readonly issues: string[],
		/** The warnings found with the problems (as the config's warnings), so one run shows both. */
		readonly warnings: string[] = [],
	) {
		super(`${file} has ${issues.length} problem${issues.length === 1 ? '' : 's'}:\n  - ${issues.join('\n  - ')}`);
		this.name = 'ConfigError';
	}
}

/** A config's problems: `issues` refuse it, `warnings` are shown without refusing it (a strict check may make them errors). */
export interface Problems {
	issues: string[];
	warnings: string[];
}

/** Marks an issue whose raw value says nothing useful (an unknown or misplaced key, or a message that names it): no "(got …)". */
const QUIET = { quiet: true };
export const addQuietIssue = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message, params: QUIET });
/** The value an issue is shown with: none for a QUIET one. */
export const shownValue = (issue: z.ZodIssue, raw: unknown) => (issue.code === 'custom' && (issue.params as { quiet?: boolean } | undefined)?.quiet ? undefined : valueAt(raw, issue.path));

const gotText = (value: unknown) => {
	if (value === undefined) return '';
	const text = JSON.stringify(value) ?? String(value);
	return ` (got ${text.length > 40 ? `${text.slice(0, 39)}…` : text})`;
};

/** A problem as shown: its path, the message, and the value it got if any. */
export const describe = (path: readonly (string | number)[], message: string, got: unknown) => `${path.length ? `${path.join('.')}: ` : ''}${message}${gotText(got)}`;

/** A problem of another file than the ConfigError's: "<file> › <problem>". */
export const inFile = (file: string, problem: string) => `${file} › ${problem}`;

/** An issue's identity, to tell one a layer only inherits (reported once, where it is written) from its own. */
export const issueKey = (path: readonly (string | number)[], message: string) => `${path.join('.')}:${message}`;
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------------
// Unknown keys and suggestions
// ---------------------------------------------------------------------------------------------------

const levenshtein = (a: string, b: string) => {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		row = next;
	}
	return row[b.length]!;
};

const nearest = (key: string, known: readonly string[]) => {
	let best: { key: string; distance: number } | undefined;
	for (const candidate of known) {
		const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
		if (distance <= 2 && (!best || distance < best.distance)) best = { key: candidate, distance };
	}
	return best?.key;
};

const didYouMean = (match: string | undefined) => (match ? ` (did you mean "${match}"?)` : '');

/** ' (did you mean "pacing"?)' or '' */
export function suggest(key: string, known: readonly string[]): string {
	return didYouMean(nearest(key, known));
}

const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
	if (schema instanceof z.ZodDefault) return unwrap(schema._def.innerType);
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap());
	if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
	return schema;
};

export interface UnknownKey {
	path: (string | number)[];
	suggestion?: string;
}

/**
 * Keys in `raw` the schema doesn't know (zod drops them silently), as dotted paths, each with the nearest known key
 * (Levenshtein ≤ 2). Unwraps ZodDefault, ZodOptional, ZodEffects, ZodArray; walks ZodObject shapes and ZodRecord values.
 */
export function unknownKeys(schema: z.ZodTypeAny, raw: unknown, path: (string | number)[] = []): UnknownKey[] {
	const inner = unwrap(schema);
	if (inner instanceof z.ZodArray && Array.isArray(raw)) return raw.flatMap((item, index) => unknownKeys(inner.element as z.ZodTypeAny, item, [...path, index]));
	if (inner instanceof z.ZodRecord && isPlainObject(raw)) return Object.entries(raw).flatMap(([key, value]) => unknownKeys(inner.valueSchema as z.ZodTypeAny, value, [...path, key]));
	if (!(inner instanceof z.ZodObject) || !isPlainObject(raw)) return [];
	const shape = inner.shape as Record<string, z.ZodTypeAny>;
	const known = Object.keys(shape);
	return Object.entries(raw).flatMap(([key, value]) => {
		if (!(key in shape)) {
			const suggestion = nearest(key, known);
			return [{ path: [...path, key], ...(suggestion && { suggestion }) }];
		}
		return unknownKeys(shape[key]!, value, [...path, key]);
	});
}

/** The unknown keys found under `at`, each an issue: a key the schema doesn't know is never silently ignored. */
export function unknownKeyIssues(found: UnknownKey[], at: readonly (string | number)[]): string[] {
	return found.map(({ path, suggestion }) => describe([...at, ...path], `unknown key${didYouMean(suggestion)}`, undefined));
}
