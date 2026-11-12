import { useId } from 'react';
import type { Locale } from '@/i18n';

/**
 * A language's flag, drawn rather than an emoji: Windows shows flag emojis as two letters.
 * Round, so the two flags weigh the same beside each other.
 */
export function Flag({ locale, size = 20 }: { locale: Locale; size?: number }) {
	const id = useId();
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 30 30"
			aria-hidden="true"
			className="flex-none rounded-full shadow-[0_0_0_1px_rgb(0_0_0/0.12)]"
		>
			<clipPath id={`${id}c`}>
				<circle cx="15" cy="15" r="15" />
			</clipPath>
			<g clipPath={`url(#${id}c)`}>
				{locale === 'fr' ? (
					<>
						<rect width="10" height="30" fill="#002654" />
						<rect x="10" width="10" height="30" fill="#ffffff" />
						<rect x="20" width="10" height="30" fill="#ce1126" />
					</>
				) : (
					// The Union Jack, centred on its crossing.
					<g transform="translate(-15 0)">
						<rect width="60" height="30" fill="#012169" />
						<path d="M0 0L60 30M60 0L0 30" stroke="#fff" strokeWidth="6" />
						<path d="M0 0L60 30M60 0L0 30" stroke="#c8102e" strokeWidth="2.4" />
						<path d="M30 0v30M0 15h60" stroke="#fff" strokeWidth="10" />
						<path d="M30 0v30M0 15h60" stroke="#c8102e" strokeWidth="6" />
					</g>
				)}
			</g>
		</svg>
	);
}
