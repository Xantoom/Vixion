import { currentLocale } from '@/i18n';

/**
 * Formatters, built once per language and options: building one costs far more than using it,
 * and a page of cards formats hundreds of values on every refresh.
 */
const formatters = new Map<string, unknown>();
function cached<T>(kind: string, options: object, build: (locale: string) => T): T {
	const locale = currentLocale();
	const key = `${kind}|${locale}|${JSON.stringify(options)}`;
	let formatter = formatters.get(key) as T | undefined;
	if (formatter === undefined) {
		formatter = build(locale);
		formatters.set(key, formatter);
	}
	return formatter;
}

function numberFormat(options: Intl.NumberFormatOptions) {
	return cached('number', options, (locale) => new Intl.NumberFormat(locale, options));
}

/** Compares names as a person would: case and accents aside. */
export function compareNames(a: string, b: string): number {
	const base = { sensitivity: 'base' } as const;
	return cached('collator', base, (locale) => new Intl.Collator(locale, base)).compare(a, b);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const UNITS_FR = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];

/** 1.4 GB, in decimal units like disks are sold in. */
export function formatBytes(bytes: number): string {
	const units = currentLocale() === 'fr' ? UNITS_FR : UNITS;
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	const digits = value >= 100 || unit === 0 ? 0 : 1;
	return `${numberFormat({ maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** 1:02:03 or 2:03, for a player. */
export function formatClock(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 3 h 12 min, or 45 min, or 30 s. */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} min`;
	if (h >= 48) return `${Math.floor(h / 24)} ${currentLocale() === 'fr' ? 'j' : 'd'}`;
	return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
	[60, 'second'],
	[60, 'minute'],
	[24, 'hour'],
	[7, 'day'],
	[4.345, 'week'],
	[12, 'month'],
	[Number.POSITIVE_INFINITY, 'year'],
];

/** “3 days ago”, “in 2 hours”. */
export function formatRelative(at: number, now = Date.now()): string {
	const options = { numeric: 'auto' } as const;
	const format = cached('relative', options, (locale) => new Intl.RelativeTimeFormat(locale, options));
	let value = (at - now) / 1000;
	for (const [size, unit] of DIVISIONS) {
		if (Math.abs(value) < size) return format.format(Math.round(value), unit);
		value /= size;
	}
	return '';
}

export function formatDate(at: number, withTime = true): string {
	const options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
		hour: withTime ? '2-digit' : undefined,
		minute: withTime ? '2-digit' : undefined,
	};
	return cached('date', options, (locale) => new Intl.DateTimeFormat(locale, options)).format(at);
}

export function formatNumber(value: number): string {
	return numberFormat({ notation: value >= 100_000 ? 'compact' : 'standard' }).format(value);
}

/** 1080p60 HEVC */
export function formatQuality(height: number | null, fps: number | null, codec: string | null): string {
	const parts: string[] = [];
	if (height) parts.push(`${height}p${fps && fps > 31 ? Math.round(fps) : ''}`);
	if (codec) parts.push(codec.toUpperCase().replace('H265', 'HEVC'));
	return parts.join(' ');
}
