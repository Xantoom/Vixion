import { useT } from '@/i18n';

/** The design system's spinner, at a size in CSS pixels. Decorative: what it waits for says so in words. */
export function Spinner({ className = '', size = 16 }: { className?: string; size?: number }) {
	return (
		<span
			aria-hidden="true"
			className={`x-spinner ${className}`}
			style={{ '--_size': `${size / 16}rem` } as React.CSSProperties}
		/>
	);
}

/** Fills a page while it loads, after a beat: quick answers never flash it. */
export function PageLoading() {
	const t = useT();
	return (
		<div
			role="status"
			className="fade-in text-fg-faint grid min-h-[40vh] place-items-center [animation-delay:250ms]"
		>
			<Spinner size={22} />
			<span className="sr-only">{t.common.loading}</span>
		</div>
	);
}
