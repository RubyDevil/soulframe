/** soulframe's only public module: everything an application may use is exported here. */

// The persona config: a folder's _shared.yaml and <id>.yaml (+ <id>.md)
export { loadPersonas, parsePersonas, nodeFiles, PERSONA_ID, type ConfigFiles, type LoadedPersonas, type PersonaConfig, type Chattiness } from './config/personas.js';
export { ConfigError, describe, suggest, unknownKeys, unknownKeyIssues, addQuietIssue, shownValue, type Problems } from './config/issues.js';
export { range, SECOND, MINUTE, HOUR, DAY, type Settings } from './settings.js';
export { diffPaths, isPlainObject, valueAt } from './merge.js';
export { personaReport, personaWarnings, samplePrompt } from './report.js';

// Channels, as the app describes them to the brain
export type { Channel, ChannelAction, ChannelId } from './channel.js';

// The brain, its reply queue, hours
export { createBrain, type Brain, type Decision, type GroupChatLine, type PersonAction, type Policy } from './brain.js';
export { createReplyQueue, createRuntime, watchSpans, UnreachableError, type Conversation, type ReplyQueue, type Runtime } from './runtime.js';
export { spanAt, fullyOnline, type Span } from './schedule.js';

// Memory: one SQLite file; the app opens it, and its own tables (and their migrations) live beside the package's
export { openDatabase, createStore, inTransaction, type Database, type Store, type Person, type PersonState } from './store.js';

// Text generation and the typed checks
export { llmsFor, createTokenMeter, createLimiter, createCannedLlm, modelKeys, type Llm, type LlmMessage } from './llm.js';
export { createConfiguredDecisions, DISABLED_DECISIONS, type Decisions } from './decisions.js';

// Small helpers the adapters share (never copied into the app)
export { between, sleep, pick, type Rng } from './rng.js';
export { typingMs } from './pacing.js';
export { minorSignal } from './safety.js';
