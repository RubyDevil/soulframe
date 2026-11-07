// The docs against the code, read as text (node:fs and regexes only):
// - every `file.ts:NN` (or `src/file.ts:NN`, a range `:NN-MM`, a list `file.ts:NN, :MM`) in the README and docs/
//   points at lines that exist, and at what the code span written just before it names;
// - every export of src/index.ts has its heading in docs/api.md, and every heading there is an export;
// - every relative link and anchor in the package's Markdown resolves.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const linesOf = (text: string) => text.split(/\r?\n/);

/** The package's Markdown, by path from its root: the README and docs/ carry the code references; links are checked in all of it. */
const REFERENCING = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
const MARKDOWN = [...REFERENCING, 'CHANGELOG.md', 'CONTRIBUTING.md'];

/** A Markdown file's lines, those of fenced code blocks blanked (line numbers kept): code samples are not prose. */
const proseOf = (text: string) => {
	let fenced = false;
	return linesOf(text).map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			return '';
		}
		return fenced ? '' : line;
	});
};

// --- Code references --------------------------------------------------------------------------------------------

/** `file.ts:NN` or `file.ts:NN-MM` (the file under src/, `src/` optional), or `:NN` right after ", " continuing the line's last file. */
const REFERENCE = /(?<![\w./-])(?:src\/)?((?:[\w-]+\/)*[\w-]+\.ts):(\d+)(?:-(\d+))?|(?<=, ):(\d+)(?:-(\d+))?(?!\d)/g;
/** Words that say nothing about a line: literals and keywords are everywhere. */
const NOT_NAMES = new Set(['true', 'false', 'null', 'undefined', 'const', 'let', 'return', 'new', 'typeof', 'await', 'async', 'function', 'export']);
/** The names in a code span: its identifiers, dotted paths cut into their parts, keywords and literals left out. */
const namesIn = (code: string) => [...new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter((name) => !NOT_NAMES.has(name));
const hasWord = (text: string, name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);

interface Reference {
	/** Where it is written: `docs/prompts.md:16`. */
	at: string;
	file: string;
	from: number;
	to: number;
	/** The code span written between the previous reference on the line (or its start) and this one, if any: what it names. */
	code?: string;
}

/**
 * The references on one line of a doc (`at` says where). A list continuation (`, :382`) takes the file of the
 * reference before it and names nothing; nor does a reference inside a code span of its own (`` `prompts.ts:49` ``,
 * an example of the format).
 */
const referencesOn = (line: string, at: string): Reference[] => {
	const found: Reference[] = [];
	let file: string | undefined;
	let after = 0;
	for (const match of line.matchAll(REFERENCE)) {
		const [, named, from, to, nextFrom, nextTo] = match;
		const continued = named === undefined;
		if (continued && file === undefined) continue;
		if (!continued) file = named;
		const before = line.slice(after, match.index);
		after = match.index + match[0].length;
		const insideSpan = (before.match(/`/g)?.length ?? 0) % 2 === 1;
		const code = continued || insideSpan ? undefined : [...before.matchAll(/`([^`]+)`/g)].at(-1)?.[1];
		const start = Number(continued ? nextFrom : from);
		found.push({ at, file: file!, from: start, to: Number((continued ? nextTo : to) ?? start), ...(code !== undefined && { code }) });
	}
	return found;
};

const referencesIn = (doc: string) => proseOf(read(doc)).flatMap((line, index) => referencesOn(line, `${doc}:${index + 1}`));

const sourceLines = new Map<string, string[] | null>();
const sourceOf = (file: string) => {
	if (!sourceLines.has(file)) sourceLines.set(file, existsSync(join(ROOT, 'src', file)) ? linesOf(read(`src/${file}`)) : null);
	return sourceLines.get(file)!;
};

/** What is wrong with a reference, or null: no such file or line, or lines that hold none of the names its code span gives. */
const problemOf = ({ file, from, to, code }: Reference): string | null => {
	const lines = sourceOf(file);
	if (!lines) return `src/${file} does not exist`;
	if (from < 1 || to < from || to > lines.length) return `src/${file} has ${lines.length} lines`;
	const names = code === undefined ? [] : namesIn(code);
	const range = lines.slice(from - 1, to).join('\n');
	if (!names.length || names.some((name) => hasWord(range, name))) return null;
	// The nearest line that holds the first name, to say where it went
	const holding = lines.map((text, i) => (hasWord(text, names[0]!) ? i + 1 : 0)).filter(Boolean);
	const nearest = holding.sort((a, b) => Math.abs(a - from) - Math.abs(b - from))[0];
	return `names \`${code}\` but reads "${lines[from - 1]!.trim()}"${nearest ? `; nearest line with ${names[0]}: ${nearest}` : ''}`;
};

describe('code references in the docs', () => {
	const references = REFERENCING.flatMap(referencesIn);

	it('finds the references the docs hold (the pattern still matches how they are written)', () => {
		expect(references.length).toBeGreaterThan(100);
		expect(references.filter((reference) => reference.code !== undefined).length).toBeGreaterThan(50);
	});

	it('points every one at existing lines that hold what its code span names', () => {
		const problems = references.flatMap((reference) => {
			const problem = problemOf(reference);
			return problem ? [`${reference.at} ${reference.file}:${reference.from}${reference.to === reference.from ? '' : `-${reference.to}`} ${problem}`] : [];
		});
		expect(problems).toEqual([]);
	});

	it('reads the forms the docs use, and checks what each names', () => {
		const shown = referencesOn('`compose` (brain.ts:318) at 12:45, in (`x`, src/config/personas.ts:76, :222-226) (`a.ts:1`)', 'x').map(
			({ file, from, to, code }) => `${file}:${from}-${to}${code === undefined ? '' : ` ${code}`}`,
		);
		expect(shown).toEqual(['brain.ts:318-318 compose', 'config/personas.ts:76-76 x', 'config/personas.ts:222-226', 'a.ts:1-1']);
		expect(namesIn("store.get(persona.id, 'selfNotes')")).toEqual(['store', 'get', 'persona', 'id', 'selfNotes']);
		expect(namesIn('null')).toEqual([]);
		expect(problemOf({ at: 'x', file: 'rng.ts', from: 2, to: 2, code: 'Rng' })).toBeNull();
		expect(problemOf({ at: 'x', file: 'rng.ts', from: 2, to: 2, code: 'pick' })).toMatch(/^names `pick` but reads .*; nearest line with pick: \d+$/);
		expect(problemOf({ at: 'x', file: 'rng.ts', from: 1, to: 9999 })).toMatch(/lines$/);
		expect(problemOf({ at: 'x', file: 'nope.ts', from: 1, to: 1 })).toBe('src/nope.ts does not exist');
	});
});

// --- The API reference ------------------------------------------------------------------------------------------

/** The names src/index.ts exports, each marked a type or a runtime value. */
const exported = [...read('src/index.ts').matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from/g)].flatMap(([, allTypes, list]) =>
	list!
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			const type = !!allTypes || item.startsWith('type ');
			return { name: item.replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)!, type };
		}),
);

const apiProse = proseOf(read('docs/api.md'));
/** What docs/api.md documents: the code spans of its `###` headings (one heading may name several). */
const documented = apiProse.flatMap((line) => (line.startsWith('### ') ? [...line.matchAll(/`([^`]+)`/g)].map((span) => span[1]!) : []));
/** The types the table of its introduction (before the first `##`) says are reached another way: not exported. */
const unexported = apiProse
	.slice(0, apiProse.findIndex((line) => line.startsWith('## ')))
	.flatMap((line) => (line.startsWith('| `') ? [...line.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((span) => span[1]!) : []));

describe('docs/api.md', () => {
	it('reads every export of src/index.ts (the runtime ones are what the module gives)', () => {
		expect(exported.filter((entry) => !entry.type).map((entry) => entry.name).sort()).toEqual(Object.keys(api).sort());
		expect(exported.some((entry) => entry.type)).toBe(true);
	});

	it('documents every export under its own heading', () => {
		expect(exported.map((entry) => entry.name).filter((name) => !documented.includes(name))).toEqual([]);
	});

	it('documents nothing that is not exported', () => {
		const names = new Set(exported.map((entry) => entry.name));
		expect(documented.filter((name) => !names.has(name))).toEqual([]);
		expect(unexported.length).toBeGreaterThan(0);
		expect(unexported.filter((name) => names.has(name))).toEqual([]);
	});
});

// --- Links ------------------------------------------------------------------------------------------------------

/** GitHub's anchor of a heading: lowercase, punctuation dropped (hyphens and underscores kept), spaces as hyphens. */
const slugOf = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

/** The anchors of a Markdown file's headings, a repeated one numbered as GitHub does (`-1`, `-2`). */
const anchorsOf = (path: string) => {
	const seen = new Map<string, number>();
	return new Set(
		proseOf(read(path)).flatMap((line) => {
			const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
			if (heading === undefined) return [];
			const slug = slugOf(heading);
			const count = seen.get(slug) ?? 0;
			seen.set(slug, count + 1);
			return [count ? `${slug}-${count}` : slug];
		}),
	);
};

/** The relative links of a Markdown file (`[text](target)`, an image's `src="…"`), outside code. */
const linksIn = (path: string) =>
	proseOf(read(path)).flatMap((line, index) => {
		const text = line.replace(/`[^`]*`/g, '');
		const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...text.matchAll(/\bsrc="([^"]+)"/g)].map((match) => match[1]!);
		return targets.filter((target) => !/^[a-z][a-z\d+.-]*:/i.test(target)).map((target) => ({ at: `${path}:${index + 1}`, target }));
	});

/** What is wrong with a link from `path`, or null. */
const linkProblem = (path: string, target: string): string | null => {
	const [file = '', anchor] = target.split('#');
	const resolved = file ? posix.join(posix.dirname(path), file) : path;
	if (!existsSync(join(ROOT, resolved))) return `${resolved} does not exist`;
	if (anchor === undefined) return null;
	if (!resolved.endsWith('.md') || statSync(join(ROOT, resolved)).isDirectory()) return `#${anchor} in a file that is not Markdown`;
	return anchorsOf(resolved).has(anchor) ? null : `${resolved} has no heading #${anchor}`;
};

describe('links in the docs', () => {
	it('resolves every relative link and anchor', () => {
		const links = MARKDOWN.flatMap(linksIn);
		expect(links.length).toBeGreaterThan(20);
		expect(links.flatMap(({ at, target }) => {
			const problem = linkProblem(at.replace(/:\d+$/, ''), target);
			return problem ? [`${at} (${target}): ${problem}`] : [];
		})).toEqual([]);
	});

	it('makes anchors as GitHub does', () => {
		expect(slugOf('Status: beta, not yet published')).toBe('status-beta-not-yet-published');
		expect(slugOf('The reply queue and the backlog')).toBe('the-reply-queue-and-the-backlog');
		expect(slugOf('`llm`')).toBe('llm');
		expect(slugOf('Decisions: optional typed checks')).toBe('decisions-optional-typed-checks');
		expect(linkProblem('README.md', './docs/nope.md')).toBe('docs/nope.md does not exist');
		expect(linkProblem('README.md', '#no-such-heading')).toBe('README.md has no heading #no-such-heading');
	});
});
