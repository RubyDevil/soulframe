import { describe, expect, it } from 'vitest';
import { isStopRequest, minorSignal, stripForeignLinks } from '../src/safety.js';

const HOSTS = ['forum.example'];

describe('isStopRequest', () => {
	it.each(['stop', 'STOP pls', 'leave me alone', "don't message me again", 'please stop messaging me', 'not interested'])('stops on "%s"', (text) => {
		expect(isStopRequest(text)).toBe(true);
	});
	it.each(["don't stop", 'i can never stop thinking about it', 'hey whats up'])('carries on with "%s"', (text) => {
		expect(isStopRequest(text)).toBe(false);
	});
});

describe('minorSignal', () => {
	it.each(["i'm 16", 'im only 15 lol', 'I am 17', '16 yo here', '15 years old', "i'm in high school", 'im underage', 'almost 18', 'in 10th grade', "i'm 16.", 'im 15, u?'])('flags "%s"', (text) => {
		expect(minorSignal(text)).toBe(true);
	});
	it.each(["i'm 5 minutes away", "i'm 6 feet tall", "I'm 25", 'im 34 and bored', 'back in high school I was shy', 'i am 9 inches', "i'm 5.5 miles out", "i'm 2,000 km away"])('lets "%s" through', (text) => {
		expect(minorSignal(text)).toBe(false);
	});
});

describe('stripForeignLinks', () => {
	it('removes foreign links and keeps Forum ones', () => {
		expect(stripForeignLinks('see https://evil.example/x and https://forum.example/groups', HOSTS)).toBe('see and https://forum.example/groups');
		expect(stripForeignLinks('www.other.example', HOSTS)).toBe('');
	});
});
