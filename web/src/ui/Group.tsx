import { Check } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { KNOB, SWITCH } from './Field';

/** Rows of settings in a box, under a name in small capitals: how dialogs lay out their choices. */
export function Group({ title, children }: { title?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			{title ? (
				<h3 className="text-caption text-ink-2 px-1 font-semibold tracking-wider uppercase">{title}</h3>
			) : null}
			<ul className="bg-surface ring-line divide-line divide-y rounded-md ring-1">{children}</ul>
		</section>
	);
}

/** A row of a group: its name, then a switch; `badge` sits beside the name. */
export function SwitchRow({
	label,
	checked,
	onChange,
	badge,
}: {
	label: ReactNode;
	checked: boolean;
	onChange: (checked: boolean) => void;
	badge?: ReactNode;
}) {
	const id = useId();
	return (
		<li className="flex min-h-12 items-center justify-between gap-4 px-4">
			<label htmlFor={id} className="text-ui text-ink flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-3">
				{label}
				{badge}
			</label>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				onClick={() => {
					onChange(!checked);
				}}
				className={SWITCH}
			>
				<span className={`${KNOB} ${checked ? 'translate-x-5' : ''}`} />
			</button>
		</li>
	);
}

/** A row of a group that is one choice among the group's: a tick shows the one picked. */
export function ChoiceRow({
	name,
	label,
	detail,
	checked,
	onChange,
	children,
}: {
	/** Shared by the rows of one choice. */
	name: string;
	label: ReactNode;
	/** A short fact on the right, such as what the choice amounts to. */
	detail?: ReactNode;
	checked: boolean;
	onChange: () => void;
	/** Shown under the row while it is picked: what the choice still needs. */
	children?: ReactNode;
}) {
	return (
		<li>
			<label className="has-focus-visible:bg-surface-2 flex min-h-12 cursor-pointer items-center gap-3 px-4 py-3">
				<input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
				<span className="text-ui text-ink min-w-0 flex-1">{label}</span>
				{detail ? <span className="text-small text-muted flex-none">{detail}</span> : null}
				<Check
					size={18}
					strokeWidth={2.4}
					className={`text-accent-text flex-none ${checked ? '' : 'invisible'}`}
					aria-hidden
				/>
			</label>
			{checked && children ? <div className="px-4 pb-3">{children}</div> : null}
		</li>
	);
}

/** A row of a group that does something, such as a delete standing apart at the end. */
export function ActionRow({
	children,
	onClick,
	danger = false,
}: {
	children: ReactNode;
	onClick: () => void;
	danger?: boolean;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={`text-ui hover:bg-surface-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-md px-4 font-medium transition-colors ${danger ? 'text-danger' : 'text-accent-text'}`}
			>
				{children}
			</button>
		</li>
	);
}
