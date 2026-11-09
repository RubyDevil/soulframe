/**
 * The checks that never depend on the model: they run before and after every generated message.
 * - Always: "stop" ends the conversation for good.
 * - On an 18+ channel only (`Channel.adult`): any sign of someone under 18 ends it and deny-lists them.
 * - With the app's `Policy.allowedLinks` only: links to any other host are removed.
 * These checks stay authoritative: the optional typed checks (`decisions.ts`, `settings.decisions`) run
 * after them and can only add strictness, never relax them.
 */
export const STOP_ACK = "got it, I won't message you again. take care!";
export const MINOR_EXIT = "sorry, I only chat with adults, so I'm going to stop here. take care!";

const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

const STOP_START = /^(stop|unsubscribe|leave me alone|go away|no thanks|not interested|fuck off|piss off|bye forever)\b/;
const STOP_ANYWHERE = /\b(stop (messaging|texting|dming|dm'?ing|writing to) me|leave me alone|don'?t (message|text|dm|write to) me( again)?|never (message|text|dm) me)\b/;

export const isStopRequest = (text: string) => {
	const t = normalize(text);
	return STOP_START.test(t) || STOP_ANYWHERE.test(t);
};

// "i'm 16", "im only 15", "i'm 16.", but not "i'm 5.5" or "i'm 5 minutes away" or "i'm 6 feet"
const AGE_STATED = /\b(?:i'?m|i am|im|age|aged)\s+(?:only\s+|just\s+)?(1[0-7]|[1-9])(?![\d:'"%]|[.,]\d)(?!\s*(?:min|mins|minute|minutes|hours?|hrs?|h\b|inch|inches|in\b|cm|ft|feet|foot|days?|weeks?|months?|am\b|pm\b|k\b|times?|percent|mil|miles?|km|lbs?|kg|pounds?|kilos?|%))/;
const AGE_YEARS = /\b(1[0-7]|[1-9])\s*(?:yo|y\/o|y\.o\.?|yrs? old|years? old|year old)\b/;
const MINOR_WORDS = /\b(under ?age|under 18|not 18|not eighteen|almost 18|turning 18|i'?m a minor|im a minor|i am a minor|(?:i'?m|im|i am) (?:in|a) (?:high school|middle school|junior high)|(?:high|middle) schooler|in (?:[6-9]|1[0-2])(?:th)? grade)\b/;

/** Whether the text says or hints that its writer is under 18. Errs on the side of ending the chat. */
export const minorSignal = (text: string) => {
	const t = normalize(text);
	return AGE_STATED.test(t) || AGE_YEARS.test(t) || MINOR_WORDS.test(t);
};

export const LINK = /\bhttps?:\/\/[^\s<>()]+|\b(?:www\.)[^\s<>()]+/gi;

/** A URL's host without its `www.`. */
export const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

/** Removes every link whose host is not one of `allowedHosts`. */
export function stripForeignLinks(text: string, allowedHosts: readonly string[]): string {
	return text
		.replace(LINK, (url) => {
			try {
				const host = hostOf(url.startsWith('http') ? url : `https://${url}`);
				return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : '';
			} catch {
				return '';
			}
		})
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}
