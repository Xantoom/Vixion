import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Switch } from './Field';

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
		<section className={`bg-raised ring-line overflow-hidden rounded-md ring-1 ${className}`}>
			<header className="border-line flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 border-b px-6 py-3">
				<h2 className="text-ui flex items-center gap-2 font-semibold">
					{title}
					{count !== undefined ? <span className="text-fg-faint x-tabular font-medium">{count}</span> : null}
				</h2>
				{actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
			</header>
			<div className={flush ? '' : 'p-6'}>{children}</div>
		</section>
	);
}

/** An explanation kept out of the way: shown when the pointer rests on the icon. */
function InfoTip({ text }: { text: string }) {
	return (
		<span
			tabIndex={0}
			role="img"
			aria-label={text}
			data-tip={text}
			className="text-fg-faint hover:text-fg x-touch-target relative inline-grid size-5 flex-none cursor-help place-items-center rounded-full transition-colors"
		>
			<Info size={15} />
		</span>
	);
}

/** A name and its tip, the tip glued to the last word so it never sits alone on a line. */
function WithTip({ label, tip }: { label: ReactNode; tip: string }) {
	const text = typeof label === 'string' ? label : null;
	const cut = text ? text.lastIndexOf(' ') + 1 : 0;
	return (
		<>
			{text ? text.slice(0, cut) : label}
			<span className="whitespace-nowrap">
				{text ? text.slice(cut) : null}
				<span className="ml-1.5 inline-block align-middle">
					<InfoTip text={tip} />
				</span>
			</span>
		</>
	);
}

/** One setting: its name on the left, its control on the right, every control ending on the same edge. */
export function SettingRow({
	label,
	tip,
	wide = false,
	children,
}: {
	label: ReactNode;
	tip?: string;
	/** A control that needs room (an address): on a phone it takes its own full-width line. */
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="border-line flex min-h-18 flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t px-6 py-4 first:border-t-0">
			{/* Inline, so the tip follows the last word when the name wraps. */}
			<span className="text-ui min-w-0 font-medium">{tip ? <WithTip label={label} tip={tip} /> : label}</span>
			{/* When it goes under its name it stays on the right edge, like every other control. */}
			<div className={`ml-auto flex max-w-full items-center justify-end gap-2 ${wide ? 'max-sm:w-full' : ''}`}>
				{children}
			</div>
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
	return <Switch aria-label={label} checked={checked} onChange={onChange} />;
}

/** Label and value pairs, for facts that are read rather than changed; laid out like setting rows. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
	return (
		<dl className="divide-line divide-y">
			{items.map(([label, value]) => (
				<div
					key={label}
					className="flex min-h-16 flex-wrap items-center justify-between gap-x-8 gap-y-1 px-6 py-4"
				>
					<dt className="text-ui text-fg-muted font-medium">{label}</dt>
					<dd className="text-ui ml-auto min-w-0 text-right break-all">{value}</dd>
				</div>
			))}
		</dl>
	);
}
