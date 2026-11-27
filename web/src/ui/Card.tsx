import type { ReactNode } from 'react';

/** A titled block of an administration page (the design system's card): a head with a count and actions, then content. */
export function Card({
	title,
	count,
	actions,
	children,
	flush = false,
	className = '',
}: {
	title: ReactNode;
	count?: number;
	actions?: ReactNode;
	children: ReactNode;
	/** Content touches the edges (tables, lists, consoles). */
	flush?: boolean;
	className?: string;
}) {
	return (
		<section className={`x-card ${className}`.trim()} data-flush={flush ? '' : undefined}>
			<header className="x-card-head">
				<h2>
					{title}
					{count !== undefined ? <span className="x-count">{count}</span> : null}
				</h2>
				{actions ? <div className="x-card-actions">{actions}</div> : null}
			</header>
			{children}
		</section>
	);
}
