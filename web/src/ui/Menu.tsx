// Menus are the design system's: a popover anchored to its button, the arrow keys move through the items, Escape,
// a click outside or a choice closes it and the focus goes back to the button.
import type { ReactNode } from 'react';
import {
	Menu as DsMenu,
	MenuGroup,
	MenuItem as DsMenuItem,
	MenuLabel,
	MenuSeparator,
	type MenuTriggerProps,
} from 'xantoom-design/react';

export { MenuGroup, MenuLabel, type MenuTriggerProps };

export function Menu({
	trigger,
	children,
	label,
	panelClassName,
}: {
	/** The button; it receives the open state and the attributes to spread on it. */
	trigger: (open: boolean, props: MenuTriggerProps) => ReactNode;
	children: ReactNode;
	label: string;
	panelClassName?: string;
}) {
	return (
		<DsMenu
			label={label}
			className={panelClassName}
			trigger={(props): ReactNode => trigger(props['aria-expanded'], props)}
		>
			{children}
		</DsMenu>
	);
}

export function MenuItem({
	danger = false,
	download,
	...props
}: {
	icon?: ReactNode;
	children: ReactNode;
	onSelect?: () => void;
	/** For a choice among several: shows a tick when current. */
	checked?: boolean;
	danger?: boolean;
	/** A link instead of an action (a download). */
	href?: string;
	download?: boolean;
	disabled?: boolean;
}) {
	return <DsMenuItem tone={danger ? 'danger' : undefined} download={download} {...props} />;
}

export const MenuDivider = MenuSeparator;
