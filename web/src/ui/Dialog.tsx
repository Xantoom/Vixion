import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { Button, IconButton } from './Button';

const FIRST_FIELD =
	'[data-dialog-body] :is(input:not([type=hidden]):not([readonly]):not([disabled]), select, textarea):not([tabindex="-1"])';

/**
 * A modal over the page, on the native <dialog>: focus is trapped, Escape closes it and the page
 * behind can't be reached. Rendered only while open.
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
	const t = useT();

	useEffect(() => {
		const dialog = ref.current;
		if (!open || !dialog || dialog.open) return;
		dialog.showModal();
		// showModal() focuses the first control, the close button: the first field is where to type.
		dialog.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
	}, [open]);

	if (!open) return null;
	return (
		<dialog
			ref={ref}
			onClose={onClose}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				// A click on the backdrop (the dialog element itself, outside its box) closes it.
				if (event.target === ref.current) onClose();
			}}
			className={`bg-bg text-ink m-auto max-h-[min(90dvh,48rem)] w-[calc(100%-2rem)] overflow-hidden rounded-md p-0 shadow-2xl ring-1 ring-line ${wide ? 'max-w-2xl' : 'max-w-md'}`}
		>
			<div className="flex max-h-[inherit] flex-col">
				<header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
					<h2 className="text-title font-semibold tracking-tight">{title}</h2>
					<IconButton label={t.common.close} size="sm" onClick={onClose} className="-mt-1 -mr-2">
						<X size={18} />
					</IconButton>
				</header>
				<div data-dialog-body className="overflow-y-auto px-6 pt-1 pb-6">
					{children}
				</div>
				{footer ? (
					<footer className="border-line bg-surface flex flex-wrap justify-end gap-2 border-t px-6 py-4">
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
					<Button variant="ghost" onClick={onClose}>
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
			<div className="text-ui text-ink-2">{children}</div>
		</Dialog>
	);
}
