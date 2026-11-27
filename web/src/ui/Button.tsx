// Buttons are the design system's. Vixion's names for their looks map onto its variants.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button as DsButton, IconButton as DsIconButton, buttonProps as dsButtonProps } from 'xantoom-design/react';

type Variant = 'accent' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-ghost';

const LOOK = {
	accent: 'primary',
	secondary: 'secondary',
	// Edged at rest: the secondary look.
	outline: 'secondary',
	ghost: 'ghost',
	danger: 'danger',
	// A destructive action that is not the point of where it sits: red words, no fill.
	'danger-ghost': 'ghost',
} as const;

/** The attributes that give a link the look of a button (a link can't hold a button). */
export function buttonProps(variant: Variant = 'secondary', size: 'sm' | 'md' = 'md') {
	const look = dsButtonProps({ variant: LOOK[variant], size });
	return variant === 'danger-ghost' ? { ...look, className: `${look.className} text-danger` } : look;
}

export function Button({
	variant = 'secondary',
	className = '',
	size = 'md',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	/** Working: a spinner over the kept label, no second press, and the keyboard focus stays. */
	busy?: boolean;
	size?: 'sm' | 'md';
}) {
	return (
		<DsButton
			variant={LOOK[variant]}
			size={size}
			className={`${variant === 'danger-ghost' ? 'text-danger' : ''} ${className}`.trim() || undefined}
			{...props}
		/>
	);
}

/** Square button for a single icon; the label is announced and shown as a tooltip. */
export function IconButton({
	label,
	size = 'md',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; size?: 'sm' | 'md' }) {
	return <DsIconButton label={label} size={size} {...props} />;
}
