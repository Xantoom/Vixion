import { ChevronDown } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';

const BOX =
	'h-10 rounded-sm bg-bg px-3 text-ui text-ink shadow-[inset_0_0_0_1px_var(--field-line)] outline-none transition-shadow duration-150 placeholder:text-muted focus:shadow-[inset_0_0_0_2px_var(--focus)] disabled:opacity-50';
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
				<p id={hintId} className="text-caption text-danger" role="alert">
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

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<div className={`relative ${className}`}>
			<select className={`${FIELD} appearance-none pr-9`} {...props}>
				{children}
			</select>
			<ChevronDown size={16} className="text-muted pointer-events-none absolute top-3 right-3" aria-hidden />
		</div>
	);
}

/** A number with its unit after it, such as days or GB. */
export function NumberInput({
	value,
	onChange,
	min,
	max,
	unit,
	id,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	unit?: string;
}) {
	return (
		<div className="flex items-center gap-2">
			<input
				id={id}
				type="number"
				inputMode="numeric"
				min={min}
				max={max}
				value={Number.isFinite(value) ? value : ''}
				onChange={(event) => {
					const next = event.target.valueAsNumber;
					if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
				}}
				className={`${BOX} tabular w-24`}
				{...props}
			/>
			{unit ? <span className="text-ui text-muted">{unit}</span> : null}
		</div>
	);
}

/** An on/off setting: the label and its explanation, the switch at the end of the row. */
export function Switch({
	checked,
	onChange,
	label,
	hint,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: ReactNode;
	hint?: ReactNode;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<div className={`flex items-start justify-between gap-4 ${disabled ? 'opacity-55' : ''}`}>
			<label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
				<span className="text-ui text-ink font-medium">{label}</span>
				{hint ? <span className="text-small text-muted">{hint}</span> : null}
			</label>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				disabled={disabled}
				onClick={() => {
					onChange(!checked);
				}}
				className="bg-line-2 aria-checked:bg-accent relative mt-0.5 h-6 w-10 flex-none rounded-full transition-colors duration-200"
			>
				<span
					className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-(--ease-spring) ${checked ? 'translate-x-4' : ''}`}
				/>
			</button>
		</div>
	);
}

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
					className="text-small text-muted hover:text-ink aria-checked:bg-bg aria-checked:text-ink h-8 rounded-[calc(var(--radius-sm)-2px)] px-3 font-medium transition-colors duration-150 disabled:opacity-40 aria-checked:shadow-sm"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
