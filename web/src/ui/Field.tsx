import type { InputHTMLAttributes, ReactNode } from 'react';
import { Field as DsField, PasswordInput as DsPasswordInput } from 'xantoom-design/react';
import { useT } from '@/i18n';

/** A label, its control, and a hint or an error tied to it: the design system's field. */
export function Field({
	label,
	hint,
	error,
	children,
	className,
}: {
	label: ReactNode;
	hint?: ReactNode;
	error?: string | null;
	children: (id: string, describedBy: string | undefined) => ReactNode;
	className?: string;
}) {
	return (
		<DsField label={label} hint={hint} error={error ?? undefined} className={className}>
			{(control): ReactNode => children(control.id, control['aria-describedby'])}
		</DsField>
	);
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={`x-input ${className}`} {...props} />;
}

/** A password, with a button to read back what was typed (the design system's PasswordInput). */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
	const t = useT();
	return <DsPasswordInput labels={{ show: t.auth.showPassword, hide: t.auth.hidePassword }} {...props} />;
}
