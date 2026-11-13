/**
 * Where each recording was left, kept in this browser for each account: opening it again starts
 * there, and its card shows how far it was watched.
 */
const LEGACY_KEY = 'vixion.progress';
const KEPT = 300;

let key = LEGACY_KEY;
/** Read once and kept: a page of cards asks for every one of them. */
let cache: { key: string; entries: Record<string, Entry> } | null = null;

/** Whose positions are read and written: the signed-in account. */
export function setProgressOwner(userId: number) {
	const next = `${LEGACY_KEY}.${userId}`;
	if (next === key) return;
	key = next;
	cache = null;
	try {
		// Positions saved before they were kept per account go to the first account to sign in.
		const legacy = localStorage.getItem(LEGACY_KEY);
		if (legacy !== null) {
			if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
			localStorage.removeItem(LEGACY_KEY);
		}
	} catch {
		// Storage blocked: positions just aren't remembered.
	}
}

interface Entry {
	/** Seconds into the video. */
	at: number;
	/** Seconds the video lasts. */
	of: number;
	/** When it was saved, to forget the oldest first. */
	on: number;
}

function read(): Record<string, Entry> {
	if (cache?.key === key) return cache.entries;
	let entries: Record<string, Entry> = {};
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
		if (parsed && typeof parsed === 'object') entries = parsed as Record<string, Entry>;
	} catch {
		// Unreadable: start over.
	}
	cache = { key, entries };
	return entries;
}

function write(entries: Record<string, Entry>) {
	cache = { key, entries };
	try {
		localStorage.setItem(key, JSON.stringify(entries));
	} catch {
		// Storage full or blocked: the position just isn't remembered.
	}
}

export function saveProgress(id: number, at: number, of: number) {
	if (!(of > 0) || !Number.isFinite(at)) return;
	const entries = { ...read() };
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
