import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

type Variant = 'accent' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
	accent: 'bg-accent-fill text-accent-ink font-semibold hover:brightness-[1.07] disabled:opacity-45',
	// Edged like the fields it often sits beside.
	secondary: 'text-ink font-medium shadow-[inset_0_0_0_1px_var(--field-line)] hover:bg-surface disabled:opacity-45',
	ghost: 'text-ink-2 font-medium hover:bg-surface hover:text-ink disabled:opacity-45',
	danger: 'bg-danger text-white font-semibold hover:brightness-[1.07] disabled:opacity-45',
};

export function Button({
	variant = 'secondary',
	className = '',
	type = 'button',
	busy = false,
	size = 'md',
	onClick,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	/** Working: looks disabled and does nothing, but keeps the keyboard focus, unlike `disabled`. */
	busy?: boolean;
	size?: 'sm' | 'md';
}) {
	const height = size === 'sm' ? 'h-8 px-3 text-small rounded-xs' : 'h-10 px-4.5 text-ui rounded-sm';
	return (
		<button
			type={type}
			aria-disabled={busy || undefined}
			onClick={busy ? undefined : onClick}
			className={`relative inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[filter,background-color,opacity] duration-150 active:scale-[0.98] ${height} ${VARIANTS[variant]} ${className}`}
			{...props}
		>
			{busy ? <Spinner className="absolute" /> : null}
			<span className={`inline-flex items-center gap-2 ${busy ? 'invisible' : ''}`}>{children}</span>
		</button>
	);
}

/** Square button for a single icon; the label is announced and shown as a tooltip. */
export function IconButton({
	label,
	children,
	className = '',
	type = 'button',
	size = 'md',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; size?: 'sm' | 'md' }) {
	return (
		<button
			type={type}
			aria-label={label}
			data-tip={label}
			className={`text-muted enabled:hover:bg-surface enabled:hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent-text touch-target relative grid flex-none place-items-center rounded-sm transition-colors duration-150 disabled:opacity-40 ${size === 'sm' ? 'size-8' : 'size-10'} ${className}`}
			{...props}
		>
			{children}
		</button>
	);
}
