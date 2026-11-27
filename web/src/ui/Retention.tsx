import { ChevronDown } from 'lucide-react';
import { useT } from '@/i18n';
import { FRAME } from './Field';
import { Menu, MenuDivider, MenuItem } from './Menu';

/** How long recordings are kept, in words: a preset's name, a number of days, or forever (0). */
function useRetentionLabel(): (days: number) => string {
	const t = useT();
	return (days) => (days === 0 ? t.streamer.retentionForever : (t.streamer.keepPresets[days] ?? t.common.days(days)));
}

/**
 * How long recordings are kept, picked from the usual lengths: the same choice for the whole
 * server and for one streamer. A streamer's can also follow the server's (`fallback`), as null.
 * A length set otherwise (an older value, the API) stays listed among them.
 */
export function RetentionMenu({
	value,
	onChange,
	label,
	fallback,
	framed = false,
}: {
	value: number | null;
	onChange: (days: number | null) => void;
	label: string;
	/** The server's length, when this one may follow it. */
	fallback?: number;
	/** Edged like the fields around it, on a settings page; bare in a dialog's row. */
	framed?: boolean;
}) {
	const t = useT();
	const name = useRetentionLabel();
	const choices = [7, 30, 90, 365];
	if (value && !choices.includes(value)) choices.push(value);
	choices.sort((a, b) => a - b);
	const current =
		value === null && fallback !== undefined ? t.streamer.keepGeneral(name(fallback)) : name(value ?? 0);
	return (
		<Menu
			label={label}
			trigger={(_open, props) => (
				<button
					type="button"
					{...props}
					className={`text-ui inline-flex h-10 flex-none items-center gap-1.5 whitespace-nowrap ${
						framed
							? `${FRAME} text-fg min-w-44 justify-between px-3.5 pointer-coarse:h-11`
							: 'text-fg-muted hover:text-fg hover:bg-raised-2 rounded-sm px-3 font-medium transition-colors'
					}`}
				>
					{current}
					<ChevronDown size={16} className="text-fg-faint" />
				</button>
			)}
		>
			{fallback !== undefined ? (
				<>
					<MenuItem
						checked={value === null}
						onSelect={() => {
							onChange(null);
						}}
					>
						{t.streamer.keepGeneral(name(fallback))}
					</MenuItem>
					<MenuDivider />
				</>
			) : null}
			{choices.map((days) => (
				<MenuItem
					key={days}
					checked={value === days}
					onSelect={() => {
						onChange(days);
					}}
				>
					{name(days)}
				</MenuItem>
			))}
			<MenuDivider />
			<MenuItem
				checked={value === 0}
				onSelect={() => {
					onChange(0);
				}}
			>
				{t.streamer.retentionForever}
			</MenuItem>
		</Menu>
	);
}
