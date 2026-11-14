import { useState } from 'react';
import { useT } from '@/i18n';
import { toast } from '@/ui/Toasts';

/**
 * One action at a time, such as a form being sent: `busy` while it runs, and what went wrong,
 * kept in `error` to show in place, or shown as a toast. `explain` turns an error into words,
 * or into null when it was shown some other way.
 */
export function useAction(show: 'inline' | 'toast' = 'inline') {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async <T>(
		action: () => Promise<T>,
		explain?: (caught: unknown) => string | null | undefined,
	): Promise<T | undefined> => {
		setBusy(true);
		setError(null);
		try {
			return await action();
		} catch (caught) {
			if (show === 'toast') toast.error(caught);
			else {
				const said = explain?.(caught);
				setError(said === undefined ? (caught instanceof Error ? caught.message : t.common.error) : said);
			}
			return undefined;
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, setError, run };
}
