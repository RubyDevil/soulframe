import { afterEach, describe, expect, it, vi } from 'vitest';
import { clip, linksIn, mediaOf, readableChars, seenIn, siteOf, timeLimited, unseen } from '../src/perception.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const limits = DEFAULT_SETTINGS.perception;

describe('linksIn', () => {
	it('finds each URL once, without the punctuation around it', () => {
		expect(linksIn('look https://example.com/a. and (https://example.com/b), https://example.com/a!')).toEqual(['https://example.com/a', 'https://example.com/b']);
	});
	it('reads a bare www. address, and nothing in plain words', () => {
		expect(linksIn('see www.example.com/x')).toEqual(['https://www.example.com/x']);
		expect(linksIn('nothing to see here, just dot.com talk')).toEqual([]);
	});
});

describe('mediaOf', () => {
	it('is nothing for plain words', () => {
		expect(mediaOf({ text: 'hello' }, limits)).toBeUndefined();
	});
	it("merges the app's cards with the URLs in the text, the cards winning", () => {
		const media = mediaOf({ text: 'https://a.example/x and https://b.example/y', links: [{ url: 'https://a.example/x', title: 'A headline' }] }, limits);
		expect(media?.links).toEqual([{ url: 'https://a.example/x', title: 'A headline' }, { url: 'https://b.example/y' }]);
	});
	it('keeps to the limits per message and clips long cards', () => {
		const media = mediaOf(
			{
				text: '',
				images: Array.from({ length: 9 }, (_, i) => ({ url: `https://i.example/${i}.jpg` })),
				links: Array.from({ length: 9 }, (_, i) => ({ url: `https://l.example/${i}`, title: 'word '.repeat(60) })),
			},
			limits,
		);
		expect(media?.images).toHaveLength(limits.imagesPerMessage);
		expect(media?.links).toHaveLength(limits.linksPerMessage);
		expect(media?.links[0]?.title?.length).toBeLessThanOrEqual(120);
	});
	it('drops a card whose URL is not one', () => {
		expect(mediaOf({ text: '', links: [{ url: 'not a url', title: 'x' }] }, limits)).toBeUndefined();
	});
});

describe('unseen', () => {
	it('is true while a photo has its URL or a link has neither card nor look', () => {
		expect(unseen(undefined)).toBe(false);
		expect(unseen({ images: [{ url: 'u' }], links: [] })).toBe(true);
		expect(unseen({ images: [{ seen: 'a cat' }], links: [] })).toBe(false);
		expect(unseen({ images: [{ failed: true }], links: [] })).toBe(false);
		expect(unseen({ images: [], links: [{ url: 'u' }] })).toBe(true);
		expect(unseen({ images: [], links: [{ url: 'u', title: 't' }] })).toBe(false);
		expect(unseen({ images: [], links: [{ url: 'u', looked: true }] })).toBe(false);
	});
});

describe('readableChars', () => {
	it('is the length of plain words', () => {
		expect(readableChars({ text: 'hello there' })).toBe(11);
	});
	it("counts a URL as nothing and its card's words as reading", () => {
		const url = 'https://example.com/a/very/long/path/nobody/reads';
		expect(readableChars({ text: url })).toBe(0);
		expect(readableChars({ text: url, media: { images: [], links: [{ url, title: 'four', description: 'twelve chars' }] } })).toBe(16);
	});
});

describe('siteOf', () => {
	it("is the card's site, else the host without www.", () => {
		expect(siteOf({ url: 'https://www.example.com/x', site: 'Example News' })).toBe('Example News');
		expect(siteOf({ url: 'https://www.example.com/x' })).toBe('example.com');
	});
});

describe('seenIn', () => {
	it('reads the description, around any stray text', () => {
		expect(seenIn('{"seen": " a cat "}')).toBe('a cat');
		expect(seenIn('Sure! {"seen":"a cat"}')).toBe('a cat');
	});
	it('is null for a refusal, an empty answer or anything else', () => {
		for (const raw of ["I can't help with that.", '{"seen": ""}', '{"seen": null}', '{"seen": 3}', '{broken', '']) expect(seenIn(raw)).toBeNull();
	});
});

describe('clip', () => {
	it('leaves short text alone, and cuts long text at a word', () => {
		expect(clip('short', 10)).toBe('short');
		expect(clip('one two three four', 10)).toBe('one two…');
	});
});

describe('timeLimited', () => {
	afterEach(() => vi.useRealTimers());
	it('answers what the work answers', async () => {
		await expect(timeLimited(async () => 'done', 1000)).resolves.toBe('done');
	});
	it('rejects what throws, even before its first wait', async () => {
		await expect(
			timeLimited(() => {
				throw new Error('nope');
			}, 1000),
		).rejects.toThrow('nope');
	});
	it('rejects once the time is up', async () => {
		vi.useFakeTimers();
		const late = timeLimited(() => new Promise(() => undefined), 1000);
		const check = expect(late).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(1000);
		await check;
	});
});
