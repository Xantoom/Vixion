import { Select } from 'xantoom-design/react';
import { useT } from '@/i18n';

/** How long recordings are kept, in words: a preset's name, a number of days, or forever (0). */
function useRetentionLabel(): (days: number) => string {
	const t = useT();
	return (days) => (days === 0 ? t.streamer.retentionForever : (t.streamer.keepPresets[days] ?? t.common.days(days)));
}

const FOLLOW = 'follow';

/**
 * How long recordings are kept, picked from the usual lengths (the design system's select): the same choice for the
 * whole server and for one streamer. A streamer's can also follow the server's (`fallback`), as null. A length set
 * otherwise (an older value, the API) stays listed among them.
 */
export function RetentionMenu({
	value,
	onChange,
	label,
	fallback,
	framed = false,
	id,
	describedBy,
}: {
	value: number | null;
	onChange: (days: number | null) => void;
	label: string;
	/** The server's length, when this one may follow it. */
	fallback?: number;
	/** Edged like the fields around it, on a settings page; quiet in a dialog's row. */
	framed?: boolean;
	/** A SettingRow's control id and description, when it names the select. */
	id?: string;
	describedBy?: string;
}) {
	const t = useT();
	const name = useRetentionLabel();
	const choices = [7, 30, 90, 365];
	if (value && !choices.includes(value)) choices.push(value);
	choices.sort((a, b) => a - b);
	const options = [
		...(fallback === undefined ? [] : [{ value: FOLLOW, label: t.streamer.keepGeneral(name(fallback)) }]),
		...choices.map((days) => ({ value: String(days), label: name(days) })),
		{ value: '0', label: t.streamer.retentionForever },
	];
	return (
		<Select
			{...(id === undefined ? { 'aria-label': label } : { id })}
			aria-describedby={describedBy}
			value={value === null && fallback !== undefined ? FOLLOW : String(value ?? 0)}
			onChange={(next) => {
				onChange(next === FOLLOW ? null : Number(next));
			}}
			options={options}
			variant={framed ? 'field' : 'ghost'}
			className={framed ? 'w-44' : undefined}
		/>
	);
}
