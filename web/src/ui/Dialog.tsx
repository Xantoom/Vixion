import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Dialog as DsDialog } from 'xantoom-design/react';
import { useT } from '@/i18n';
import { Button } from './Button';

const FIRST_FIELD =
	':is(input:not([type=hidden]):not([readonly]):not([disabled]), select, textarea):not([tabindex="-1"])';

/**
 * A modal over the page: the design system's, on the native <dialog>. Escape and a click outside close it, focus
 * comes back where it was, and its content exists only while it is open.
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
	const t = useT();
	return (
		<DsDialog
			open={open}
			onClose={onClose}
			title={title}
			closeLabel={t.common.close}
			size={wide ? 'lg' : undefined}
			actions={footer}
		>
			<FirstFocus />
			{children}
		</DsDialog>
	);
}

/**
 * showModal() focuses the first control, the close button: a field is where to type, and a confirmation starts on
 * its safe choice (`data-autofocus`).
 */
function FirstFocus() {
	const mark = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const frame = requestAnimationFrame(() => {
			mark.current?.closest('dialog')?.querySelector<HTMLElement>(`[data-autofocus], ${FIRST_FIELD}`)?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
		};
	}, []);
	return <span ref={mark} hidden />;
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
			{children ? <div className="text-ui text-fg-muted">{children}</div> : null}
		</Dialog>
	);
}
