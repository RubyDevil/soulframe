import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ScheduleSchema, WindowSchema } from '../src/config/hours.js';
import { loadPersonas, type ConfigFiles } from '../src/config/personas.js';
import { scheduleOfWindow } from '../src/schedule.js';
import { loadedOf, personasOf, testPersona } from './fixtures.js';

/** The problems of these persona files (by id), with `_shared.yaml` when given, on these channels. */
const issuesOf = (raws: Record<string, unknown>, options?: Parameters<typeof loadedOf>[1]) => loadedOf(raws, options).issues;
/** The test persona with these fields over its own. */
const test = (fields: Record<string, unknown> = {}) => personasOf({ test: testPersona(fields) })[0]!;
/** The test persona's file without hours of its own (with these fields), and a second one when asked. */
const withoutHours = (fields: Record<string, unknown> = {}, second = false) => ({
	test: testPersona({ window: undefined, ...fields }),
	...(second && { other: testPersona({ window: undefined, name: 'Other' }) }),
});

const WINDOW = { start: ['19:00', '19:30'], end: ['23:00', '23:30'] };
const EVENINGS = { days: { 'mon-sun': { online: [{ start: ['20:00', '20:30'], end: ['23:30', '00:30'] }] } } };
/** Two evening ranges of which the second can start before the first ends. */
const CLASHING = { 'mon-sun': { online: [{ start: ['19:00', '19:30'], end: ['22:00', '23:00'] }, { start: ['22:30', '23:00'], end: ['01:00', '01:30'] }] } };

describe('a persona file', () => {
	it('loads with its id from the file name, its prompt beside it, and the defaults filled in', () => {
		const loaded = loadedOf({ test: testPersona({ prompt: undefined }) }, { prompt: 'Voice' });
		expect(loaded.issues).toEqual([]);
		expect(loaded.personas[0]).toMatchObject({ id: 'test', name: 'Test', prompt: resolve('test.md'), promptText: 'Voice', chattiness: 'easygoing', source: 'test.yaml' });
		expect(loaded.personas[0]!.character).toEqual({ facts: [], interests: [], boundaries: [], moods: [] });
	});

	it('resolves its prompt relative to the file', () => {
		expect(personasOf({ test: testPersona({ prompt: '../prompts/test.md' }) })[0]!.prompt).toBe(resolve('../prompts/test.md'));
	});

	it('refuses an id that is not its file name, and a file that is not a mapping', () => {
		expect(issuesOf({ test: testPersona({ id: 'other' }) })).toEqual(['test.yaml › id: "other" but the file is test.yaml']);
		expect(personasOf({ test: testPersona({ id: 'test' }) })[0]!.id).toBe('test');
		expect(issuesOf({ test: ['not', 'a', 'mapping'] })).toEqual(["test.yaml: must be a mapping (a persona's fields)"]);
	});

	it('refuses every key it does not know, the app\'s roster keys of the old layout too, with the nearest one', () => {
		expect(issuesOf({ test: testPersona({ chatiness: 'quiet', forum: { username: 'test_bot' }, character: { fact: [] } }) })).toEqual([
			'test.yaml › chatiness: unknown key (did you mean "chattiness"?)',
			'test.yaml › forum: unknown key',
			'test.yaml › character.fact: unknown key (did you mean "facts"?)',
		]);
	});

	it("says when its prompt can't be read", () => {
		const loaded = loadPersonas({ dir: resolve('virtual'), channels: { test: ['forum'] }, files: virtual({ [resolve('virtual', 'test.yaml')]: testPersona({ prompt: undefined }) }) });
		expect(loaded.issues).toEqual([`${resolve('virtual', 'test.yaml')} › prompt: can't read ${resolve('virtual', 'test.md')} (ENOENT)`]);
		expect(loaded.personas).toEqual([]);
	});

	it('has a chattiness of its own, else _shared.yaml\'s, else easygoing', () => {
		expect(test().chattiness).toBe('easygoing');
		expect(personasOf({ test: testPersona() }, { shared: { chattiness: 'quiet' } })[0]!.chattiness).toBe('quiet');
		expect(personasOf({ test: testPersona({ chattiness: 'talkative' }) }, { shared: { chattiness: 'quiet' } })[0]!.chattiness).toBe('talkative');
		expect(issuesOf({ test: testPersona({ chattiness: 'loud' }) })).toEqual([
			"test.yaml › chattiness: Invalid enum value. Expected 'quiet' | 'easygoing' | 'talkative', received 'loud' (got \"loud\")",
		]);
	});

	it("is sfw when it says so, else when _shared.yaml does, and not by default", () => {
		expect(test().sfw).toBe(false);
		expect(test({ sfw: true }).sfw).toBe(true);
		expect(personasOf({ test: testPersona() }, { shared: { sfw: true } })[0]!.sfw).toBe(true);
		expect(personasOf({ test: testPersona({ sfw: false }) }, { shared: { sfw: true } })[0]!.sfw).toBe(false);
	});

	it('refuses an sfw that is not a boolean, and suggests it for a misspelled key', () => {
		expect(issuesOf({ test: testPersona({ sfw: 'yes' }) })).toEqual(['test.yaml › sfw: Expected boolean, received string (got "yes")']);
		expect(issuesOf({ test: testPersona({ sfv: true }) })).toEqual(['test.yaml › sfv: unknown key (did you mean "sfw"?)']);
	});
});

/** Files read from these contents (a value is written as YAML), any other path missing. */
const virtual = (contents: Record<string, unknown>): ConfigFiles => ({
	exists: (path) => path in contents,
	read: (path) => {
		if (!(path in contents)) throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' });
		const content = contents[path];
		return typeof content === 'string' ? content : stringify(content);
	},
});

describe('the persona folder', () => {
	const dir = resolve('virtual', 'personas');
	const at = (name: string) => join(dir, name);

	it('reads _shared.yaml when there is one, and each persona asked for, in that order', () => {
		const files = virtual({ [at('_shared.yaml')]: { chattiness: 'quiet' }, [at('bo.yaml')]: testPersona({ name: 'Bo' }), [at('al.yaml')]: testPersona({ name: 'Al' }), [at('test.md')]: 'Voice' });
		const loaded = loadPersonas({ dir, channels: { bo: ['forum'], al: ['forum'] }, files });
		expect(loaded.issues).toEqual([]);
		expect(loaded.personas.map((persona) => [persona.id, persona.chattiness, persona.source, persona.promptText])).toEqual([['bo', 'quiet', at('bo.yaml'), 'Voice'], ['al', 'quiet', at('al.yaml'), 'Voice']]);
		const unshared = virtual({ [at('al.yaml')]: testPersona(), [at('test.md')]: 'Voice' });
		expect(loadPersonas({ dir, channels: { al: ['forum'] }, files: unshared }).personas[0]!.chattiness).toBe('easygoing');
	});

	it('says which persona has no file, and refuses an id that is no file name', () => {
		const loaded = loadPersonas({ dir, channels: { robin: ['forum'], 'Bad Id': ['forum'] }, files: virtual({}) });
		expect(loaded.issues).toEqual([`no file ${at('robin.yaml')}`, '"Bad Id" is not a persona id: 2 to 32 of a-z, 0-9 and - (its file\'s name without .yaml)']);
	});

	it('names the file of each problem, and reports what it can of the others', () => {
		const files = virtual({ [at('robin.yaml')]: testPersona({ window: undefined, schedule: { days: CLASHING } }), [at('sky.yaml')]: 'name: [unclosed', [at('test.md')]: 'Voice' });
		const loaded = loadPersonas({ dir, channels: { robin: ['forum'], sky: ['forum'] }, files });
		expect(loaded.issues).toHaveLength(2);
		expect(loaded.issues[0]).toMatch(new RegExp(`^${at('sky.yaml').replace(/\\/g, '\\\\')}: `));
		expect(loaded.issues[1]).toBe(`${at('robin.yaml')} › schedule.days.mon-sun.online.1: can overlap online.0 (19:00 to 23:00)`);
	});
});

describe('settings', () => {
	it('come from _shared.yaml with each persona\'s own over them, key by key', () => {
		const personas = personasOf(
			{ test: testPersona({ settings: { context: { situation: false, timeSince: true } } }), other: testPersona({ name: 'Other' }) },
			{ shared: { settings: { context: { awayContext: false, relationship: false, timeSince: false } } } },
		);
		expect(personas.map((persona) => persona.settings.context)).toEqual([
			{ situation: false, upcoming: true, awayContext: false, relationship: false, timeSince: true },
			{ situation: true, upcoming: true, awayContext: false, relationship: false, timeSince: false },
		]);
	});

	it("are _shared.yaml's alone for llm and decisions, which no persona can set", () => {
		const loaded = loadedOf({ test: testPersona({ settings: { llm: { model: 'mine' }, decisions: { enabled: true }, maxLength: { forum: 500 } } }) }, { shared: { settings: { llm: { model: 'shared' } } } });
		expect(loaded.issues).toEqual([
			'test.yaml › settings.llm: cannot be set per persona: the text provider and its daily cap are shared (a persona may name its own models in settings.models)',
			'test.yaml › settings.decisions: cannot be set per persona: the safety checks are the same for every persona (set them under the global settings.decisions)',
			'test.yaml › settings.maxLength: not a setting',
		]);
		const shared = loadedOf({ test: testPersona() }, { shared: { settings: { llm: { model: 'shared' }, decisions: { enabled: true } } } });
		expect(shared.shared).toMatchObject({ llm: { model: 'shared' }, decisions: { enabled: true } });
		expect(shared.personas[0]!.settings).toEqual(shared.shared);
	});

	it("report a problem of _shared.yaml's once, there, and an unknown key with a suggestion", () => {
		expect(issuesOf({ test: testPersona() }, { shared: { settings: { pacing: { quickReplyChanse: 0.5 }, memory: { personNotes: -1 } } } })).toEqual([
			'_shared.yaml › settings.pacing.quickReplyChanse: unknown key (did you mean "quickReplyChance"?)',
			'_shared.yaml › settings.memory.personNotes: Number must be greater than or equal to 0 (got -1)',
		]);
		const pacing = { quickReplyChance: 0.8, slowReplyChance: 0.5 };
		expect(issuesOf({ test: testPersona(), other: testPersona({ name: 'Other' }) }, { shared: { settings: { pacing } } })).toEqual(['_shared.yaml › settings.pacing: quickReplyChance and slowReplyChance add up to more than 1']);
	});

	it("report a persona's own problem in its file, and a null of its own clears the shared value", () => {
		expect(issuesOf({ test: testPersona({ settings: { memory: { personNotes: 5000 } } }) })).toEqual(['test.yaml › settings.memory.personNotes: Number must be less than or equal to 2000 (got 5000)']);
		expect(issuesOf({ test: testPersona({ settings: { llm: null } }) })).toEqual([
			'test.yaml › settings.llm: cannot be set per persona: the text provider and its daily cap are shared (a persona may name its own models in settings.models)',
		]);
		const cleared = personasOf({ test: testPersona({ settings: { models: { directMessage: { model: null } } } }) }, { shared: { settings: { models: { directMessage: { model: 'shared-model' } } } } });
		expect(cleared[0]!.settings.models.directMessage.model).toBeUndefined();
	});
});

describe('_shared.yaml', () => {
	it("refuses who a persona is, the app's keys and anything it does not know", () => {
		expect(issuesOf({ test: testPersona() }, { shared: { name: 'Everyone', prompt: 'all.md', forum: { emailEnv: 'SHARED_EMAIL' }, timezon: 'UTC' } })).toEqual([
			"_shared.yaml › name: is each persona's own, not a default",
			"_shared.yaml › prompt: is each persona's own, not a default",
			'_shared.yaml › forum: unknown key',
			'_shared.yaml › timezon: unknown key (did you mean "timezone"?)',
		]);
	});

	it('must be a mapping', () => {
		expect(issuesOf({ test: testPersona() }, { shared: ['a list'] })).toEqual(['_shared.yaml: must be a mapping (what every persona has unless it sets its own)']);
	});

	it("adds its boundaries to each persona's own", () => {
		const persona = personasOf({ test: testPersona({ character: { boundaries: ['talk about exes'] } }) }, { shared: { character: { boundaries: ['real people'], facts: ['shared fact'] } } })[0]!;
		expect(persona.character).toMatchObject({ boundaries: ['real people', 'talk about exes'], facts: ['shared fact'] });
	});
});

describe('hours', () => {
	it('loads a window as a schedule with the same hours every day', () => {
		const persona = test();
		expect(persona.schedule).toEqual(scheduleOfWindow({ start: ['19:00', '19:00'], end: ['23:00', '23:00'], skipDayChance: 0 }));
		expect(persona).not.toHaveProperty('window');
	});

	it('refuses a window that can end before it starts, can last over 20 hours, or has a range over 12 hours', () => {
		expect(issuesOf({ test: testPersona({ window: { start: ['19:00', '20:00'], end: ['19:30', '20:30'] } }) })).toEqual(['test.yaml › window.end: can end before it starts (start up to 20:00, end from 19:30)']);
		expect(issuesOf({ test: testPersona({ window: { start: ['04:00', '05:00'], end: ['23:00', '01:15'] } }) })).toEqual(['test.yaml › window.end: lasts up to 21:15 hours (at most 20)']);
		expect(issuesOf({ test: testPersona({ window: { start: ['20:30', '19:30'], end: ['23:00', '23:30'] } }) })).toEqual([
			'test.yaml › window.start: a range of 23:00 hours: are earliest and latest swapped? (a latest before the earliest is the next day)',
		]);
		// A clock that isn't one is only that
		expect(issuesOf({ test: testPersona({ window: { start: ['25:00', '19:00'], end: ['23:00', '23:00'] } }) })).toEqual(['test.yaml › window.start.0: a time as HH:MM (got "25:00")']);
	});

	it('loads a schedule as written, its defaults filled in', () => {
		expect(personasOf(withoutHours({ schedule: EVENINGS }))[0]!.schedule).toEqual(ScheduleSchema.parse(EVENINGS));
	});

	it('wants exactly one of window and schedule', () => {
		expect(issuesOf({ test: testPersona({ window: WINDOW, schedule: EVENINGS }) })).toEqual(['test.yaml › schedule: set window or schedule, not both']);
		expect(issuesOf(withoutHours())).toEqual(['test.yaml › window: needs window (the same hours every day) or schedule']);
	});

	it("refuses a schedule's problems at their path, an unknown key in it too", () => {
		expect(issuesOf(withoutHours({ schedule: { days: { ...CLASHING, 'mon-sun': { ...CLASHING['mon-sun'], braeks: [] } } } }))).toEqual([
			'test.yaml › schedule.days.mon-sun.online.1: can overlap online.0 (19:00 to 23:00)',
			'test.yaml › schedule.days.mon-sun.braeks: unknown key (did you mean "breaks"?)',
		]);
	});

	const busyAs = (reason: string) => ({ schedule: { days: { 'mon-sun': { busy: [{ reason, start: ['18:00', '18:00'], end: ['19:30', '19:30'] }] } } } });
	const withReason = (reason: string) => withoutHours(busyAs(reason));
	const refused = (reason: string, message: string, file = 'test.yaml') => [`${file} › schedule.days.mon-sun.busy.0.reason: ${message} (got "${reason}")`];
	const SCHOOL = 'no school or student framing (personas are adults); "at an evening class" at most';

	it('refuses sleep as a busy reason, with or without adult', () => {
		expect(issuesOf(withReason('asleep'))).toEqual(refused('asleep', 'sleep is never a busy reason (the night is simply offline)'));
		expect(issuesOf(withReason('asleep'), { adult: true })).toEqual(refused('asleep', 'sleep is never a busy reason (the night is simply offline)'));
	});

	it('refuses school as a busy reason for 18+ conversations (adult), "at an evening class" aside', () => {
		for (const reason of ['at school', 'at a yoga class', 'doing homework']) {
			expect(issuesOf(withReason(reason), { adult: true })).toEqual(refused(reason, SCHOOL));
		}
		expect(personasOf(withReason('at an evening class'), { adult: true })[0]!.schedule.days['mon-sun']!.busy[0]!.reason).toBe('at an evening class');
	});

	it('takes school as a busy reason without adult', () => {
		expect(personasOf(withReason('at school'))[0]!.schedule.days['mon-sun']!.busy[0]!.reason).toBe('at school');
	});

	it("reports a school reason in _shared.yaml's hours once, there", () => {
		expect(issuesOf(withoutHours({}, true), { shared: busyAs('at school'), adult: true })).toEqual(refused('at school', SCHOOL, '_shared.yaml'));
	});
});

describe('the channels its hours name', () => {
	const days = (on: string[]) => ({ 'mon-sun': { online: [{ start: ['20:00', '20:00'], end: ['23:00', '23:00'], on }] } });

	it("refuses in `on` a channel that is not one of the persona's, with the nearest one", () => {
		expect(issuesOf(withoutHours({ schedule: { days: days(['chat']) } }), { channels: ['forum'] })).toEqual([`test.yaml › schedule.days.mon-sun.online.0.on: "chat" is not one of this persona's channels (forum)`]);
		expect(issuesOf(withoutHours({ schedule: { days: days(['forum', 'caht']) } }))).toEqual([
			`test.yaml › schedule.days.mon-sun.online.0.on: "caht" is not one of this persona's channels (forum, chat) (did you mean "chat"?)`,
		]);
		expect(personasOf(withoutHours({ schedule: { days: days(['chat']) } }))[0]!.schedule.days['mon-sun']!.online[0]!.on).toEqual(['chat']);
	});

	it('reports hours from _shared.yaml once, there, naming every persona they fail for', () => {
		const loaded = loadedOf(withoutHours({}, true), { shared: { schedule: { days: days(['chat']) } }, channels: ['forum'] });
		expect(loaded.issues).toEqual(['_shared.yaml › schedule.days.mon-sun.online.0.on: "chat" is not one of the channels of test, other (forum)']);
		expect(loaded.personas).toEqual([]);
	});
});

describe('hours in _shared.yaml', () => {
	it('come whole from the persona when it has its own, never merged', () => {
		expect(personasOf({ test: testPersona({ window: WINDOW }) }, { shared: { schedule: EVENINGS } })[0]!.schedule).toEqual(scheduleOfWindow(WindowSchema.parse(WINDOW)));
		expect(personasOf(withoutHours({ schedule: EVENINGS }), { shared: { window: WINDOW } })[0]!.schedule).toEqual(ScheduleSchema.parse(EVENINGS));
		// A window of its own with only a skip chance is missing its times, rather than taking the default's
		expect(issuesOf({ test: testPersona({ window: { skipDayChance: 0.2 } }) }, { shared: { window: WINDOW } })).toEqual(['test.yaml › window.start: Required', 'test.yaml › window.end: Required']);
	});

	it('come whole from _shared.yaml otherwise', () => {
		expect(personasOf(withoutHours(), { shared: { schedule: EVENINGS } })[0]!.schedule).toEqual(ScheduleSchema.parse(EVENINGS));
	});

	it('refuses both a window and a schedule there, once', () => {
		expect(issuesOf(withoutHours({}, true), { shared: { window: WINDOW, schedule: EVENINGS } })).toEqual(['_shared.yaml › schedule: set window or schedule, not both']);
	});

	it('reports a bad shared window or schedule once, there', () => {
		expect(issuesOf(withoutHours({}, true), { shared: { window: { start: ['19:00', '20:00'], end: ['19:30', '20:30'] } } })).toEqual(['_shared.yaml › window.end: can end before it starts (start up to 20:00, end from 19:30)']);
		expect(issuesOf(withoutHours({}, true), { shared: { schedule: { days: { ...CLASHING, 'mon-sun': { ...CLASHING['mon-sun'], braeks: [] } } } } })).toEqual([
			'_shared.yaml › schedule.days.mon-sun.online.1: can overlap online.0 (19:00 to 23:00)',
			'_shared.yaml › schedule.days.mon-sun.braeks: unknown key (did you mean "breaks"?)',
		]);
	});
});

describe('time zones', () => {
	it('suggests the zone a typo was meant to be', () => {
		expect(issuesOf({ test: testPersona({ timezone: 'America/NewYork' }) })).toEqual(['test.yaml › timezone: not an IANA time zone (did you mean "America/New_York"?) (got "America/NewYork")']);
	});

	it('accepts every zone Intl knows, those missing from its list of zones too', () => {
		for (const timezone of ['UTC', 'Asia/Kolkata', 'America/Indiana/Indianapolis']) expect(test({ timezone }).timezone).toBe(timezone);
	});
});
