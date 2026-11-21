import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

type Variant = 'accent' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-ghost';

const VARIANTS: Record<Variant, string> = {
	accent: 'bg-accent-fill text-accent-ink font-semibold hover:brightness-[1.07] disabled:opacity-45',
	// Edged like the fields it often sits beside.
	secondary: 'text-ink font-medium shadow-[inset_0_0_0_1px_var(--field-line)] hover:bg-surface disabled:opacity-45',
	// Edged at rest, filled with the accent under the pointer: a main action that shouldn't shout.
	outline:
		'text-ink font-medium shadow-[inset_0_0_0_1px_var(--field-line)] hover:bg-accent-fill hover:text-accent-ink hover:shadow-none disabled:opacity-45',
	ghost: 'text-ink-2 font-medium hover:bg-surface hover:text-ink disabled:opacity-45',
	danger: 'bg-danger-fill text-white font-semibold hover:brightness-[1.07] disabled:opacity-45',
	// A destructive action that is not the point of where it sits: red words, no fill.
	'danger-ghost': 'text-danger font-medium hover:bg-danger-soft disabled:opacity-45',
};

/**
 * The look of a button, for a link that goes somewhere: a link can't hold a button, so it wears
 * the classes itself.
 */
export function buttonClass(variant: Variant = 'secondary', size: 'sm' | 'md' = 'md'): string {
	const height = size === 'sm' ? 'h-8 px-3 text-small rounded-xs' : 'h-10 px-4.5 text-ui rounded-sm';
	return `relative inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[filter,background-color,opacity] duration-150 active:scale-[0.98] ${height} ${VARIANTS[variant]}`;
}

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
	return (
		<button
			type={type}
			aria-disabled={busy || undefined}
			aria-busy={busy || undefined}
			onClick={busy ? undefined : onClick}
			className={`${buttonClass(variant, size)} ${className}`}
			{...props}
		>
			{busy ? <Spinner className="absolute" /> : null}
			{/* Transparent rather than invisible: the label stays the button's name while it works. */}
			<span className={`inline-flex items-center gap-2 ${busy ? 'opacity-0' : ''}`}>{children}</span>
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
