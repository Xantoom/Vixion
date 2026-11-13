import { useEffect, useState } from 'react';

/** The current time, updated every `every` milliseconds: for durations shown as they grow. */
export function useNow(every = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => {
			setNow(Date.now());
		}, every);
		return () => {
			clearInterval(timer);
		};
	}, [every]);
	return now;
}
