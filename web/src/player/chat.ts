import { useEffect, useRef, useState } from 'react';
import { type ChatLine, api } from '@/lib/api';

/** Chat is fetched five minutes at a time and kept around the playhead. */
const WINDOW_MS = 5 * 60_000;
/** Lines shown at once: older ones scroll away. */
export const SHOWN = 150;

interface Loaded {
	from: number;
	to: number;
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
 * The chat said up to the playhead, in video time. Fetches ahead as the video plays, starts over
 * after a jump, and asks again for the latest window while the stream is still being recorded.
 */
export function useChat(streamId: number, timeMs: number, recording: boolean): { lines: ChatLine[]; loading: boolean } {
	const [loaded, setLoaded] = useState<Loaded>({ from: 0, to: 0, lines: [] });
	const [loading, setLoading] = useState(true);
	const busy = useRef(false);
	const generation = useRef(0);

	// A new recording starts over.
	useEffect(() => {
		generation.current += 1;
		setLoaded({ from: 0, to: 0, lines: [] });
	}, [streamId]);

	useEffect(() => {
		if (busy.current) return;
		const inside = timeMs >= loaded.from && timeMs <= loaded.to;
		const nearEnd = inside && loaded.to - timeMs < 90_000;
		if (inside && !nearEnd && loaded.to > 0) return;
		const jump = !inside || loaded.to === 0;
		// After a jump, a little before the playhead too, so the panel isn't empty.
		const from = jump ? Math.max(0, timeMs - 60_000) : loaded.to;
		const to = from + WINDOW_MS;
		const run = generation.current;
		busy.current = true;
		if (jump) setLoading(true);
		api.get<ChatLine[]>(`/streams/${streamId}/chat?from=${Math.floor(from)}&to=${Math.ceil(to)}`)
			.then((lines) => {
				if (run !== generation.current) return;
				setLoaded((current) =>
					jump
						? { from, to, lines }
						: // Keep the last ten minutes before the new window: enough to scroll back a little.
							{
								from: Math.max(current.from, from - 2 * WINDOW_MS),
								to,
								lines: [
									...current.lines.filter((line) => line.o >= from - 2 * WINDOW_MS && line.o < from),
									...lines,
								],
							},
				);
			})
			.catch(() => {
				// Tried again on the next time update.
			})
			.finally(() => {
				busy.current = false;
				setLoading(false);
			});
	}, [streamId, timeMs, loaded]);

	// While recording, the window at the end fills up as people talk: ask for it again.
	useEffect(() => {
		if (!recording) return;
		const timer = setInterval(() => {
			setLoaded((current) =>
				current.to > 0 ? { ...current, to: Math.max(current.from, current.to - WINDOW_MS) } : current,
			);
		}, 20_000);
		return () => {
			clearInterval(timer);
		};
	}, [recording]);

	const end = lowerBound(loaded.lines, timeMs + 1);
	return { lines: loaded.lines.slice(Math.max(0, end - SHOWN), end), loading };
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
