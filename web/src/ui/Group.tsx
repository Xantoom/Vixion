// Rows of settings in a frame, as dialogs lay out their choices: the design system's settings list.
import type { ReactNode } from 'react';
import { SettingRow, Switch } from 'xantoom-design/react';
import { Button } from './Button';

/** The frame of rows, under an optional name (the design system's `x-settings`). */
export function Group({ title, children }: { title?: ReactNode; children: ReactNode }) {
	return (
		<section className="x-settings">
			{title ? <h3>{title}</h3> : null}
			<ul>{children}</ul>
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
	return (
		<SettingRow
			label={
				<span className="inline-flex items-center gap-2">
					{label}
					{badge}
				</span>
			}
		>
			{(control) => <Switch {...control} checked={checked} onChange={onChange} />}
		</SettingRow>
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
		<li className="justify-center">
			<Button variant={danger ? 'danger-ghost' : 'ghost'} onClick={onClick}>
				{children}
			</Button>
		</li>
	);
}
