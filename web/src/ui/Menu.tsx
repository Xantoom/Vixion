import { Check } from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/** Closes the menu and puts the focus back on its button, so it isn't lost with the panel. */
const CloseContext = createContext<() => void>(() => {});

/** What the menu's button must carry, so it is announced as opening a menu, and whether it is open. */
export interface MenuTriggerProps {
	'aria-haspopup': 'menu';
	'aria-expanded': boolean;
	'aria-controls': string | undefined;
}

/** The gap kept between a menu and the screen's edges. */
const EDGE = 8;
/** The gap between the button and its menu. */
const GAP = 8;

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
	/** The button; it receives the open state and the attributes to spread on it. */
	trigger: (open: boolean, props: MenuTriggerProps) => ReactNode;
	children: ReactNode;
	align?: 'start' | 'end';
	label: string;
	className?: string;
	panelClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const [up, setUp] = useState(false);
	const [place, setPlace] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const id = useId();
	const close = () => {
		setOpen(false);
		root.current?.querySelector<HTMLElement>('[aria-haspopup=menu]')?.focus({ preventScroll: true });
	};

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				// Captured, so a dialog around the menu stays open.
				event.stopPropagation();
				event.preventDefault();
				close();
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
		const menu = panel.current;
		if (!open || !root.current || !menu) return;
		// In the top layer, the panel is clipped by no card or scrolling box, and shows over dialogs.
		if (!menu.matches(':popover-open')) menu.showPopover();
		const measure = () => {
			if (!root.current) return;
			const box = root.current.getBoundingClientRect();
			const height = menu.scrollHeight;
			const below = window.innerHeight - box.bottom - EDGE - GAP;
			const above = box.top - EDGE - GAP;
			const opensUp = height > below && above > below;
			const room = opensUp ? above : below;
			const shown = Math.min(height, Math.max(room, 120));
			const width = menu.offsetWidth;
			const wanted = align === 'end' ? box.right - width : box.left;
			setUp(opensUp);
			setPlace({
				top: opensUp ? box.top - GAP - shown : box.bottom + GAP,
				left: Math.max(EDGE, Math.min(wanted, window.innerWidth - EDGE - width)),
				maxHeight: height > room ? Math.max(room, 120) : undefined,
			});
		};
		measure();
		// The button moves with the page: the panel follows it.
		const onMove = (event: Event) => {
			if (event.target !== menu) measure();
		};
		window.addEventListener('scroll', onMove, true);
		window.addEventListener('resize', measure);
		return () => {
			window.removeEventListener('scroll', onMove, true);
			window.removeEventListener('resize', measure);
		};
	}, [open, align]);

	// The first item takes the focus once the panel is placed: hidden until then, it can't.
	const placed = place !== null;
	useLayoutEffect(() => {
		const menu = panel.current;
		if (!open || !placed || !menu || menu.contains(document.activeElement)) return;
		items(menu)[0]?.focus({ preventScroll: true });
	}, [open, placed]);

	const onKeyDown = (event: React.KeyboardEvent) => {
		const list = items(panel.current);
		if (list.length === 0) return;
		const index = list.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === 'ArrowDown') next = (index + 1) % list.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		else if (event.key === 'Tab') {
			// Tab leaves the menu, as from its button.
			setOpen(false);
			return;
		} else return;
		event.preventDefault();
		list[next]?.focus();
	};

	return (
		<div ref={root} className={`relative ${className}`}>
			<div
				onClick={() => {
					setOpen((value) => !value);
				}}
				className="contents"
			>
				{trigger(open, {
					'aria-haspopup': 'menu',
					'aria-expanded': open,
					'aria-controls': open ? id : undefined,
				})}
			</div>
			{open ? (
				<div
					ref={panel}
					id={id}
					role="menu"
					aria-label={label}
					popover="manual"
					data-up={up}
					onKeyDown={onKeyDown}
					style={{
						top: place?.top ?? 0,
						left: place?.left ?? 0,
						maxHeight: place?.maxHeight,
						visibility: place ? undefined : 'hidden',
					}}
					className={`menu-in bg-bg border-line text-ink fixed m-0 max-w-[calc(100vw-1rem)] min-w-56 overflow-y-auto overscroll-contain rounded-sm border p-1 shadow-xl [inset:auto] ${panelClassName}`}
				>
					<CloseContext.Provider value={close}>{children}</CloseContext.Provider>
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

/** Choices of which one is current (menuitemradio): a named group, so the set is announced. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label}>
			{children}
		</div>
	);
}

export function MenuDivider() {
	return <div className="bg-line mx-1 my-1 h-px" role="separator" />;
}
