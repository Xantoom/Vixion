import type { Messages } from '@/i18n/en';
import type { Alert } from './api';
import { formatBytes } from './format';

/** After the server's “What: ” prefix, the error itself (technical, left as it comes). */
function detail(message: string): string | null {
	const cut = message.indexOf(': ');
	return cut >= 0 ? message.slice(cut + 2) : null;
}

/**
 * An alert in the reader's language: the server writes its alerts in English (logs, webhooks),
 * so the interface names each kind itself and keeps only the error's own words as a detail.
 */
export function alertText(alert: Alert, t: Messages): { title: string; detail: string | null } {
	const kind = alert.kind;
	const login = kind.slice(kind.indexOf(':') + 1);
	const a = t.alerts;
	if (kind === 'disk_low') {
		const gib = Number(/([\d.]+) GB/.exec(alert.message)?.[1]);
		return Number.isFinite(gib)
			? { title: a.diskLow(formatBytes(gib * 1024 ** 3)), detail: null }
			: { title: alert.message, detail: null };
	}
	if (kind === 'disk_full') {
		const who = / of (\S+) stopped/.exec(alert.message)?.[1];
		return { title: who ? a.diskFull(who) : alert.message, detail: null };
	}
	if (kind === 'twitch_token') return { title: a.twitchToken, detail: null };
	if (kind === 'twitch_integrity') return { title: a.twitchIntegrity, detail: null };
	if (kind.startsWith('write:')) return { title: a.recordingFailed(login), detail: detail(alert.message) };
	if (kind.startsWith('crash:')) return { title: a.recordingCrashed(login), detail: detail(alert.message) };
	const titles: Record<string, string> = {
		twitch_unreachable: a.twitchUnreachable,
		certificate: a.certificate,
		ddns: a.ddns,
		storage: a.storage,
		upnp: a.upnp,
		live_checks: a.liveChecks,
	};
	const title = titles[kind];
	return title ? { title, detail: detail(alert.message) } : { title: alert.message, detail: null };
}
