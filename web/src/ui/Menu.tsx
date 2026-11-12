import { Check } from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const CloseContext = createContext<() => void>(() => {});

/**
 * A button that opens a short list of actions or choices. The panel lines up with an edge of the
 * button and opens upward when there is no room below (a player's controls).
 */
export function Menu({
	trigger,
	children,
	align = 'end',
	label,
	className = '',
	panelClassName = '',
}: {
	/** The button's face; it receives the open state. */
	trigger: (open: boolean) => ReactNode;
	children: ReactNode;
	align?: 'start' | 'end';
	label: string;
	className?: string;
	panelClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const [up, setUp] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const id = useId();

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				setOpen(false);
				root.current?.querySelector('button')?.focus();
			}
		};
		document.addEventListener('pointerdown', onPointer);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onPointer);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open]);

	useLayoutEffect(() => {
		if (!open || !root.current || !panel.current) return;
		const box = root.current.getBoundingClientRect();
		const height = panel.current.offsetHeight;
		setUp(box.bottom + height + 8 > window.innerHeight && box.top - height - 8 > 0);
		panel.current.querySelector<HTMLElement>('[role^=menuitem]')?.focus({ preventScroll: true });
	}, [open]);

	const onKeyDown = (event: React.KeyboardEvent) => {
		const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)') ?? [])];
		const index = items.indexOf(document.activeElement as HTMLElement);
		const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
		if (step === 0 || items.length === 0) return;
		event.preventDefault();
		items[(index + step + items.length) % items.length]?.focus();
	};

	return (
		<div ref={root} className={`relative ${className}`}>
			<div
				onClick={() => {
					setOpen((value) => !value);
				}}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				className="contents"
			>
				{trigger(open)}
			</div>
			{open ? (
				<div
					ref={panel}
					id={id}
					role="menu"
					aria-label={label}
					data-up={up}
					onKeyDown={onKeyDown}
					className={`menu-in bg-bg border-line absolute z-50 min-w-56 rounded-sm border p-1 shadow-xl ${up ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'end' ? 'right-0' : 'left-0'} ${panelClassName}`}
				>
					<CloseContext.Provider
						value={() => {
							setOpen(false);
						}}
					>
						{children}
					</CloseContext.Provider>
				</div>
			) : null}
		</div>
	);
}

export function MenuItem({
	icon,
	children,
	onSelect,
	checked,
	danger = false,
	href,
	download,
	disabled,
}: {
	icon?: ReactNode;
	children: ReactNode;
	onSelect?: () => void;
	/** For a choice among several: shows a tick when current. */
	checked?: boolean;
	danger?: boolean;
	/** A link instead of an action (a download). */
	href?: string;
	download?: boolean;
	disabled?: boolean;
}) {
	const close = useContext(CloseContext);
	const className = `text-ui flex h-9 w-full items-center gap-2.5 rounded-xs px-2.5 text-left outline-none transition-colors duration-100 hover:bg-surface focus-visible:bg-surface disabled:opacity-40 ${danger ? 'text-danger' : 'text-ink'}`;
	const content = (
		<>
			<span className="text-muted grid w-4 flex-none place-items-center">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{checked ? <Check size={16} className="text-accent-text flex-none" /> : null}
		</>
	);
	if (href) {
		return (
			<a
				role="menuitem"
				href={href}
				download={download}
				tabIndex={-1}
				className={className}
				onClick={() => {
					close();
				}}
			>
				{content}
			</a>
		);
	}
	return (
		<button
			type="button"
			role={checked === undefined ? 'menuitem' : 'menuitemradio'}
			aria-checked={checked}
			tabIndex={-1}
			disabled={disabled}
			className={className}
			onClick={() => {
				close();
				onSelect?.();
			}}
		>
			{content}
		</button>
	);
}

export function MenuLabel({ children }: { children: ReactNode }) {
	return <div className="text-caption text-muted px-2.5 pt-2 pb-1 font-medium">{children}</div>;
}

export function MenuDivider() {
	return <div className="bg-line mx-1 my-1 h-px" role="separator" />;
}
