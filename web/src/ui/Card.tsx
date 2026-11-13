import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

/** A titled block of an administration page: a header with optional actions, then its content. */
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
		<section className={`bg-card ring-line overflow-hidden rounded-md ring-1 ${className}`}>
			<header className="border-line flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5">
				<h2 className="text-ui flex items-center gap-2 font-semibold">
					{title}
					{count !== undefined ? <span className="text-muted tabular font-medium">{count}</span> : null}
				</h2>
				{actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
			</header>
			<div className={flush ? '' : 'p-5'}>{children}</div>
		</section>
	);
}

/** An explanation kept out of the way: shown when the pointer rests on the icon. */
export function InfoTip({ text }: { text: string }) {
	return (
		<span
			tabIndex={0}
			role="img"
			aria-label={text}
			data-tip={text}
			className="text-muted hover:text-ink inline-grid size-5 flex-none cursor-help place-items-center rounded-full transition-colors"
		>
			<Info size={15} />
		</span>
	);
}

/** One setting: its name on the left, its control on the right, every control ending on the same edge. */
export function SettingRow({ label, tip, children }: { label: ReactNode; tip?: string; children: ReactNode }) {
	return (
		<div className="border-line flex min-h-16 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-5 py-3 first:border-t-0">
			<span className="text-ui flex min-w-0 items-center gap-1.5 font-medium">
				{label}
				{tip ? <InfoTip text={tip} /> : null}
			</span>
			<div className="flex max-w-full items-center justify-end gap-2">{children}</div>
		</div>
	);
}

/** An on or off setting. */
export function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => {
				onChange(!checked);
			}}
			className="bg-line-2 aria-checked:bg-accent relative h-6 w-10 flex-none rounded-sm transition-colors duration-200"
		>
			<span
				className={`absolute top-0.5 left-0.5 size-5 rounded-xs bg-white shadow-sm transition-transform duration-200 ease-(--ease-spring) ${checked ? 'translate-x-4' : ''}`}
			/>
		</button>
	);
}

/** Label and value pairs, for facts that are read rather than changed; laid out like setting rows. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
	return (
		<dl className="divide-line divide-y">
			{items.map(([label, value]) => (
				<div
					key={label}
					className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3"
				>
					<dt className="text-ui text-ink-2 font-medium">{label}</dt>
					<dd className="text-ui min-w-0 text-right break-all">{value}</dd>
				</div>
			))}
		</dl>
	);
}
