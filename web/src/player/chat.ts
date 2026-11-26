import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChatLine, api } from '@/lib/api';

/** Lines shown at the playhead; scrolling up reveals more, a hundred at a time. */
const SHOWN = 100;
/** Chat is fetched five minutes ahead of the playhead as the video plays. */
const AHEAD_MS = 5 * 60_000;
/** Lines kept in memory at most: the oldest go first. Older ones come back from the server when scrolled to. */
const KEPT = 5_000;

interface Loaded {
	/** Video time the loaded lines start from; everything after it up to `to` is there. */
	from: number;
	to: number;
	/** The first line of the chat is loaded: there is nothing older. */
	atStart: boolean;
	lines: ChatLine[];
}

/** First index of a line at or after `ms`. */
function lowerBound(lines: ChatLine[], ms: number): number {
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((lines[mid]?.o ?? 0) < ms) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * Keeps at most `KEPT` lines: those from `fromMs` on (all of them, so `from` stays true), and
 * past that, cuts the far end at a change of time (so `to` stays true and the next fetch from it
 * brings back exactly what was cut), never at or before `atMs`, which must stay covered.
 */
export function trim(loaded: Loaded, fromMs: number, atMs: number): Loaded {
	if (loaded.lines.length <= KEPT) return loaded;
	let { lines, from, atStart } = loaded;
	let to = loaded.to;
	const first = lowerBound(lines, fromMs);
	if (first > 0) {
		lines = lines.slice(first);
		from = fromMs;
		atStart = false;
	}
	if (lines.length > KEPT) {
		const cutAt = Math.max(lines[KEPT]?.o ?? to, atMs + 1);
		const end = lowerBound(lines, cutAt);
		if (end > 0 && end < lines.length) {
			lines = lines.slice(0, end);
			to = cutAt;
		}
	}
	return { from, to, atStart, lines };
}

/** How many of the first lines share the first one's time: the server leaves those out of `before`. */
export function heldAtStart(lines: ChatLine[]): number {
	const first = lines[0]?.o;
	let held = 0;
	while (held < lines.length && lines[held]?.o === first) held += 1;
	return held;
}

/** Waits after failed fetches: 2 s, 4 s… up to half a minute. */
const backoff = (failures: number) => Math.min(30_000, 1000 * 2 ** failures);

const covers = (loaded: Loaded | null, ms: number): loaded is Loaded =>
	loaded !== null && ms >= loaded.from && ms <= loaded.to;

export interface Chat {
	/** The lines to show, oldest first. */
	lines: ChatLine[];
	loading: boolean;
	/** Changes after each jump: the panel goes back to following the playhead. */
	epoch: number;
	/** Keeps the shown lines starting at this one while the reader scrolls back; null follows the playhead. */
	pin: (from: ChatLine | null) => void;
	/** Shows the hundred lines before the first shown, fetching them when needed. */
	showOlder: () => void;
}

/**
 * The chat said up to the playhead, in video time. After a jump it asks for the last lines before
 * the new time and the next five minutes together, and keeps showing the previous lines until
 * they arrive; answers to a jump that was overtaken by another are dropped.
 */
export function useChat(streamId: number, timeMs: number): Chat {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [anchor, setAnchor] = useState<number | null>(null);
	const [epoch, setEpoch] = useState(0);
	const generation = useRef(0);
	const pending = useRef<number | null>(null);
	const ahead = useRef(false);
	const older = useRef(false);
	// While a jump loads, the panel keeps showing the chat at the last time it had.
	const shownAt = useRef(0);
	const [frozen, setFrozen] = useState<number | null>(null);
	// After a failure, fetches wait a while, then `retry` runs the effects again (even paused).
	const failures = useRef(0);
	const blockedUntil = useRef(0);
	const [retry, setRetry] = useState(0);
	const failed = useCallback(() => {
		failures.current += 1;
		const wait = backoff(failures.current);
		blockedUntil.current = Date.now() + wait;
		window.setTimeout(() => {
			setRetry((count) => count + 1);
		}, wait);
	}, []);
	const url = `/streams/${streamId}/chat`;

	// A jump: anywhere the loaded lines do not cover.
	useEffect(() => {
		if (covers(loaded, timeMs) || Date.now() < blockedUntil.current) return;
		// Already on its way for about this time (the clock moves on while it loads).
		const waiting = pending.current;
		if (waiting !== null && timeMs >= waiting - 1000 && timeMs <= waiting + 20_000) return;
		generation.current += 1;
		const run = generation.current;
		pending.current = timeMs;
		older.current = false;
		const at = Math.floor(timeMs) + 1;
		setFrozen(loaded ? shownAt.current : null);
		// The lines before the new time are all the panel needs to show it: they go up as soon as
		// they come, without waiting for the five minutes ahead, which can be thousands of lines.
		ahead.current = true;
		// Whichever comes second joins the first: the five minutes ahead wait for the lines before.
		let waitingAhead: ChatLine[] | null = null;
		let pastShown = false;
		const past = api.get<ChatLine[]>(`${url}?before=${at}&limit=${SHOWN}`).then((lines) => {
			if (run !== generation.current) return;
			failures.current = 0;
			const atStart = lines.length < SHOWN;
			const start = atStart ? 0 : (lines[0]?.o ?? at);
			const next = waitingAhead;
			setLoaded(
				trim(
					{ from: start, to: next ? at + AHEAD_MS : at, atStart, lines: next ? [...lines, ...next] : lines },
					start,
					at,
				),
			);
			pastShown = true;
			setAnchor(null);
			setFrozen(null);
			setEpoch(run);
		});
		const next = api.get<ChatLine[]>(`${url}?from=${at}&to=${at + AHEAD_MS}`).then((lines) => {
			if (run !== generation.current) return;
			if (!pastShown) {
				waitingAhead = lines;
				return;
			}
			setLoaded((current) =>
				current?.to === at
					? trim({ ...current, to: at + AHEAD_MS, lines: [...current.lines, ...lines] }, current.from, at)
					: current,
			);
		});
		Promise.all([past, next])
			.catch(() => {
				if (run === generation.current) failed();
			})
			.finally(() => {
				if (run === generation.current) {
					pending.current = null;
					ahead.current = false;
				}
			});
	}, [url, timeMs, loaded, retry, failed]);

	// Playing on: the next five minutes, before they are needed.
	useEffect(() => {
		if (!covers(loaded, timeMs) || ahead.current || loaded.to - timeMs > 90_000) return;
		if (Date.now() < blockedUntil.current) return;
		ahead.current = true;
		const run = generation.current;
		const from = loaded.to;
		api.get<ChatLine[]>(`${url}?from=${from}&to=${from + AHEAD_MS}`)
			.then((next) => {
				if (run !== generation.current) return;
				failures.current = 0;
				setLoaded((current) => {
					if (current?.to !== from) return current;
					const lines = [...current.lines, ...next];
					// The oldest go first, but never the lines shown at the playhead: on a busy chat the
					// five minutes ahead alone can be more than is kept, and are cut instead.
					const shownFrom = lines[Math.max(0, lowerBound(lines, timeMs + 1) - SHOWN)]?.o ?? current.from;
					return trim({ ...current, to: from + AHEAD_MS, lines }, shownFrom, timeMs);
				});
			})
			.catch(() => {
				if (run === generation.current) failed();
			})
			.finally(() => {
				if (run === generation.current) ahead.current = false;
			});
	}, [url, timeMs, loaded, retry, failed]);

	const showOlder = useCallback(() => {
		if (!loaded) return;
		const end = lowerBound(loaded.lines, timeMs + 1);
		const start = anchor === null ? Math.max(0, end - SHOWN) : lowerBound(loaded.lines, anchor);
		const next = Math.max(0, start - SHOWN);
		const line = loaded.lines[next];
		if (line && next < start) setAnchor(line.o);
		if (next >= SHOWN || loaded.atStart || older.current) return;
		// Running short: the lines before the loaded ones.
		older.current = true;
		const run = generation.current;
		const before = loaded.lines[0]?.o ?? loaded.from;
		// Lines said at the same time as the first held one (all those said during a cut ad) come
		// back too, except those already held.
		const held = loaded.lines[0] ? heldAtStart(loaded.lines) : 0;
		api.get<ChatLine[]>(`${url}?before=${before}&held=${held}&limit=${SHOWN * 2}`)
			.then((past) => {
				if (run !== generation.current) return;
				const atStart = past.length < SHOWN * 2;
				setLoaded((current) => {
					if (!current || current.lines[0]?.o !== before) return current;
					const from = atStart ? 0 : (past[0]?.o ?? current.from);
					// Reading back keeps the older lines: what goes is the far end, past the playhead.
					return trim({ ...current, from, atStart, lines: [...past, ...current.lines] }, from, timeMs);
				});
			})
			.catch(() => undefined)
			.finally(() => {
				if (run === generation.current) older.current = false;
			});
	}, [loaded, timeMs, anchor, url]);

	const pin = useCallback((from: ChatLine | null) => {
		setAnchor(from?.o ?? null);
	}, []);

	// Just past the loaded lines, the next ones on their way: the last ones stay rather than none.
	const wanted = frozen ?? timeMs;
	const at = loaded && wanted > loaded.to && wanted - loaded.to < 20_000 ? loaded.to : wanted;
	let start = 0;
	let end = 0;
	if (covers(loaded, at)) {
		end = lowerBound(loaded.lines, at + 1);
		start =
			anchor === null
				? Math.max(0, end - SHOWN)
				: Math.min(lowerBound(loaded.lines, anchor), Math.max(0, end - SHOWN));
	}
	// The same lines keep the same array between clock ticks, so the panel only redraws on change.
	const source = loaded?.lines;
	const lines = useMemo(() => source?.slice(start, end) ?? [], [source, start, end]);
	useEffect(() => {
		if (frozen === null && covers(loaded, timeMs)) shownAt.current = timeMs;
	});
	return { lines, loading: loaded === null || frozen !== null, epoch, pin, showOlder };
}

/** Part of a message: text, or a Twitch emote. */
export type Fragment = { text: string } | { emote: string; name: string };

/** Splits a message on its emotes (`25:0-4,12-16/1902:6-10`, positions in code points). */
export function fragments(message: string, emotes: string | undefined): Fragment[] {
	if (!emotes) return [{ text: message }];
	const chars = Array.from(message);
	const places: { start: number; end: number; id: string }[] = [];
	for (const entry of emotes.split('/')) {
		const [id, ranges] = entry.split(':');
		if (!id || !ranges) continue;
		for (const range of ranges.split(',')) {
			const [start, end] = range.split('-').map(Number);
			if (start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end))
				places.push({ start, end, id });
		}
	}
	places.sort((a, b) => a.start - b.start);
	const out: Fragment[] = [];
	let at = 0;
	for (const place of places) {
		if (place.start < at || place.end >= chars.length) continue;
		if (place.start > at) out.push({ text: chars.slice(at, place.start).join('') });
		out.push({ emote: place.id, name: chars.slice(place.start, place.end + 1).join('') });
		at = place.end + 1;
	}
	if (at < chars.length) out.push({ text: chars.slice(at).join('') });
	return out;
}

/** Twitch's colour for names without one, picked from the name so it stays the same. */
const DEFAULT_COLORS = [
	'#FF0000',
	'#0000FF',
	'#008000',
	'#B22222',
	'#FF7F50',
	'#9ACD32',
	'#FF4500',
	'#2E8B57',
	'#DAA520',
	'#D2691E',
	'#5F9EA0',
	'#1E90FF',
	'#FF69B4',
	'#8A2BE2',
	'#00FF7F',
];

export function nameColor(line: ChatLine): string {
	if (line.c) return line.c;
	const name = line.u ?? line.n ?? '';
	let hash = 0;
	for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
	return DEFAULT_COLORS[Math.abs(hash) % DEFAULT_COLORS.length] ?? '#8A2BE2';
}
