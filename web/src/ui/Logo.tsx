/** Vixion's mark: a V cut like a play button, with the red dot of a recording. */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
			<rect width="32" height="32" rx="8" className="fill-accent" />
			<path
				d="M8.5 9.5 15 23.5h2L23.5 9.5"
				fill="none"
				className="stroke-accent-ink"
				strokeWidth="3.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="25" cy="7" r="3.2" className="fill-live stroke-bg" strokeWidth="1.6" />
		</svg>
	);
}
