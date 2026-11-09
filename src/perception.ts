/**
 * What comes with a message besides its words. The persona knows what someone sees on their phone without tapping: a
 * photo, described once when it is looked at (the chat model only ever reads that description), and a link's preview
 * card, never the page behind it. The package fetches no URL a stranger sent: previews come from the app.
 */
import { hostOf, LINK } from './safety.js';
import type { Settings } from './settings.js';

/** A photo someone sent. */
export interface IncomingImage {
	/** Where the vision model finds it: an https URL it can reach, or a `data:` URI. */
	url: string;
	/** The platform's own description of it, if any: used when the photo can't be looked at. */
	alt?: string;
}

/** A link's preview card: what shows under a message without opening it. */
export interface LinkPreview {
	url: string;
	/** The site's name; its host when left out. */
	site?: string;
	title?: string;
	description?: string;
}

/** A message with what came with it (`brain.incoming`). URLs in `text` are found by the code: `links` gives the cards the app has for them. */
export interface IncomingMessage {
	/** Their words: empty for a photo sent alone. */
	text: string;
	images?: readonly IncomingImage[];
	links?: readonly LinkPreview[];
}

/** The app's way to get a link's card, called while the persona reads (`createBrain`'s `previewLink`); null for none. */
export type PreviewLink = (url: string) => Promise<LinkPreview | null>;

/** A stored photo: its `url` until it was looked at, then `seen` (the description) or `failed`. */
export interface SeenImage {
	url?: string;
	alt?: string;
	seen?: string;
	failed?: true;
}

/** A stored link: its card, `looked` once there was a try at getting one. */
export interface SeenLink extends LinkPreview {
	looked?: true;
}

/** What is stored with a message that had photos or links. */
export interface MessageMedia {
	images: SeenImage[];
	links: SeenLink[];
}

type Perception = Settings['perception'];

/** The most characters of a card's title and description that are kept. */
const TITLE_CHARS = 120;
const DESCRIPTION_CHARS = 200;

/** `text` cut to `max` characters at a word, an ellipsis ending it. */
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/** The URLs in `text`, once each, without the punctuation that ended the sentence around them. */
export function linksIn(text: string): string[] {
	const urls = [...text.matchAll(LINK)].map(([found]) => {
		const url = found.replace(/[.,!?;:'"\]}]+$/, '');
		return /^https?:/i.test(url) ? url : `https://${url}`;
	});
	return [...new Set(urls.filter((url) => URL.canParse(url)))];
}

/** The card with its long strings clipped, and nothing it doesn't have. */
const clippedCard = ({ url, site, title, description }: LinkPreview): LinkPreview => ({
	url,
	...(site && { site: clip(site, TITLE_CHARS) }),
	...(title && { title: clip(title, TITLE_CHARS) }),
	...(description && { description: clip(description, DESCRIPTION_CHARS) }),
});

/** A card as it is stored, once its provider answered. */
export const lookedCard = (card: LinkPreview): SeenLink => ({ ...clippedCard(card), looked: true });

/** What to store with a message: its photos and links up to the limits, the cards the app gave first; undefined with neither. */
export function mediaOf({ text, images = [], links = [] }: IncomingMessage, { imagesPerMessage, linksPerMessage }: Perception): MessageMedia | undefined {
	const cards = new Map(links.filter(({ url }) => URL.canParse(url)).map((card) => [card.url, card]));
	for (const url of linksIn(text)) if (!cards.has(url)) cards.set(url, { url });
	const seen = { images: images.slice(0, imagesPerMessage).map(({ url, alt }) => ({ url, ...(alt && { alt }) })), links: [...cards.values()].slice(0, linksPerMessage).map(clippedCard) };
	return seen.images.length || seen.links.length ? seen : undefined;
}

/** Whether a photo or link of this message is still to be looked at. */
export const unseen = (media: MessageMedia | undefined) => !!media && (media.images.some((image) => image.url !== undefined) || media.links.some((link) => !link.looked && !link.title));

/** The name a link goes by: its card's site, else its host. */
export const siteOf = ({ site, url }: LinkPreview) => site ?? hostOf(url);

/** How many characters of a message there are to read: a URL counts as nothing, the words on its card as reading. */
export const readableChars = ({ text, media }: { text: string; media?: MessageMedia }) =>
	text.replace(LINK, '').length + (media?.links ?? []).reduce((sum, { title = '', description = '' }) => sum + title.length + description.length, 0);

/** The description in a vision model's answer; null for anything else, a refusal included. */
export function seenIn(raw: string): string | null {
	try {
		const { seen } = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { seen?: unknown };
		return typeof seen === 'string' && seen.trim() ? seen.trim() : null;
	} catch {
		return null;
	}
}

/** What `work` answers, rejected once `ms` have gone by: looking at something never holds a reply up for long. */
export const timeLimited = <T>(work: () => Promise<T>, ms: number) =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timed out')), ms);
		Promise.resolve()
			.then(work)
			.then(resolve, reject)
			.finally(() => clearTimeout(timer));
	});
