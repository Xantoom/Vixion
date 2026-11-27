import { type ReactNode, useId } from 'react';
import { Switch } from './Field';

/** Rows of settings in a box, under a name in small capitals: how dialogs lay out their choices. */
export function Group({ title, children }: { title?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			{title ? (
				<h3 className="text-caption text-fg-muted px-1 font-semibold tracking-wider uppercase">{title}</h3>
			) : null}
			<ul className="bg-raised ring-line divide-line divide-y rounded-md ring-1">{children}</ul>
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
		<li className="flex min-h-14 items-center justify-between gap-4 px-5">
			<label htmlFor={id} className="text-ui text-fg flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-3">
				{label}
				{badge}
			</label>
			<Switch id={id} checked={checked} onChange={onChange} />
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
				className={`text-ui hover:bg-raised-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-md px-4 font-medium transition-colors ${danger ? 'text-danger' : 'text-accent'}`}
			>
				{children}
			</button>
		</li>
	);
}
