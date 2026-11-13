/**
 * Where each recording was left, kept in this browser: opening it again starts there, and its
 * card shows how far it was watched.
 */
const KEY = 'vixion.progress';
const KEPT = 300;

interface Entry {
	/** Seconds into the video. */
	at: number;
	/** Seconds the video lasts. */
	of: number;
	/** When it was saved, to forget the oldest first. */
	on: number;
}

function read(): Record<string, Entry> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
	} catch {
		return {};
	}
}

function write(entries: Record<string, Entry>) {
	try {
		localStorage.setItem(KEY, JSON.stringify(entries));
	} catch {
		// Storage full or blocked: the position just isn't remembered.
	}
}

export function saveProgress(id: number, at: number, of: number) {
	if (!(of > 0) || !Number.isFinite(at)) return;
	const entries = read();
	entries[id] = { at: Math.round(at), of: Math.round(of), on: Date.now() };
	const ids = Object.keys(entries);
	if (ids.length > KEPT) {
		ids.sort((a, b) => (entries[a]?.on ?? 0) - (entries[b]?.on ?? 0));
		for (const old of ids.slice(0, ids.length - KEPT)) delete entries[old];
	}
	write(entries);
}

/** Where to start: where it was left, unless that was the very start or the very end. */
export function resumeAt(id: number): number {
	const entry = read()[id];
	if (!entry || entry.at < 10 || entry.at > entry.of - 20) return 0;
	return entry.at;
}

/** How much was watched, from 0 to 1, or null when never opened. */
export function watched(id: number): number | null {
	const entry = read()[id];
	if (!entry || entry.of <= 0) return null;
	return Math.min(1, entry.at / entry.of);
}
