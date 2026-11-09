import type { Policy } from '../src/brain.js';
import type { Channel, ChannelAction, ChannelId } from '../src/channel.js';
import { parsePersona } from '../src/config/personas.js';
import { parseSettings, type Settings } from '../src/settings.js';
import { createStore, openDatabase } from '../src/store.js';

/** A store on its own in-memory database, gone with it: nothing to close. */
export const memoryStore = (now?: () => number) => createStore(openDatabase(':memory:'), now);

// What an application gives the brain, at today's default limits, for the brain's own tests: an identity phrase and a
// style block; a DM channel that answers invitations, offers an action of its own and notes what people see of the
// persona, one that does none of it, a group chat with a note and a posting channel, all 18+ (`adult`) as an 18+
// service's would be; and a DM channel that is not, where the minors safeguard is off
export const TEST_IDENTITY = 'a guide made by Forum (https://forum.example)';
export const TEST_STYLE = 'Write the way your voice does:\n- Short messages.';
const BOT_NOTE = 'Forum shows everyone your name marked [bot].';
/** The test DM channel's own action. */
export const SNOOZE: ChannelAction = { name: 'snooze', when: 'when you would rather pause the conversation for a while' };
export const NOTED_DM: Channel = { id: 'forum', where: 'Forum direct messages', maxLength: 950, identityNote: BOT_NOTE, invitations: true, actions: [SNOOZE], adult: true };
export const OPEN_DM: Channel = { id: 'chat', where: 'Chat direct messages', maxLength: 1800 };
export const PLAIN_DM: Channel = { ...OPEN_DM, adult: true };
/** The group chat's note, as an app would write one. */
export const GROUP_NOTE = 'Everyone here is planning a trip together: keep to it.';
export const groupChannel = (name: string): Channel => ({ id: 'forum', where: `the group chat "${name}" on Forum`, maxLength: 190, identityNote: BOT_NOTE, notes: [GROUP_NOTE], adult: true });
export const postChannel = (maxLength: number): Channel => ({ id: 'chat', where: 'a Chat channel where members share short updates', maxLength, notes: ['Say what you are up to.'], adult: true });

/** An application's policy, as it would pass one: a few rule lines, and its url the only link. */
export const TEST_POLICY = { rules: ['Never ask for personal data.', 'Respect a no at once.'], allowedLinks: ['https://forum.example'] } satisfies Policy;

/** The same online block every day, as a schedule: its start and end ranges (`[earliest, latest]`), and the chance of a day off. */
export const everyDay = (start: [string, string], end: [string, string], skipDayChance?: number) => ({
	...(skipDayChance !== undefined && { skipDayChance }),
	days: { 'mon-sun': { online: [{ start, end }] } },
});

/**
 * The 'test' persona's config as written, online 19:00 to 23:00 UTC every day (a LEGACY row in schedule.test.ts), with
 * these fields over its own. Authoritative: an application embedding the package may keep a copy for its own tests.
 */
export const testPersona = (fields: Record<string, unknown> = {}) => ({
	id: 'test',
	name: 'Test',
	timezone: 'UTC',
	schedule: everyDay(['19:00', '19:00'], ['23:00', '23:00']),
	...fields,
});

/**
 * parsePersona on this config with `prompt`, on `channels` (both test channels unless given), for 18+ conversations
 * with `adult`, its own settings checked over `settings` (the defaults unless given).
 */
export const parsedOf = (
	config: unknown,
	{ prompt = 'A voice.', channels = ['forum', 'chat'], adult, settings, source }: { prompt?: string; channels?: ChannelId[]; adult?: boolean; settings?: Settings; source?: string } = {},
) => parsePersona({ config, prompt, channels, adult, settings, source });

/** The persona of parsedOf, which must have no problem. */
export const personaOf = (config: unknown, options?: Parameters<typeof parsedOf>[1]) => {
	const { persona, issues } = parsedOf(config, options);
	if (!persona) throw new Error(issues.join('\n'));
	return persona;
};

/** parseSettings on these settings as written, which must have no problem. */
export const settingsOf = (raw: unknown = {}) => {
	const { settings, issues } = parseSettings(raw);
	if (!settings) throw new Error(issues.join('\n'));
	return settings;
};
