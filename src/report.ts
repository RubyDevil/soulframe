/**
 * What an app's config check says of one persona and of the settings its brain runs with: their warnings, what is in
 * effect for it (what it is doing now, today's and tomorrow's agenda, its models, traits and today's mood), and the
 * system prompt of a sample DM turn, built by the brain itself. Nothing is started and nothing touches the network.
 */

import { createBrain, type Policy } from './brain.js';
import type { Channel, ChannelId } from './channel.js';
import type { Persona, PersonaConfig } from './config/personas.js';
import { providerSet, type Llm, type LlmMessage } from './llm.js';
import { moodOf } from './mood.js';
import { interruptionsOn } from './pacing.js';
import { clockText, traitsPrompt } from './prompts.js';
import { addDays, agendaOn, isOn, localDateOf, nextSpan, onlineMinutesByWeekday, spanAt, weekdayOf, WEEKDAYS, type DayAgenda, type LocalDate } from './schedule.js';
import { DAY, DEFAULT_SETTINGS, MINUTE, type Settings } from './settings.js';
import { createStore, openDatabase, type Person } from './store.js';

/** A city's zone follows its daylight saving; an abbreviation (EST) or a fixed offset (Etc/GMT+5) never does. UTC is meant as it is. */
const isCityZone = (timeZone: string) => timeZone === 'UTC' || (timeZone.includes('/') && !timeZone.startsWith('Etc/'));

/**
 * Warnings about a persona: a time zone that is no city's, a weekday over 20 hours online, under an hour a day on
 * average, more than every other day off, and one of its `channels` that no span ever includes.
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
	];
}

/** Warnings about the settings a brain runs with: a reply that may be written again more than once (`pacing.burst.maxRestarts`), and no text provider. */
export function settingsWarnings(settings: Settings): string[] {
	const { burst } = settings.pacing;
	return [
		...(burst.restartOnNewMessage && burst.maxRestarts > 1
			? [`pacing.burst.maxRestarts ${burst.maxRestarts}: each restart drops a draft already paid for, so one reply may cost up to ${burst.maxRestarts + 1} DM turns of tokens`]
			: []),
		...(providerSet(settings) ? [] : ['no text provider (llm.baseUrl): llmsFor refuses to make its model outside a dry run, which uses canned lines']),
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

/**
 * A config check's lines on one persona, after the app's header line, with the settings its brain runs with: its
 * prompt's length, the sentences its traits add (`traitsPrompt`: read them against the prompt), now (`status` in place
 * of what its hours say, when the app gives one), today, tomorrow, today's interruptions (`pacing.interruptions`), its
 * models and its moods with today's.
 */
export function personaReport(persona: Persona, { settings, now, status }: { settings: Settings; now: number; status?: string }): string[] {
	const today = localDateOf(now, persona.timezone);
	const tomorrow = addDays(today, 1);
	const provider = providerSet(settings);
	return [
		`  prompt: ${persona.prompt.length} characters`,
		`  traits: ${traitsPrompt(persona.traits) || 'none'}`,
		`  now: ${status ?? nowText(persona, now)}`,
		`  today (${dayKey(today)}, ${persona.timezone}, ${offsetText(now, persona.timezone)}): ${agendaText(agendaOn(persona, today), persona.timezone)}`,
		`  tomorrow (${dayKey(tomorrow)}): ${agendaText(agendaOn(persona, tomorrow), persona.timezone)}`,
		`  interruptions today: ${interruptionsOn(persona, today, settings.pacing).map((away) => `${clockText(away.start, persona.timezone)} to ${clockText(away.end, persona.timezone)}`).join(', ') || 'none'}`,
		`  models: ${Object.entries(settings.models)
			.filter(([task, model]) => task !== 'vision' || model.model)
			.map(([task, model]) => `${task} ${(provider && (model.model ?? settings.llm.model)) || '(canned)'}`)
			.join(', ')}`,
		`  moods: ${persona.moods.length}; today: ${moodOf(persona, now) ?? 'no mood'}`,
	];
}

/**
 * The system prompt of a sample DM turn on `channel`, with the app's `settings`, `identity`, `style`, `policy` and
 * `extraLines`: the brain's own assembly, on a throwaway store, with a model that only records what it is sent. Offline
 * at `now`, it is a minute into its next span on `channel.id`, so the lines on its day show.
 */
export async function samplePrompt({
	persona,
	settings = DEFAULT_SETTINGS,
	identity,
	style,
	channel,
	extraLines,
	now,
	policy,
}: {
	persona: Persona;
	/** As createBrain's. */
	settings?: Settings;
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
		const brain = createBrain({ persona, settings, identity, style, runtime, llm: capture, policy });
		const decision = brain.incoming(channel, 'sample', 'Sam', 'hey');
		if (decision.kind === 'reply') await brain.compose(decision.person.id, channel, { extraLines });
	} finally {
		db.close();
	}
	return seen[0]?.[0]?.content ?? '(none)';
}
