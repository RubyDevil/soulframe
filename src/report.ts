/**
 * What an app's config check says of one persona: its warnings, what is in effect for it (what it is doing now, today's and
 * tomorrow's agenda, its overrides, models, character, today's mood), and the system prompt of a sample DM turn,
 * built by the brain itself. Nothing is started and nothing touches the network.
 */

import { createBrain, type Policy } from './brain.js';
import type { Channel, ChannelId } from './channel.js';
import type { PersonaConfig } from './config/personas.js';
import { providerSet, type Llm, type LlmMessage } from './llm.js';
import { diffPaths, valueAt } from './merge.js';
import { moodOf } from './mood.js';
import { clockText } from './prompts.js';
import { addDays, agendaOn, isOn, localDateOf, nextSpan, onlineMinutesByWeekday, spanAt, weekdayOf, WEEKDAYS, type DayAgenda, type LocalDate } from './schedule.js';
import { DAY, MINUTE, type Settings } from './settings.js';
import { createStore, openDatabase, type Person } from './store.js';

/** A city's zone follows its daylight saving; an abbreviation (EST) or a fixed offset (Etc/GMT+5) never does. UTC is meant as it is. */
const isCityZone = (timeZone: string) => timeZone === 'UTC' || (timeZone.includes('/') && !timeZone.startsWith('Etc/'));

/**
 * Warnings about a persona: a time zone that is no city's, a weekday over 20 hours online, under an hour a day on
 * average, more than every other day off, one of its `channels` that no span ever includes, and no text provider.
 */
export function personaWarnings(persona: PersonaConfig, channels: readonly ChannelId[]): string[] {
	const { id, schedule, timezone } = persona;
	const minutes = onlineMinutesByWeekday(schedule);
	const long = WEEKDAYS.filter((_, weekday) => minutes[weekday]! > 20 * 60);
	const average = minutes.reduce((sum, day) => sum + day, 0) / 7 / 60;
	const skips = [{ where: '', chance: schedule.skipDayChance }, ...Object.entries(schedule.days).map(([key, plan]) => ({ where: ` on ${key}`, chance: plan.skipDayChance ?? 0 }))];
	const spans = Object.values(schedule.days).flatMap((plan) => [...plan.online, ...plan.breaks]);
	return [
		...(isCityZone(timezone) ? [] : [`"${id}" has timezone "${timezone}": not a city's zone (an abbreviation or a fixed offset): use the city's own, e.g. America/New_York`]),
		...(long.length ? [`"${id}" is online over 20 hours a day on ${long.join(', ')}`] : []),
		...(average < 1 ? [`"${id}" is online about ${average.toFixed(1)} hours a day on average`] : []),
		...skips.filter(({ chance }) => chance > 0.5).map(({ where, chance }) => `"${id}" takes more than every other day off${where} (skipDayChance ${chance})`),
		...channels.filter((channel) => !spans.some((span) => isOn(span, channel))).map((channel) => `"${id}" is never online on ${channel}: its DMs there would wait forever`),
		...(providerSet(persona.settings) ? [] : [`"${id}" has no text provider (settings.llm.baseUrl): the app refuses to start without it; a dry run uses canned lines`]),
	];
}

/** "online 7:58 PM to 12:12 AM": a day's spans and busy blocks in order, and whether it is skipped. */
const agendaText = (agenda: DayAgenda, timeZone: string) => {
	const times = (block: { start: number; end: number }) => `${clockText(block.start, timeZone)} to ${clockText(block.end, timeZone)}`;
	const blocks = [
		...agenda.spans.map((span) => ({ start: span.start, text: `${span.kind} ${times(span)}${span.on ? ` (${span.on.join(', ')})` : ''}` })),
		...agenda.busy.map((busy) => ({ start: busy.start, text: `${busy.reason} ${times(busy)}` })),
	].sort((a, b) => a.start - b.start);
	return [...(agenda.skipped ? ['skipped'] : []), ...blocks.map((block) => block.text)].join(', ') || 'offline';
};

/** "thu": a date's token in schedule day keys. */
const dayKey = (date: LocalDate) => WEEKDAYS[weekdayOf(date)];

/** "UTC-5", "UTC+5:30" or "UTC": the zone's offset at `at`. */
const offsetText = (at: number, timeZone: string) => {
	const name = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
	// "GMT-05:00" or "GMT+05:30"; no offset is "GMT" or "GMT+00:00", depending on the Node version
	const [, sign, hours = '00', minutes = '00'] = /^GMT([+-])(\d\d):(\d\d)$/.exec(name ?? '') ?? [];
	if (hours === '00' && minutes === '00') return 'UTC';
	return `UTC${sign}${Number(hours)}${minutes === '00' ? '' : `:${minutes}`}`;
};

/** "online until 1:00 AM", "on a break until 12:45 PM", or when offline what comes next (within a week), on any channel. */
const nowText = (persona: PersonaConfig, now: number) => {
	const { timezone } = persona;
	const open = spanAt(persona, now);
	if (open) return `${open.kind === 'online' ? 'online' : 'on a break'} until ${clockText(open.end, timezone)}`;
	const next = nextSpan(persona, now);
	if (!next || next.start > now + 7 * DAY) return 'offline; nothing in the next week';
	return `offline; next: ${next.kind} ${dayKey(localDateOf(next.start, timezone))} ${clockText(next.start, timezone)} (${new Date(next.start).toISOString().slice(11, 16)} UTC)`;
};

const short = (value: unknown) => JSON.stringify(value) ?? 'undefined';

/**
 * A config check's lines on one persona, after the app's header line: prompt, now (`status` in place of what its hours
 * say, when the app gives one), today, tomorrow, overrides of `shared`, models, character and today's mood.
 */
export function personaReport(persona: PersonaConfig, { shared, now, status }: { shared: Settings; now: number; status?: string }): string[] {
	const today = localDateOf(now, persona.timezone);
	const tomorrow = addDays(today, 1);
	const overrides = diffPaths(shared, persona.settings);
	const { character } = persona;
	const provider = providerSet(persona.settings);
	return [
		`  prompt: ${persona.prompt} (${persona.promptText.length} characters)`,
		`  now: ${status ?? nowText(persona, now)}`,
		`  today (${dayKey(today)}, ${persona.timezone}, ${offsetText(now, persona.timezone)}): ${agendaText(agendaOn(persona, today), persona.timezone)}`,
		`  tomorrow (${dayKey(tomorrow)}): ${agendaText(agendaOn(persona, tomorrow), persona.timezone)}`,
		`  overrides:${overrides.length ? '' : ' none'}`,
		...overrides.map((at) => `    ${at}: ${short(valueAt(shared, at.split('.')))} → ${short(valueAt(persona.settings, at.split('.')))}`),
		`  models: ${Object.entries(persona.settings.models)
			.map(([task, model]) => `${task} ${(provider && (model.model ?? persona.settings.llm.model)) || '(canned)'}`)
			.join(', ')}`,
		`  character: ${character.facts.length} facts, ${character.interests.length} interests, ${character.boundaries.length} boundaries, ${character.moods.length} moods; today: ${moodOf(persona, now) ?? 'no mood'}`,
	];
}

/**
 * The system prompt of a sample DM turn on `channel`, with the app's `identity`, `style`, `policy` and `extraLines`: the brain's own
 * assembly, on a throwaway store, with a model that only records what it is sent. Offline at `now`, it is a minute into
 * its next span on `channel.id`, so the lines on its day show.
 */
export async function samplePrompt({
	persona,
	identity,
	style,
	channel,
	extraLines,
	now,
	policy,
}: {
	persona: PersonaConfig;
	/** As createBrain's. */
	identity?: string;
	/** As createBrain's. */
	style?: string;
	channel: Channel;
	extraLines?: (person: Person) => readonly string[];
	now: number;
	policy?: Policy;
}): Promise<string> {
	const seen: LlmMessage[][] = [];
	const capture: Llm = {
		async complete(messages) {
			seen.push(messages);
			return '{"reply": null}';
		},
	};
	const next = spanAt(persona, now, channel.id) ? null : nextSpan(persona, now, { channel: channel.id });
	const at = next ? next.start + MINUTE : now;
	const db = openDatabase(':memory:');
	try {
		const runtime = { store: createStore(db, () => at), now: () => at, rng: () => 0.5 };
		const brain = createBrain({ persona, identity, style, runtime, llm: capture, policy });
		const decision = brain.incoming(channel, 'sample', 'Sam', 'hey');
		if (decision.kind === 'reply') await brain.compose(decision.person.id, channel, { extraLines });
	} finally {
		db.close();
	}
	return seen[0]?.[0]?.content ?? '(none)';
}
