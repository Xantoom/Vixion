import { X } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { Button, IconButton } from './Button';

const FIRST_FIELD =
	'[data-dialog-body] :is(input:not([type=hidden]):not([readonly]):not([disabled]), select, textarea):not([tabindex="-1"])';

/** Browsers that close a modal on a backdrop click by themselves (`closedby="any"`); Safari doesn't yet. */
const NATIVE_LIGHT_DISMISS = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

/**
 * A modal over the page, on the native <dialog>: focus is trapped, Escape and a click on the
 * backdrop close it and the page behind can't be reached. Rendered only while open; it is closed
 * with close() before it leaves the page, so the browser puts the focus back where it was.
 */
export function Dialog({
	open,
	onClose,
	title,
	children,
	footer,
	wide = false,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	wide?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const t = useT();

	// Still on the page for one render after `open` turns false: close() runs on it first, which
	// returns the focus to what opened the dialog. Removing an open dialog would drop it instead.
	const [shown, setShown] = useState(open);
	if (open && !shown) setShown(true);

	useLayoutEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
			// showModal() focuses the first control, the close button: a field is where to type, and
			// a confirmation starts on its safe choice.
			dialog.querySelector<HTMLElement>(`[data-autofocus], ${FIRST_FIELD}`)?.focus();
		} else if (!open) {
			if (dialog.open) dialog.close();
			// oxlint-disable-next-line react/set-state-in-effect -- after close() on the element, not before
			setShown(false);
		}
	}, [open, shown]);

	// When a parent removes the dialog while it is open: this runs before the element goes.
	const last = useRef<HTMLDialogElement | null>(null);
	useLayoutEffect(() => {
		last.current = ref.current;
	});
	useLayoutEffect(
		() => () => {
			if (last.current?.open) last.current.close();
		},
		[],
	);

	if (!open && !shown) return null;
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			closedby="any"
			onClose={onClose}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (NATIVE_LIGHT_DISMISS || event.target !== ref.current) return;
				// Without closedby: a click on the backdrop lands on the dialog element, outside its box.
				const box = ref.current.getBoundingClientRect();
				const inside =
					event.clientX >= box.left &&
					event.clientX <= box.right &&
					event.clientY >= box.top &&
					event.clientY <= box.bottom;
				if (!inside) onClose();
			}}
			className={`bg-bg text-ink m-auto max-h-[min(90dvh,48rem)] w-[calc(100%-2rem)] overflow-hidden rounded-md p-0 shadow-2xl ring-1 ring-line ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
		>
			<div className="flex max-h-[inherit] flex-col">
				<header className="flex items-start justify-between gap-4 px-6 pt-6 pb-5 sm:px-7">
					<h2 id={titleId} className="text-title font-semibold tracking-tight">
						{title}
					</h2>
					<IconButton label={t.common.close} size="sm" onClick={onClose} className="-mt-1 -mr-2">
						<X size={18} />
					</IconButton>
				</header>
				{/* A confirmation can be its title alone. */}
				{children ? (
					<div data-dialog-body className="overflow-y-auto px-6 pt-1 pb-7 sm:px-7">
						{children}
					</div>
				) : null}
				{footer ? (
					<footer className="border-line bg-surface flex flex-wrap justify-end gap-2 border-t px-6 py-4 sm:px-7">
						{footer}
					</footer>
				) : null}
			</div>
		</dialog>
	);
}

/** Asks before something that can't be undone. */
export function Confirm({
	open,
	onClose,
	title,
	children,
	confirm,
	onConfirm,
	danger = true,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	children?: ReactNode;
	confirm: string;
	onConfirm: () => Promise<unknown>;
	danger?: boolean;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onClose={onClose}
			title={title}
			footer={
				<>
					<Button variant="ghost" onClick={onClose} data-autofocus={danger || undefined}>
						{t.common.cancel}
					</Button>
					<Button
						variant={danger ? 'danger' : 'accent'}
						busy={busy}
						onClick={() => {
							setBusy(true);
							onConfirm()
								.then(onClose)
								.catch(() => undefined)
								.finally(() => {
									setBusy(false);
								});
						}}
					>
						{confirm}
					</Button>
				</>
			}
		>
			{children ? <div className="text-ui text-ink-2">{children}</div> : null}
		</Dialog>
	);
}
