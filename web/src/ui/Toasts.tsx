import { CircleAlert, CircleCheck } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { useT } from '@/i18n';

interface Toast {
	id: number;
	kind: 'ok' | 'error';
	text: string;
}

interface ToastState {
	toasts: Toast[];
	show: (kind: Toast['kind'], text: string) => void;
	dismiss: (id: number) => void;
	/** Holds or restarts the timers, while the pointer or the focus is on a toast. */
	hold: (held: boolean) => void;
}

const LIFETIME = { ok: 3200, error: 6000 };

let next = 1;
const timers = new Map<number, number>();
let held = false;
/** Toasts already read out by ariaNotify(): the live region leaves them out. */
const announced = new Set<number>();

/** `ariaNotify()`, which TypeScript's DOM types don't have yet. */
type Notifier = { ariaNotify?: (text: string) => void };

/**
 * Read out by a screen reader: from the open modal when there is one, since everything outside
 * it is inert. Browsers without ariaNotify() read the live region of the list instead.
 */
function announce(text: string): boolean {
	const modal = [...document.querySelectorAll('dialog:modal')].at(-1);
	const target = (modal ?? document) as Notifier;
	if (typeof target.ariaNotify !== 'function') return false;
	target.ariaNotify(text);
	return true;
}

export const useToasts = create<ToastState>((set, get) => {
	const arm = (toast: Toast) => {
		window.clearTimeout(timers.get(toast.id));
		timers.set(
			toast.id,
			window.setTimeout(() => {
				get().dismiss(toast.id);
			}, LIFETIME[toast.kind]),
		);
	};
	return {
		toasts: [],
		show: (kind, text) => {
			const toast = { id: next++, kind, text };
			const kept = get().toasts.slice(-3);
			for (const gone of get().toasts.slice(0, -3)) window.clearTimeout(timers.get(gone.id));
			// Decided before the list renders, so the live region knows to leave it out.
			if (announce(text)) announced.add(toast.id);
			set({ toasts: [...kept, toast] });
			if (!held) arm(toast);
		},
		dismiss: (id) => {
			window.clearTimeout(timers.get(id));
			timers.delete(id);
			announced.delete(id);
			set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
		},
		hold: (value) => {
			held = value;
			for (const toast of get().toasts) {
				if (value) window.clearTimeout(timers.get(toast.id));
				else arm(toast);
			}
		},
	};
});

export const toast = {
	ok: (text: string) => {
		useToasts.getState().show('ok', text);
	},
	error: (error: unknown) => {
		useToasts.getState().show('error', error instanceof Error ? error.message : String(error));
	},
};

/**
 * Short messages at the bottom of the screen. The list is a popover in the top layer, shown again
 * for each new message so it lands above an open dialog or full screen too. A message stays while
 * the pointer or the focus is on it; a click dismisses it.
 */
export function Toasts() {
	const t = useT();
	const toasts = useToasts((state) => state.toasts);
	const dismiss = useToasts((state) => state.dismiss);
	const hold = useToasts((state) => state.hold);
	const list = useRef<HTMLDivElement>(null);
	const latest = toasts.at(-1)?.id;

	useLayoutEffect(() => {
		const element = list.current;
		if (!element || latest === undefined) return;
		// Hidden then shown: the top layer stacks in the order things were shown.
		if (element.matches(':popover-open')) element.hidePopover();
		element.showPopover();
	}, [latest]);

	return (
		<div
			ref={list}
			popover="manual"
			role="region"
			aria-label={t.common.notifications}
			onPointerEnter={() => {
				hold(true);
			}}
			onPointerLeave={() => {
				hold(false);
			}}
			onFocus={() => {
				hold(true);
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) hold(false);
			}}
			className="pointer-events-none fixed inset-x-0 top-auto bottom-4 m-0 flex w-auto flex-col items-center gap-2 overflow-visible border-0 bg-transparent p-0 px-4 [&:not(:popover-open)]:hidden"
		>
			<div aria-live="polite" className="flex flex-col items-center gap-2">
				{toasts.map((item) => (
					<button
						type="button"
						key={item.id}
						aria-live={announced.has(item.id) ? 'off' : undefined}
						onClick={() => {
							dismiss(item.id);
						}}
						className="menu-in bg-tip text-tip-ink text-ui pointer-events-auto flex max-w-md items-center gap-2.5 rounded-sm px-4 py-2.5 text-left shadow-xl"
						data-up="true"
					>
						{item.kind === 'ok' ? (
							<CircleCheck size={18} className="text-on-dark-ok flex-none" aria-hidden />
						) : (
							<CircleAlert size={18} className="text-on-dark-danger flex-none" aria-hidden />
						)}
						{item.text}
					</button>
				))}
			</div>
		</div>
	);
}
