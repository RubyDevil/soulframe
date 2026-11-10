/** soulframe's only public module: everything an application may use is exported here. */

// A persona: its config and its prompt, from wherever the app keeps them; optionally Markdown files, the config as frontmatter
export { parsePersona, parsePersonaMarkdown, loadPersonas, nodeFiles, PERSONA_ID, type ConfigFiles, type LoadedPersonas, type Persona, type PersonaConfig } from './config/personas.js';
export { ConfigError, describe, suggest, unknownKeys, unknownKeyIssues, addQuietIssue, shownValue, type Problems } from './config/issues.js';
// What a brain runs with (models, limits, pacing, the typed checks), and what the whole service shares (the text
// budget, the Decisions client); neither is part of a persona
export { parseSettings, parseServiceSettings, range, SECOND, MINUTE, HOUR, DAY, type Settings, type ServiceSettings } from './settings.js';
export { diffPaths, isPlainObject, valueAt } from './merge.js';
export { personaReport, personaWarnings, settingsWarnings, samplePrompt } from './report.js';

// Channels, as the app describes them to the brain
export type { Channel, ChannelAction, ChannelId } from './channel.js';

// The brain, its reply queue, hours
export { createBrain, type Brain, type Decision, type GroupChatLine, type PersonAction, type Policy } from './brain.js';
export { createReplyQueue, createRuntime, watchSpans, UnreachableError, type Conversation, type ReplyQueue, type Runtime } from './runtime.js';
// What the queue waits with, and a clock that skips the waits (a whole conversation in the time its model calls take)
export { createStepClock, systemTimers, type StepClock, type Timers } from './clock.js';
export { spanAt, fullyOnline, type Span } from './schedule.js';
export type { IncomingImage, IncomingMessage, LinkPreview, PreviewLink } from './perception.js';

// Memory: one SQLite file; the app opens it, and its own tables (and their migrations) live beside the package's
export { openDatabase, createStore, inTransaction, type Database, type Store, type Person, type PersonState } from './store.js';

// Text generation and the typed checks
export { llmsFor, createTokenMeter, createLimiter, createCannedLlm, modelKeys, type Llm, type LlmMessage } from './llm.js';
export { createConfiguredDecisions, DISABLED_DECISIONS, type Decisions } from './decisions.js';

// Small helpers the adapters share (never copied into the app)
export { between, sleep, pick, type Rng } from './rng.js';
export { typingMs } from './pacing.js';
export { minorSignal } from './safety.js';
