import { useSyncExternalStore } from 'react';

/**
 * The playhead, in seconds, outside React's state: it moves ten times a second while playing, and
 * only what shows it (the bar, the time, the chat) draws again; the rest of the player doesn't.
 */
export interface Clock {
	get: () => number;
	set: (seconds: number) => void;
	subscribe: (listener: () => void) => () => void;
}

export function createClock(): Clock {
	let time = 0;
	const listeners = new Set<() => void>();
	return {
		get: () => time,
		set: (seconds) => {
			if (seconds === time) return;
			time = seconds;
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** The playhead, read by a component: it draws again each time the clock moves, after `select`. */
export function useClock<T = number>(clock: Clock, select?: (seconds: number) => T): T {
	const read = () => (select ? select(clock.get()) : (clock.get() as T));
	return useSyncExternalStore(clock.subscribe, read, read);
}
