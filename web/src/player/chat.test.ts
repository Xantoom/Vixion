import { describe, expect, test } from 'bun:test';
import type { ChatLine } from '@/lib/api';
import { heldAtStart, trim } from './chat';

const line = (o: number): ChatLine => ({ o, t: 0, k: 'm' });
const many = (count: number, o: (index: number) => number) => Array.from({ length: count }, (_, i) => line(o(i)));

describe('trim', () => {
	test('a busy chat ahead never pushes out the lines at the playhead', () => {
		// 100 lines up to the playhead (at 1 s), then 6 000 in the minutes after.
		const lines = [...many(100, (i) => i * 10), ...many(6000, (i) => 2000 + i * 10)];
		const kept = trim({ from: 0, to: 300_000, atStart: true, lines }, 0, 1000);
		expect(kept.lines.length).toBeLessThanOrEqual(5000);
		expect(kept.lines[0]?.o).toBe(0);
		expect(kept.from).toBe(0);
		// The far end goes, and `to` says where it stops so the next fetch brings it back.
		expect(kept.to).toBe(kept.lines.at(-1)!.o + 10);
		expect(kept.lines.every((item) => item.o < kept.to)).toBe(true);
	});

	test('the oldest go first, from a time, so what is kept stays whole', () => {
		const lines = many(6000, (i) => i * 10);
		const kept = trim({ from: 0, to: 60_000, atStart: true, lines }, 20_000, 59_000);
		expect(kept.from).toBe(20_000);
		expect(kept.atStart).toBe(false);
		expect(kept.lines[0]?.o).toBe(20_000);
		expect(kept.lines.length).toBe(4000);
	});

	test('under the limit nothing changes', () => {
		const loaded = { from: 0, to: 10, atStart: true, lines: many(10, (i) => i) };
		expect(trim(loaded, 5, 5)).toBe(loaded);
	});
});

test('heldAtStart counts the lines sharing the first time', () => {
	expect(heldAtStart([line(5), line(5), line(5), line(6)])).toBe(3);
	expect(heldAtStart([])).toBe(0);
});
