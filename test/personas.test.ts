import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ScheduleSchema } from '../src/config/hours.js';
import { loadPersonas, parsePersonaMarkdown, type ConfigFiles } from '../src/config/personas.js';
import { everyDay, parsedOf, personaOf, settingsOf, testPersona } from './fixtures.js';

/** The problems of this config (the test persona's unless given), with parsedOf's options. */
const issuesOf = (config: unknown, options?: Parameters<typeof parsedOf>[1]) => parsedOf(config, options).issues;
/** The test persona with these fields over its own. */
const test = (fields: Record<string, unknown> = {}) => personaOf(testPersona(fields));

const EVENINGS = { days: { 'mon-sun': { online: [{ start: ['20:00', '20:30'], end: ['23:30', '00:30'] }] } } };
/** Two evening ranges of which the second can start before the first ends. */
const CLASHING = { 'mon-sun': { online: [{ start: ['19:00', '19:30'], end: ['22:00', '23:00'] }, { start: ['22:30', '23:00'], end: ['01:00', '01:30'] }] } };

describe('a persona config', () => {
	it('loads with its fields, its prompt trimmed, and the defaults filled in', () => {
		const persona = personaOf(testPersona(), { prompt: '\n  A voice.\n\n' });
		expect(persona).toEqual({ id: 'test', name: 'Test', timezone: 'UTC', schedule: ScheduleSchema.parse(everyDay(['19:00', '19:00'], ['23:00', '23:00'])), prompt: 'A voice.' });
	});

	it('holds only what the code computes with: no settings, no character, no moods, no file path', () => {
		expect(Object.keys(test()).sort()).toEqual(['id', 'name', 'prompt', 'schedule', 'timezone']);
	});

	it('keeps its own pacing and relationship as written, checked as settings over the ones given (the defaults unless given)', () => {
		const own = { pacing: { glance: { medianSeconds: 90 }, typingCharsPerSecond: [2, 3] }, relationship: { familiarity: { growth: 0.02 } } };
		expect(test(own)).toMatchObject(own);
		expect(issuesOf(testPersona({ pacing: { glanse: { medianSeconds: 30 }, replySplitChance: 1.5 } }), { source: 'test.md' })).toEqual([
			'test.md › pacing.replySplitChance: Number must be less than or equal to 1 (got 1.5)',
			'test.md › pacing.glanse: unknown key (did you mean "glance"?)',
		]);
		// A rule across keys holds over the settings its brain will run with
		const slow = testPersona({ pacing: { glance: { medianSeconds: 400 } } });
		expect(issuesOf(slow)).toEqual(['pacing.glance: p90Seconds must be above medianSeconds (got {"medianSeconds":400,"p90Seconds":150,"…)']);
		expect(issuesOf(slow, { settings: settingsOf({ pacing: { glance: { p90Seconds: 900 } } }) })).toEqual([]);
	});

	it('refuses a config that is not a mapping, and a prompt that is not text', () => {
		expect(issuesOf(['not', 'a', 'mapping'])).toEqual(["the config must be a mapping (the persona's id, name, timezone, schedule…)"]);
		expect(parsedOf(testPersona(), { prompt: 42 as unknown as string }).issues).toEqual(["prompt: must be text: the persona's voice and background, in Markdown"]);
	});

	it('needs an id, a name, a time zone and a schedule, and names each one missing', () => {
		expect(issuesOf({})).toEqual(['id: Required', 'name: Required', 'timezone: Required', 'schedule: Required']);
	});

	it("refuses a key named like one of an object's own (constructor, toString), as any other it doesn't know", () => {
		const schedule = { days: { 'mon-sun': { online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }], valueOf: 1 } } };
		expect(issuesOf(testPersona({ constructor: 'x', toString: true, schedule }))).toEqual(['schedule.days.mon-sun.valueOf: unknown key', 'constructor: unknown key', 'toString: unknown key']);
	});

	it('refuses an id that is not one', () => {
		expect(issuesOf(testPersona({ id: 'Robin Bot' }))).toEqual(['id: a persona id: 2 to 32 of a-z, 0-9 and - (got "Robin Bot")']);
	});

	it('names its source before each problem when given one: "<source> › <path>" for a key, "<source>:" for the whole', () => {
		expect(issuesOf(testPersona({ name: '' }), { source: 'test.md' })).toEqual(['test.md › name: String must contain at least 1 character(s) (got "")']);
		expect(issuesOf('oops', { source: 'test.md' })).toEqual(["test.md: the config must be a mapping (the persona's id, name, timezone, schedule…)"]);
	});

	it('refuses every key it does not know, the app\'s roster keys of the old layout too, with the nearest one', () => {
		expect(issuesOf(testPersona({ nmae: 'Test', forum: { username: 'test_bot' }, timezon: 'UTC' }))).toEqual([
			'nmae: unknown key (did you mean "name"?)',
			'forum: unknown key',
			'timezon: unknown key (did you mean "timezone"?)',
		]);
	});

	it('says where each key of the 0.1 betas went, rather than only that it is unknown', () => {
		const old = { window: { start: ['19:00', '19:00'], end: ['23:00', '23:00'] }, prompt: 'test.md', chattiness: 'quiet', sfw: true, character: { facts: [] }, settings: { pacing: {} } };
		expect(issuesOf(testPersona(old))).toEqual([
			'window: no longer read: write the same hours as a schedule, `schedule: { skipDayChance, days: { mon-sun: { online: [{ start, end }] } } }`',
			"prompt: is no path any more: the prompt is the text after the frontmatter (parsePersona's `prompt`)",
			"chattiness: no longer read: say how much it talks in group chats in its prompt (with the group-chat gate on, how readily it speaks is its brain's decisions.groupChatGate.chimeInAt)",
			"sfw: is the brain's policy now: createBrain({ policy: { sfw: true } })",
			'character: no longer read: write its facts, interests and boundaries in its prompt (moods are gone)',
			"settings: no longer read: its own pacing and relationship are keys of its config now; any other setting is its brain's: createBrain({ settings })",
		]);
		// A window in place of a schedule: the schedule is missing, and the window says how to write it
		expect(issuesOf(testPersona({ schedule: undefined, window: old.window }))).toEqual(['schedule: Required', expect.stringMatching(/^window: no longer read/)]);
	});
});

/** A persona file's text: this config as YAML frontmatter, then the prompt. */
const markdown = (config: unknown, prompt = 'A voice.\n') => `---\n${stringify(config)}---\n\n${prompt}`;
/** The test persona's config as its file would hold it: no id (its file's name gives it). */
const fileConfig = (fields: Record<string, unknown> = {}) => testPersona({ id: undefined, ...fields });

describe('a persona file (parsePersonaMarkdown)', () => {
	const parse = (text: string, source?: string) => parsePersonaMarkdown(text, { id: 'test', channels: ['forum'], ...(source && { source }) });

	it('reads its config from the frontmatter and its prompt from the rest, its id from its name', () => {
		const { persona, issues } = parse(markdown(fileConfig({ name: 'Tess' }), 'You are Tess.\n\nYou like *rain*.\n'));
		expect(issues).toEqual([]);
		expect(persona).toMatchObject({ id: 'test', name: 'Tess', prompt: 'You are Tess.\n\nYou like *rain*.' });
	});

	it('takes an id in the frontmatter only when it is its own', () => {
		expect(parse(markdown(fileConfig({ id: 'test' }))).persona?.id).toBe('test');
		expect(parse(markdown(fileConfig({ id: 'other' })), 'test.md').issues).toEqual(['test.md › id: "other" but its id is "test" (its file\'s name without .md)']);
	});

	it('reads Windows line endings and a byte order mark, and a file with no prompt after its frontmatter', () => {
		const text = `﻿${markdown(fileConfig(), 'A voice.\nOn two lines.\n').replace(/\n/g, '\r\n')}`;
		expect(parse(text).persona?.prompt).toBe('A voice.\nOn two lines.');
		expect(parse(`---\n${stringify(fileConfig())}---`).persona?.prompt).toBe('');
	});

	it('says when there is no frontmatter, or it never ends', () => {
		expect(parse('name: Test\n\nA voice.', 'test.md').issues).toEqual(['test.md: no frontmatter: a persona file starts with its config between two --- lines']);
		expect(parse(`---\n${stringify(fileConfig())}\nA voice.`, 'test.md').issues).toEqual(['test.md: its frontmatter never ends: no --- line after the config']);
	});

	it('takes empty frontmatter as an empty config, and refuses one that is not a mapping', () => {
		expect(parse('---\n---\nA voice.').issues).toEqual(['name: Required', 'timezone: Required', 'schedule: Required']);
		expect(parse('---\n- a list\n---\nA voice.', 'test.md').issues).toEqual(["test.md: its frontmatter must be a mapping (the persona's config: name, timezone, schedule…)"]);
	});

	it("gives a YAML error at the file's own line", () => {
		const [issue] = parse('---\nname: Test\nschedule: [\n---\nA voice.', 'test.md').issues;
		expect(issue).toMatch(/^test\.md: .* at line 3, column 12/);
	});

	it('names its source before the problems of its config', () => {
		expect(parse(markdown(fileConfig({ timezone: 'America/NewYork' })), 'test.md').issues).toEqual([
			'test.md › timezone: not an IANA time zone (did you mean "America/New_York"?) (got "America/NewYork")',
		]);
	});
});

/** Files read from these contents (a string as it is), any other path missing. */
const virtual = (contents: Record<string, string>): ConfigFiles => ({
	exists: (path) => path in contents,
	read: (path) => {
		if (!(path in contents)) throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' });
		return contents[path]!;
	},
});

describe('the persona folder (loadPersonas)', () => {
	const dir = resolve('virtual', 'personas');
	const at = (name: string) => join(dir, name);

	it('reads <id>.md for each persona asked for, in that order, each on its own channels', () => {
		const files = virtual({ [at('bo.md')]: markdown(fileConfig({ name: 'Bo' }), 'Bo.'), [at('al.md')]: markdown(fileConfig({ name: 'Al' }), 'Al.'), [at('cy.md')]: markdown(fileConfig()) });
		const loaded = loadPersonas({ dir, channels: { bo: ['forum'], al: ['chat'] }, files });
		expect(loaded.issues).toEqual([]);
		expect(loaded.personas.map((persona) => [persona.id, persona.name, persona.prompt])).toEqual([['bo', 'Bo', 'Bo.'], ['al', 'Al', 'Al.']]);
	});

	it('says which persona has no file, refuses an id that is no file name, and says when a file cannot be read', () => {
		const unreadable: ConfigFiles = { exists: (path) => path.endsWith('.md'), read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
		expect(loadPersonas({ dir, channels: { robin: ['forum'], 'Bad Id': ['forum'] }, files: virtual({}) }).issues).toEqual([
			`no file ${at('robin.md')}`,
			'"Bad Id" is not a persona id: 2 to 32 of a-z, 0-9 and - (its file\'s name without .md)',
		]);
		expect(loadPersonas({ dir, channels: { robin: ['forum'] }, files: unreadable }).issues).toEqual([`${at('robin.md')}: can't read it (EACCES)`]);
	});

	it('names the file of each problem, and loads the personas without one', () => {
		const files = virtual({ [at('robin.md')]: markdown(fileConfig({ schedule: { days: CLASHING } })), [at('sky.md')]: '---\nname: [unclosed\n---\n', [at('kai.md')]: markdown(fileConfig({ name: 'Kai' })) });
		const loaded = loadPersonas({ dir, channels: { robin: ['forum'], sky: ['forum'], kai: ['forum'] }, files });
		expect(loaded.issues).toHaveLength(2);
		expect(loaded.issues[0]).toBe(`${at('robin.md')} › schedule.days.mon-sun.online.1: can overlap online.0 (19:00 to 23:00)`);
		expect(loaded.issues[1]).toMatch(new RegExp(`^${at('sky.md').replace(/\\/g, '\\\\')}: `));
		expect(loaded.personas.map((persona) => persona.id)).toEqual(['kai']);
	});

	it("reports a 0.1 beta file left in the folder, and loads nothing it may have set for (an <id>.yaml its persona, _shared.yaml every one)", () => {
		const both = { [at('robin.md')]: markdown(fileConfig({ name: 'Robin' })), [at('kai.md')]: markdown(fileConfig({ name: 'Kai' })) };
		const oldRobin = loadPersonas({ dir, channels: { robin: ['forum'], kai: ['forum'] }, files: virtual({ ...both, [at('robin.yaml')]: 'sfw: true' }) });
		expect(oldRobin.issues).toEqual([`${at('robin.yaml')}: no longer read: write its config as the frontmatter of ${at('robin.md')}, its prompt after it`]);
		expect(oldRobin.personas.map((persona) => persona.id)).toEqual(['kai']);
		const shared = loadPersonas({ dir, channels: { robin: ['forum'], kai: ['forum'] }, files: virtual({ ...both, [at('_shared.yaml')]: 'sfw: true' }) });
		expect(shared.issues).toEqual([expect.stringMatching(new RegExp(`^${at('_shared.yaml').replace(/\\/g, '\\\\')}: no longer read, and what it set applies to no persona: `))]);
		expect(shared.personas).toEqual([]);
		// Not migrated at all: the old file says where its config goes
		expect(loadPersonas({ dir, channels: { sky: ['forum'] }, files: virtual({ [at('sky.yaml')]: 'name: Sky' }) }).issues).toEqual([
			`no file ${at('sky.md')} (${at('sky.yaml')} is no longer read: write its config as the frontmatter of ${at('sky.md')}, its prompt after it)`,
		]);
	});

	it('refuses school as a busy reason for 18+ conversations (adult)', () => {
		const files = virtual({ [at('test.md')]: markdown(fileConfig({ schedule: { days: { 'mon-sun': { busy: [{ reason: 'at school', start: ['08:00', '08:00'], end: ['15:00', '15:00'] }] } } } })) });
		expect(loadPersonas({ dir, channels: { test: ['forum'] }, files }).issues).toEqual([]);
		expect(loadPersonas({ dir, channels: { test: ['forum'] }, files, adult: true }).issues).toEqual([
			`${at('test.md')} › schedule.days.mon-sun.busy.0.reason: no school or student framing (personas are adults); "at an evening class" at most (got "at school")`,
		]);
	});
});

describe('the example persona file', () => {
	it('loads as written, from disk (examples/personas/robin.md, shown in docs/configuration.md)', () => {
		const loaded = loadPersonas({ dir: fileURLToPath(new URL('../examples/personas', import.meta.url)), channels: { robin: ['chat'] }, adult: true });
		expect(loaded.issues).toEqual([]);
		expect(loaded.personas[0]).toMatchObject({ id: 'robin', name: 'Robin', timezone: 'Europe/Lisbon' });
		expect(loaded.personas[0]!.prompt).toMatch(/^You are Robin, 29,[^]*kindly\.$/);
	});
});

describe('hours', () => {
	it('loads a schedule as written, its defaults filled in', () => {
		expect(test({ schedule: EVENINGS }).schedule).toEqual(ScheduleSchema.parse(EVENINGS));
	});

	it("refuses a schedule's problems at their path, an unknown key in it too", () => {
		expect(issuesOf(testPersona({ schedule: { days: { ...CLASHING, 'mon-sun': { ...CLASHING['mon-sun'], braeks: [] } } } }))).toEqual([
			'schedule.days.mon-sun.online.1: can overlap online.0 (19:00 to 23:00)',
			'schedule.days.mon-sun.braeks: unknown key (did you mean "breaks"?)',
		]);
	});

	it('refuses a block that can end before it starts, can last over 20 hours, or has a range over 12 hours', () => {
		const online = (start: [string, string], end: [string, string]) => testPersona({ schedule: everyDay(start, end) });
		expect(issuesOf(online(['19:00', '20:00'], ['19:30', '20:30']))).toEqual(['schedule.days.mon-sun.online.0.end: can end before it starts (start up to 20:00, end from 19:30)']);
		expect(issuesOf(online(['04:00', '05:00'], ['23:00', '01:15']))).toEqual(['schedule.days.mon-sun.online.0.end: lasts up to 21:15 hours (at most 20)']);
		expect(issuesOf(online(['20:30', '19:30'], ['23:00', '23:30']))).toEqual([
			'schedule.days.mon-sun.online.0.start: a range of 23:00 hours: are earliest and latest swapped? (a latest before the earliest is the next day)',
		]);
		// A clock that isn't one is only that
		expect(issuesOf(online(['25:00', '19:00'], ['23:00', '23:00']))).toEqual(['schedule.days.mon-sun.online.0.start.0: a time as HH:MM (got "25:00")']);
	});

	const busyAs = (reason: string) => testPersona({ schedule: { days: { 'mon-sun': { busy: [{ reason, start: ['18:00', '18:00'], end: ['19:30', '19:30'] }] } } } });
	const refused = (reason: string, message: string) => [`schedule.days.mon-sun.busy.0.reason: ${message} (got "${reason}")`];
	const SCHOOL = 'no school or student framing (personas are adults); "at an evening class" at most';

	it('refuses sleep as a busy reason, with or without adult', () => {
		expect(issuesOf(busyAs('asleep'))).toEqual(refused('asleep', 'sleep is never a busy reason (the night is simply offline)'));
		expect(issuesOf(busyAs('asleep'), { adult: true })).toEqual(refused('asleep', 'sleep is never a busy reason (the night is simply offline)'));
	});

	it('refuses school as a busy reason for 18+ conversations (adult), "at an evening class" aside', () => {
		for (const reason of ['at school', 'at a yoga class', 'doing homework']) expect(issuesOf(busyAs(reason), { adult: true })).toEqual(refused(reason, SCHOOL));
		expect(personaOf(busyAs('at an evening class'), { adult: true }).schedule.days['mon-sun']!.busy[0]!.reason).toBe('at an evening class');
	});

	it('takes school as a busy reason without adult', () => {
		expect(personaOf(busyAs('at school')).schedule.days['mon-sun']!.busy[0]!.reason).toBe('at school');
	});
});

describe('the channels its hours name', () => {
	const on = (names: string[]) => testPersona({ schedule: { days: { 'mon-sun': { online: [{ start: ['20:00', '20:00'], end: ['23:00', '23:00'], on: names }] } } } });

	it("refuses in `on` a channel that is not one of the persona's, with the nearest one", () => {
		expect(issuesOf(on(['chat']), { channels: ['forum'] })).toEqual([`schedule.days.mon-sun.online.0.on: "chat" is not one of this persona's channels (forum)`]);
		expect(issuesOf(on(['forum', 'caht']))).toEqual([`schedule.days.mon-sun.online.0.on: "caht" is not one of this persona's channels (forum, chat) (did you mean "chat"?)`]);
		expect(issuesOf(on(['chat']), { channels: [] })).toEqual([`schedule.days.mon-sun.online.0.on: "chat" is not one of this persona's channels (none)`]);
		expect(personaOf(on(['chat'])).schedule.days['mon-sun']!.online[0]!.on).toEqual(['chat']);
	});
});

describe('time zones', () => {
	it('suggests the zone a typo was meant to be', () => {
		expect(issuesOf(testPersona({ timezone: 'America/NewYork' }))).toEqual(['timezone: not an IANA time zone (did you mean "America/New_York"?) (got "America/NewYork")']);
	});

	it('accepts every zone Intl knows, those missing from its list of zones too', () => {
		for (const timezone of ['UTC', 'Asia/Kolkata', 'America/Indiana/Indianapolis']) expect(test({ timezone }).timezone).toBe(timezone);
	});
});
