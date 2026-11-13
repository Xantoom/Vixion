import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Tip {
	text: string;
	x: number;
	y: number;
	below: boolean;
	host: Element;
}

const DELAY_MS = 300;
const MARGIN = 8;

/**
 * One tooltip for the whole app: any element with `data-tip` shows its text when the mouse rests
 * on it or the keyboard focuses it. It is drawn inside the full-screen element when there is one,
 * so the player's buttons keep theirs in full screen.
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
		const onFocus = (event: FocusEvent) => {
			const element = (event.target as Element | null)?.closest<HTMLElement>('[data-tip]');
			if (element?.matches(':focus-visible')) show(element);
		};
		document.addEventListener('pointerover', onOver);
		document.addEventListener('pointerdown', hide, true);
		document.addEventListener('focusin', onFocus);
		document.addEventListener('focusout', hide);
		document.addEventListener('keydown', hide);
		window.addEventListener('scroll', hide, true);
		return () => {
			hide();
			document.removeEventListener('pointerover', onOver);
			document.removeEventListener('pointerdown', hide, true);
			document.removeEventListener('focusin', onFocus);
			document.removeEventListener('focusout', hide);
			document.removeEventListener('keydown', hide);
			window.removeEventListener('scroll', hide, true);
		};
	}, []);

	// Kept inside the window: a tip by the edge slides in rather than being cut.
	useLayoutEffect(() => {
		if (!tip || !box.current) return;
		const width = box.current.offsetWidth;
		setLeft(Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, tip.x - width / 2)));
	}, [tip]);

	if (!tip) return null;
	return createPortal(
		<div
			ref={box}
			role="tooltip"
			className="tooltip-in bg-tip text-tip-ink text-small pointer-events-none fixed z-[200] max-w-72 rounded-xs px-2.5 py-1.5 font-medium shadow-lg"
			style={{ left, top: tip.y, transform: tip.below ? undefined : 'translateY(-100%)' }}
		>
			{tip.text}
		</div>,
		tip.host,
	);
}
