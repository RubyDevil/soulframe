import type { Policy } from '../src/brain.js';
import type { Channel, ChannelAction, ChannelId } from '../src/channel.js';
import { parsePersonas } from '../src/config/personas.js';
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

/**
 * The 'test' persona's file as written, online 19:00 to 23:00 UTC every day (a LEGACY row in schedule.test.ts), with
 * these fields over its own. Authoritative: an application embedding the package may keep a copy for its own tests.
 */
export const testPersona = (fields: Record<string, unknown> = {}) => ({
	name: 'Test',
	prompt: 'test.md',
	timezone: 'UTC',
	window: { start: ['19:00', '19:00'], end: ['23:00', '23:00'] },
	...fields,
});

/**
 * parsePersonas on these persona files as written, by id (each read from `<id>.yaml`, its prompt `prompt`), with
 * `_shared.yaml` when given, each on `channels` (both test channels unless given), for 18+ conversations with `adult`.
 */
export const loadedOf = (
	raws: Record<string, unknown>,
	{ shared, channels = ['forum', 'chat'], prompt = 'A voice.', adult }: { shared?: unknown; channels?: ChannelId[]; prompt?: string; adult?: boolean } = {},
) =>
	parsePersonas({
		adult,
		shared,
		personas: Object.entries(raws).map(([id, raw]) => ({ id, raw, file: `${id}.yaml` })),
		channels: Object.fromEntries(Object.keys(raws).map((id) => [id, channels])),
		readPrompt: () => prompt,
	});

/** The personas of loadedOf, which must have no problem. */
export const personasOf = (raws: Record<string, unknown>, options?: Parameters<typeof loadedOf>[1]) => {
	const loaded = loadedOf(raws, options);
	if (loaded.issues.length) throw new Error(loaded.issues.join('\n'));
	return loaded.personas;
};
