import { useId } from 'react';

/**
 * Vixion's mark, of the Xantoom family: a V in a ring that runs back to the red dot of a
 * recording, for "watches it, records it". One drawing on every background: the tile carries its
 * own warm gradient, so there is no light or dark variant.
 */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
	const gradient = useId();
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="#ffd36e" />
					<stop offset=".48" stopColor="#ffa574" />
					<stop offset="1" stopColor="#ff94bf" />
				</linearGradient>
			</defs>
			<rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${gradient})`} />
			<path
				d="M26.42 11.14A11.5 11.5 0 1 1 20.86 5.58"
				fill="none"
				stroke="#2a1508"
				strokeWidth="1.7"
				strokeLinecap="round"
			/>
			<polygon points="10.2,10.6 13.5,10.6 16,17.05 18.5,10.6 21.8,10.6 17.6,21.4 14.4,21.4" fill="#2a1508" />
			<circle cx="24.13" cy="7.87" r="2.3" fill="#e5322d" />
		</svg>
	);
}
