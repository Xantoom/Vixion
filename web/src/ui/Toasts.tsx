import { CircleAlert, CircleCheck } from 'lucide-react';
import { create } from 'zustand';

interface Toast {
	id: number;
	kind: 'ok' | 'error';
	text: string;
}

interface ToastState {
	toasts: Toast[];
	show: (kind: Toast['kind'], text: string) => void;
	dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
	toasts: [],
	show: (kind, text) => {
		const id = next++;
		set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
		setTimeout(
			() => {
				get().dismiss(id);
			},
			kind === 'error' ? 6000 : 3200,
		);
	},
	dismiss: (id) => {
		set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
	},
}));

export const toast = {
	ok: (text: string) => {
		useToasts.getState().show('ok', text);
	},
	error: (error: unknown) => {
		useToasts.getState().show('error', error instanceof Error ? error.message : String(error));
	},
};

/** Short messages at the bottom of the screen, read out by screen readers. */
export function Toasts() {
	const toasts = useToasts((state) => state.toasts);
	const dismiss = useToasts((state) => state.dismiss);
	return (
		<div
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4"
		>
			{toasts.map((item) => (
				<button
					type="button"
					key={item.id}
					onClick={() => {
						dismiss(item.id);
					}}
					className="menu-in bg-tip text-tip-ink text-ui pointer-events-auto flex max-w-md items-center gap-2.5 rounded-sm px-4 py-2.5 text-left shadow-xl"
					data-up="true"
				>
					{item.kind === 'ok' ? (
						<CircleCheck size={18} className="text-ok flex-none" />
					) : (
						<CircleAlert size={18} className="text-danger flex-none" />
					)}
					{item.text}
				</button>
			))}
		</div>
	);
}
