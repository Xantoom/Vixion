import { ChevronDown, Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId, useState } from 'react';
import { useT } from '@/i18n';

/**
 * The frame of everything that takes input: white, with an edge that can be found (3:1), a darker
 * edge under the pointer and a soft ring on focus. 44 px tall on touch screens, 40 with a mouse.
 */
export const FRAME =
	'rounded-sm border border-field bg-card transition-[border-color,box-shadow] duration-150 hover:border-ink-2/70 focus-within:border-focus focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_22%,transparent)]';
const BOX = `${FRAME} h-11 px-3.5 text-ui text-ink outline-none placeholder:text-muted disabled:opacity-50 pointer-fine:h-10`;
const FIELD = `${BOX} w-full`;

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
		<div className={`flex flex-col gap-1.5 ${className}`}>
			<label htmlFor={id} className="text-small text-ink-2 font-medium">
				{label}
			</label>
			{children(id, hint || error ? hintId : undefined)}
			{error ? (
				<p id={hintId} className="text-caption text-danger reveal" role="alert">
					{error}
				</p>
			) : hint ? (
				<p id={hintId} className="text-caption text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={`${FIELD} ${className}`} {...props} />;
}

/** A password, with a button to read back what was typed: easier than typing it twice blind. */
export function PasswordInput({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
	const t = useT();
	const [shown, setShown] = useState(false);
	return (
		<div className="relative">
			<input type={shown ? 'text' : 'password'} className={`${FIELD} pr-12 ${className}`} {...props} />
			<button
				type="button"
				aria-label={shown ? t.auth.hidePassword : t.auth.showPassword}
				aria-pressed={shown}
				data-tip={shown ? t.auth.hidePassword : t.auth.showPassword}
				onClick={() => {
					setShown((value) => !value);
				}}
				className="text-muted hover:text-ink absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-xs transition-colors"
			>
				{shown ? <EyeOff size={18} /> : <Eye size={18} />}
			</button>
		</div>
	);
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<div className={`relative ${className}`}>
			<select className={`${FIELD} appearance-none pr-9`} {...props}>
				{children}
			</select>
			<ChevronDown
				size={16}
				className="text-muted pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
				aria-hidden
			/>
		</div>
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
		'text-muted hover:text-ink hover:bg-surface-2 grid h-full w-10 flex-none place-items-center transition-colors disabled:opacity-30 disabled:hover:bg-transparent';
	return (
		<div className={`${FRAME} flex h-11 w-44 items-center overflow-hidden pointer-fine:h-10`}>
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
				className="text-ui text-ink tabular h-full w-full min-w-0 bg-transparent text-right outline-none"
				{...props}
			/>
			{unit ? <span className="text-small text-muted pl-1.5 whitespace-nowrap">{unit}</span> : null}
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

/** The switch's track and knob, shared with the settings' Toggle. Its touch area reaches 44 px. */
export const SWITCH =
	'bg-line-2 aria-checked:bg-accent-fill relative h-7 w-12 flex-none rounded-sm transition-colors duration-200 before:absolute before:-inset-2 before:content-[""] disabled:opacity-50';
export const KNOB =
	'absolute top-1 left-1 size-5 rounded-xs bg-white shadow-sm transition-transform duration-200 ease-(--ease-spring)';

/** Choices side by side, one selected: a segmented control. */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string; disabled?: boolean }[];
	onChange: (value: T) => void;
	label: string;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="bg-surface inline-flex flex-wrap gap-0.5 rounded-sm p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					disabled={option.disabled}
					onClick={() => {
						onChange(option.value);
					}}
					className="text-small text-muted hover:text-ink aria-checked:bg-card aria-checked:text-ink h-9 rounded-[calc(var(--radius-sm)-2px)] px-3 font-medium transition-colors duration-150 disabled:opacity-40 aria-checked:shadow-sm"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
