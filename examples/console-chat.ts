/**
 * soulframe in one file: a persona defined inline, an in-memory store, the canned model and a console "channel".
 * No network, no API key, no file is read or written. From a clone of this repository, after `npm install`:
 *
 *   npx tsx examples/console-chat.ts
 */
import { fileURLToPath } from 'node:url';
import {
	createBrain,
	createCannedLlm,
	createReplyQueue,
	createRuntime,
	createStore,
	openDatabase,
	parsePersona,
	parseSettings,
	sleep,
	type Channel,
	type Conversation,
	type Runtime,
} from 'soulframe';

// A fixed clock (Thursday 15 January 2026, 20:00 UTC, inside the persona's hours below) and a fixed source of
// numbers: the run is the same every time. A real service passes Date.now and Math.random (the defaults).
const NOW = Date.UTC(2026, 0, 15, 20, 0);
const now = () => NOW;
const rng = () => 0.5;

// 1. The persona: its config (what the code computes with) and its prompt (who it is, in prose). A robin.md file would
//    hold the same, the config as YAML frontmatter and the prompt after it (loadPersonas reads a folder of them);
//    parsePersona takes them from anywhere, as here.
const parsed = parsePersona({
	config: {
		id: 'robin',
		name: 'Robin',
		timezone: 'UTC',
		schedule: { days: { 'mon-sun': { online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }] } } },
		moods: ['cheerful', { mood: 'a little sleepy', weight: 0.5 }],
	},
	prompt: 'You are Robin, 29, living in a small coastal town: warm and curious, into board games, baking and indie music. You write in lowercase and are always up for a good story.',
	// The channels it is on: the names its hours' `on:` may use
	channels: ['console'],
});
if (!parsed.persona) throw new Error(parsed.issues.join('\n'));
const { persona } = parsed;

// 2. What its brain runs with: models, limits, pacing. Human pacing (seconds to minutes before a reply), made instant
//    for the demo; everything left out keeps its default
const read = parseSettings({
	pacing: {
		glance: { delaySeconds: [0, 0] },
		watching: { delaySeconds: [0, 0] },
		interruptions: { meanMinutes: 0 },
		readingDurationSeconds: [0, 0],
		typingDurationSeconds: [0, 0],
		betweenReplyMessagesSeconds: [0, 0],
		burst: { settleSeconds: [0, 0] },
	},
});
if (!read.settings) throw new Error(read.issues.join('\n'));
const { settings } = read;

// 3. Memory: one SQLite database, here in memory and gone at the end
const db = openDatabase(':memory:');
const store = createStore(db, now);

// 4. The runtime: the clock, randomness and store the brain and its reply queue share. The halt file is never created
//    here; the log only shows a few events.
const waiting = new Map<string, () => void>();
const nextEvent = (event: string) => new Promise<void>((resolve) => waiting.set(event, resolve));
const runtime: Runtime = {
	...createRuntime({ store, dryRun: false, haltFile: fileURLToPath(new URL('./HALT', import.meta.url)), rng, now }),
	log(_persona, event) {
		if (event === 'reply_scheduled' || event === 'reply_sent') console.log(`  [${event.replace('_', ' ')}]`);
		waiting.get(event)?.();
		waiting.delete(event);
	},
};

// 5. The brain, with its settings, on that runtime, with the canned model (no provider): it answers one of a few fixed
//    lines. `identity` is the app's phrase after the persona's name in its identity line ("You are Robin, a character in
//    a demo, chatting by text in …"). Then its reply queue, on the same runtime: it reads the persona and the settings
//    from the brain.
const brain = createBrain({ persona, settings, identity: 'a character in a demo', runtime, llm: createCannedLlm(rng) });
const queue = createReplyQueue({ brain, runtime, act: async (personId, action) => console.log(`  [${action} person ${personId}]`) });

// 6. The channel: where the conversation happens, as the brain is told, and how a message goes out. `adult: true`
//    marks it 18+, which turns on soulframe's one built-in safeguard, avoiding minors (left out, it is off)
const terminal: Channel = { id: 'console', where: 'a terminal chat demo', maxLength: 500, adult: true };
const conversationWith = (name: string): Conversation => ({
	channel: terminal,
	async typing(on) {
		if (on) console.log('  (Robin is typing...)');
	},
	async send(text) {
		console.log(`Robin -> ${name}: ${text}`);
	},
});

/** One message in: the brain decides at once, the queue answers at its pace. */
async function receive(externalId: string, name: string, text: string) {
	console.log(`${name}: ${text}`);
	const decision = brain.incoming(terminal, externalId, name, text);
	console.log(`  [decision: ${decision.kind}${decision.kind === 'ignore' ? ` (${decision.reason})` : ''}]`);
	const sent = nextEvent('reply_sent');
	await queue.handle(decision, conversationWith(name), text);
	if (decision.kind === 'reply') await sent;
	// The queue records the turn once delivered: give it a moment before reading the store
	await sleep(20);
}

await receive('sam', 'Sam', 'hey robin! how is your evening going?');
const sam = store.person(persona.id, terminal.id, 'sam')!;
console.log(`  [memory: ${sam.name} is person ${sam.id}, ${sam.incoming} message in, ${store.history(sam.id).length} in the history]`);

// On an 18+ channel the code checks each message before the model: a sign of someone under 18 ends the chat and
// deny-lists the account (the goodbye goes out after a short pause of 2 to 10 seconds, whatever the pacing)
await receive('alex', 'Alex', "hi, i'm 16 btw");
console.log(`  [deny list: alex ${store.isDenied(terminal.id, 'alex') ? 'is' : 'is not'} denied]`);
await receive('alex', 'Alex', 'hello?');

queue.stop();
db.close();
