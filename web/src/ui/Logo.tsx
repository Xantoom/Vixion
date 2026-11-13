/**
 * Vixion's mark, of the Vixeeny family: a V in a ring that runs back to the red dot of a
 * recording, for "records it, plays it back". A dark tile in the light theme, a light one in the dark.
 */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
			<rect x="1" y="1" width="30" height="30" rx="7.5" fill="var(--logo-tile)" />
			<path
				d="M26.42 11.14A11.5 11.5 0 1 1 20.86 5.58"
				fill="none"
				stroke="var(--logo-mark)"
				strokeWidth="1.7"
				strokeLinecap="round"
			/>
			<polygon
				points="10.2,10.6 13.5,10.6 16,17.05 18.5,10.6 21.8,10.6 17.6,21.4 14.4,21.4"
				fill="var(--logo-mark)"
			/>
			<circle cx="24.13" cy="7.87" r="2.3" fill="#e5322d" />
		</svg>
	);
}
