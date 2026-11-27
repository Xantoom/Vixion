// Toasts are the design system's: one region in the top layer (over a dialog or full screen too), read out to screen
// readers, held while the pointer or the focus is on one, closed by its button.
import { toast as show } from 'xantoom-design/js';
import { Toaster } from 'xantoom-design/react';
import { useT } from '@/i18n';

export const toast = {
	ok: (text: string) => {
		show(text, { tone: 'success', timeout: 3200 });
	},
	error: (error: unknown) => {
		show(error instanceof Error ? error.message : String(error), { tone: 'danger', timeout: 6000 });
	},
};

/** The region the toasts show in, once per page. */
export function Toasts() {
	const t = useT();
	return <Toaster label={t.common.notifications} closeLabel={t.common.close} />;
}
