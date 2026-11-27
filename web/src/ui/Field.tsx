import { Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, useState } from 'react';
import { Field as DsField } from 'xantoom-design/react';
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

/** A password, with a button to read back what was typed: easier than typing it twice blind. */
export function PasswordInput({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
	const t = useT();
	const [shown, setShown] = useState(false);
	return (
		<div className="relative">
			<input type={shown ? 'text' : 'password'} className={`x-input pe-12 ${className}`} {...props} />
			<button
				type="button"
				aria-label={shown ? t.auth.hidePassword : t.auth.showPassword}
				aria-pressed={shown}
				data-tip={shown ? t.auth.hidePassword : t.auth.showPassword}
				onClick={() => {
					setShown((value) => !value);
				}}
				className="text-fg-faint hover:text-fg x-touch-target absolute end-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-xs transition-colors"
			>
				{shown ? <EyeOff size={18} /> : <Eye size={18} />}
			</button>
		</div>
	);
}
