import { Check } from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const CloseContext = createContext<() => void>(() => {});

/** The gap kept between a menu and the screen's edges. */
const EDGE = 8;

/**
 * A button that opens a short list of actions or choices. The panel lines up with an edge of the
 * button and opens upward when there is no room below (a player's controls). It never leaves the
 * screen: by a side it slides back in, and when it is taller than the room it scrolls.
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
	const [place, setPlace] = useState<{ shift: number; maxHeight?: number }>({ shift: 0 });
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
		const height = panel.current.scrollHeight;
		const below = window.innerHeight - box.bottom - EDGE - 8;
		const above = box.top - EDGE - 8;
		const opensUp = height > below && above > below;
		setUp(opensUp);
		const room = opensUp ? above : below;
		// Where the panel would sit, and how far to slide it to stay on screen.
		const width = panel.current.offsetWidth;
		const left = align === 'end' ? box.right - width : box.left;
		const shift = Math.min(0, window.innerWidth - EDGE - (left + width)) + Math.max(0, EDGE - left);
		setPlace({ shift, maxHeight: height > room ? Math.max(room, 120) : undefined });
		items(panel.current)[0]?.focus({ preventScroll: true });
	}, [open, align]);

	const onKeyDown = (event: React.KeyboardEvent) => {
		const list = items(panel.current);
		const index = list.indexOf(document.activeElement as HTMLElement);
		const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
		if (step === 0 || list.length === 0) return;
		event.preventDefault();
		list[(index + step + list.length) % list.length]?.focus();
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
					style={{ translate: `${place.shift}px 0`, maxHeight: place.maxHeight }}
					className={`menu-in bg-bg border-line absolute z-50 max-w-[calc(100vw-1rem)] min-w-56 overflow-y-auto overscroll-contain rounded-sm border p-1 shadow-xl ${up ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'end' ? 'right-0' : 'left-0'} ${panelClassName}`}
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

/** The items the keyboard can reach: some only show on small screens. */
function items(panel: HTMLElement | null): HTMLElement[] {
	return [...(panel?.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)') ?? [])].filter((item) =>
		item.checkVisibility(),
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
