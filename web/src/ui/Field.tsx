import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId, useState } from 'react';
import { useT } from '@/i18n';

/**
 * The frame of a compound control (a number with its steppers): the design system's field box, with the ring moved to
 * the frame when its input has the focus.
 */
export const FRAME =
	'rounded-md border border-control-border bg-raised transition-[border-color] duration-(--x-duration-fast) hover:border-fg-muted focus-within:border-accent focus-within:outline-2 focus-within:outline-accent';

/** A label, its control, and a hint or an error tied to it (design system field). */
export function Field({
	label,
	hint,
	error,
	children,
	className = '',
}: {
	label: ReactNode;
	hint?: ReactNode;
	error?: string | null;
	children: (id: string, describedBy: string | undefined) => ReactNode;
	className?: string;
}) {
	const id = useId();
	const hintId = `${id}-hint`;
	return (
		<div className={`x-field ${className}`}>
			<label htmlFor={id} className="x-label">
				{label}
			</label>
			{children(id, hint || error ? hintId : undefined)}
			{error ? (
				<p id={hintId} className="x-error reveal" role="alert">
					{error}
				</p>
			) : hint ? (
				<p id={hintId} className="x-hint">
					{hint}
				</p>
			) : null}
		</div>
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

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select className={`x-select ${className}`} {...props}>
			{children}
		</select>
	);
}

/**
 * A number with its unit, and buttons to step it: easy with a thumb, and typed freely with a
 * keyboard. What is typed is checked against the limits when the field is left, not at every key.
 */
export function NumberInput({
	value,
	onChange,
	min,
	max,
	step = 1,
	unit,
	id,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'step'> & {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step?: number;
	unit?: string;
}) {
	const [text, setText] = useState<string | null>(null);
	const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
	const commit = () => {
		if (text === null) return;
		const next = Number(text.replace(',', '.'));
		if (text.trim() !== '' && Number.isFinite(next)) onChange(clamp(next));
		setText(null);
	};
	const stepper =
		'text-fg-faint hover:text-fg hover:bg-raised-2 grid h-full w-10 flex-none place-items-center transition-colors disabled:opacity-30 disabled:hover:bg-transparent';
	return (
		<div className={`${FRAME} flex h-(--x-control) w-44 items-center overflow-hidden`}>
			<button
				type="button"
				tabIndex={-1}
				aria-hidden
				disabled={value <= min}
				onClick={() => {
					onChange(clamp(value - step));
				}}
				className={stepper}
			>
				<Minus size={16} />
			</button>
			<input
				id={id}
				type="text"
				inputMode="numeric"
				role="spinbutton"
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={value}
				value={text ?? (Number.isFinite(value) ? String(value) : '')}
				onChange={(event) => {
					setText(event.target.value.replace(/[^\d.,-]/g, ''));
				}}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === 'Enter') commit();
					else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
						event.preventDefault();
						setText(null);
						onChange(clamp(value + (event.key === 'ArrowUp' ? step : -step)));
					}
				}}
				className="text-ui text-fg x-tabular h-full w-full min-w-0 bg-transparent text-end outline-none"
				{...props}
			/>
			{unit ? <span className="text-small text-fg-faint ps-1.5 whitespace-nowrap">{unit}</span> : null}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden
				disabled={value >= max}
				onClick={() => {
					onChange(clamp(value + step));
				}}
				className={stepper}
			>
				<Plus size={16} />
			</button>
		</div>
	);
}

/** An on or off control: the design system switch, a native checkbox. */
export function Switch({
	checked,
	onChange,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> & {
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<input
			type="checkbox"
			role="switch"
			{...({ switch: '' } as object)}
			className="x-switch"
			checked={checked}
			onChange={(event) => {
				onChange(event.currentTarget.checked);
			}}
			{...props}
		/>
	);
}
