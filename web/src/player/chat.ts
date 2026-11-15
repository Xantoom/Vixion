import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChatLine, api } from '@/lib/api';

/** Lines shown at the playhead; scrolling up reveals more, a hundred at a time. */
export const SHOWN = 100;
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
	const url = `/streams/${streamId}/chat`;

	// A jump: anywhere the loaded lines do not cover.
	useEffect(() => {
		if (covers(loaded, timeMs)) return;
		// Already on its way for about this time (the clock moves on while it loads).
		const waiting = pending.current;
		if (waiting !== null && timeMs >= waiting - 1000 && timeMs <= waiting + 20_000) return;
		generation.current += 1;
		const run = generation.current;
		pending.current = timeMs;
		ahead.current = false;
		older.current = false;
		const at = Math.floor(timeMs) + 1;
		setFrozen(loaded ? shownAt.current : null);
		Promise.all([
			api.get<ChatLine[]>(`${url}?before=${at}&limit=${SHOWN}`),
			api.get<ChatLine[]>(`${url}?from=${at}&to=${at + AHEAD_MS}`),
		])
			.then(([past, next]) => {
				if (run !== generation.current) return;
				const atStart = past.length < SHOWN;
				setLoaded({
					from: atStart ? 0 : (past[0]?.o ?? at),
					to: at + AHEAD_MS,
					atStart,
					lines: [...past, ...next],
				});
				setAnchor(null);
				setFrozen(null);
				setEpoch(run);
			})
			.catch(() => undefined)
			.finally(() => {
				if (run === generation.current) pending.current = null;
			});
	}, [url, timeMs, loaded]);

	// Playing on: the next five minutes, before they are needed.
	useEffect(() => {
		if (!covers(loaded, timeMs) || ahead.current || loaded.to - timeMs > 90_000) return;
		ahead.current = true;
		const run = generation.current;
		const from = loaded.to;
		api.get<ChatLine[]>(`${url}?from=${from}&to=${from + AHEAD_MS}`)
			.then((next) => {
				if (run !== generation.current) return;
				setLoaded((current) => {
					if (current?.to !== from) return current;
					const lines = [...current.lines, ...next];
					if (lines.length <= KEPT) return { ...current, to: from + AHEAD_MS, lines };
					const kept = lines.slice(lines.length - KEPT);
					return { from: kept[0]?.o ?? from, to: from + AHEAD_MS, atStart: false, lines: kept };
				});
			})
			.catch(() => undefined)
			.finally(() => {
				if (run === generation.current) ahead.current = false;
			});
	}, [url, timeMs, loaded]);

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
		api.get<ChatLine[]>(`${url}?before=${before}&limit=${SHOWN * 2}`)
			.then((past) => {
				if (run !== generation.current) return;
				const atStart = past.length < SHOWN * 2;
				setLoaded((current) =>
					current
						? {
								...current,
								from: atStart ? 0 : (past[0]?.o ?? current.from),
								atStart,
								lines: [...past.filter((item) => item.o < before), ...current.lines],
							}
						: current,
				);
			})
			.catch(() => undefined)
			.finally(() => {
				if (run === generation.current) older.current = false;
			});
	}, [loaded, timeMs, anchor, url]);

	const pin = useCallback((from: ChatLine | null) => {
		setAnchor(from?.o ?? null);
	}, []);

	const at = frozen ?? timeMs;
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
