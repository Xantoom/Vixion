import { useT } from '@/i18n';

export function Spinner({ className = '', size = 16 }: { className?: string; size?: number }) {
	return (
		<svg
			className={`animate-spin ${className}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
			<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
		</svg>
	);
}

/** Fills a page while it loads, after a beat: quick answers never flash it. */
export function PageLoading() {
	const t = useT();
	return (
		<div role="status" className="fade-in text-muted grid min-h-[40vh] place-items-center [animation-delay:250ms]">
			<Spinner size={22} />
			<span className="sr-only">{t.common.loading}</span>
		</div>
	);
}
