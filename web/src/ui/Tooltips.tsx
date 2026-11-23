import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Tip {
	text: string;
	/** A second, quieter line (`data-tip-sub`). */
	sub: string | undefined;
	/** A larger picture of what is hovered (`data-tip-img`): an emote, a badge. */
	img: string | undefined;
	/** A cover drawn larger (`data-tip-poster`): a game's box art. */
	poster: boolean;
	x: number;
	y: number;
	below: boolean;
	host: Element;
}

const DELAY_MS = 300;
const MARGIN = 8;
/** What does something when tapped: its tip stays for the mouse and the keyboard. */
const CONTROL =
	'a[href], button, input, select, textarea, label, [role=button], [role=switch], [role=slider], [role=tab]';

/**
 * One tooltip for the whole app: any element with `data-tip` shows its text when the mouse rests
 * on it or the keyboard focuses it. It is drawn inside the full-screen element when there is one,
 * so the player's buttons keep theirs in full screen. `data-tip-sub` adds a quieter second line,
 * `data-tip-img` a picture above the text and `data-tip-poster` a larger cover in its place.
 */
export function Tooltips() {
	const [tip, setTip] = useState<Tip | null>(null);
	const box = useRef<HTMLDivElement>(null);
	const [left, setLeft] = useState(0);

	useEffect(() => {
		let timer = 0;
		let current: HTMLElement | null = null;
		const show = (element: HTMLElement) => {
			const text = element.dataset.tip;
			if (!text || !element.isConnected) return;
			const rect = element.getBoundingClientRect();
			const below = rect.top < 56;
			setTip({
				text,
				sub: element.dataset.tipSub,
				img: element.dataset.tipPoster ?? element.dataset.tipImg,
				poster: element.dataset.tipPoster !== undefined,
				x: rect.left + rect.width / 2,
				y: below ? rect.bottom + MARGIN : rect.top - MARGIN,
				below,
				host: document.fullscreenElement ?? document.body,
			});
		};
		const hide = () => {
			window.clearTimeout(timer);
			current = null;
			setTip(null);
		};
		const onOver = (event: PointerEvent) => {
			if (event.pointerType !== 'mouse') return;
			const element = (event.target as Element | null)?.closest<HTMLElement>('[data-tip]') ?? null;
			if (element === current) return;
			hide();
			current = element;
			if (element)
				timer = window.setTimeout(() => {
					show(element);
				}, DELAY_MS);
		};
		// A finger can't rest on something: a tap on what only explains (an info icon, an emote, a
		// badge) shows its tip, a second tap or a tap elsewhere hides it.
		const onDown = (event: PointerEvent) => {
			const element =
				event.pointerType === 'mouse'
					? null
					: ((event.target as Element | null)?.closest<HTMLElement>('[data-tip]') ?? null);
			if (!element || element.closest(CONTROL)) {
				hide();
				return;
			}
			const again = element === current;
			hide();
			if (again) return;
			current = element;
			show(element);
		};
		// Only the focus leaving what shows the tip hides it: a tap moves the focus too.
		const onBlur = (event: FocusEvent) => {
			if (!current || current.contains(event.target as Node)) hide();
		};
		const onFocus = (event: FocusEvent) => {
			const element = (event.target as Element | null)?.closest<HTMLElement>('[data-tip]');
			if (element?.matches(':focus-visible')) show(element);
		};
		document.addEventListener('pointerover', onOver);
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('focusin', onFocus);
		document.addEventListener('focusout', onBlur);
		document.addEventListener('keydown', hide);
		window.addEventListener('scroll', hide, true);
		return () => {
			hide();
			document.removeEventListener('pointerover', onOver);
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('focusin', onFocus);
			document.removeEventListener('focusout', onBlur);
			document.removeEventListener('keydown', hide);
			window.removeEventListener('scroll', hide, true);
		};
	}, []);

	// In the top layer, shown after whatever is already there: above an open dialog too. Kept
	// inside the window: a tip by the edge slides in rather than being cut.
	const place = (x: number) => {
		if (!box.current) return;
		const width = box.current.offsetWidth;
		setLeft(Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, x - width / 2)));
	};
	useLayoutEffect(() => {
		if (!tip || !box.current) return;
		if (!box.current.matches(':popover-open')) box.current.showPopover();
		place(tip.x);
	}, [tip]);

	if (!tip) return null;
	return createPortal(
		<div
			ref={box}
			role="tooltip"
			popover="manual"
			className="tooltip-in bg-tip text-tip-ink text-small pointer-events-none fixed inset-auto m-0 max-w-72 overflow-visible rounded-xs border-0 px-2.5 py-1.5 font-medium shadow-lg"
			style={{ left, top: tip.y, transform: tip.below ? undefined : 'translateY(-100%)' }}
		>
			{tip.img ? (
				<img
					src={tip.img}
					alt=""
					referrerPolicy="no-referrer"
					// The picture can make the box wider: centred again once it has its size.
					onLoad={() => {
						place(tip.x);
					}}
					className={
						tip.poster
							? 'bg-surface-2 mx-auto mt-1 mb-1.5 block aspect-[3/4] h-40 w-auto rounded-xs object-cover'
							: 'mx-auto mb-1 block h-14 w-auto max-w-full object-contain'
					}
				/>
			) : null}
			<div className={tip.img ? 'text-center' : undefined}>{tip.text}</div>
			{tip.sub ? (
				<div className={`text-caption font-normal opacity-70 ${tip.img ? 'text-center' : ''}`}>{tip.sub}</div>
			) : null}
		</div>,
		tip.host,
	);
}
