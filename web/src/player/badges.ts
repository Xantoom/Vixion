import type { Messages } from '@/i18n/en';
import { formatNumber } from '@/lib/format';

type BadgeText = Messages['player']['badges'];

/** `subscriber/14,predictions/Team A` → { subscriber: '14', predictions: 'Team A' }. */
export function badgeInfo(info: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!info) return out;
	for (const entry of info.split(',')) {
		const slash = entry.indexOf('/');
		if (slash > 0) out[entry.slice(0, slash)] = entry.slice(slash + 1).replaceAll('⸝', ',');
	}
	return out;
}

/** Months from Twitch's title of a subscriber badge: “3.5-Year Subscriber” → 42. */
function monthsFromTitle(title: string): number {
	const match = /^(\d+(?:\.\d+)?)-(Year|Month)/i.exec(title);
	if (!match?.[1] || !match[2]) return 0;
	const value = Number(match[1]);
	return Math.round(match[2].toLowerCase() === 'year' ? value * 12 : value);
}

/** Channel subscriber badges are numbered tier × 1000 + months: 2024 is tier 2, two years. */
function tierOf(version: string): number {
	const number = Number(version);
	return number >= 2000 && number < 4000 ? Math.floor(number / 1000) : 1;
}

const int = (value: string | undefined) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/**
 * What a badge means, in the reader's language. Subscriptions say for how long: exactly when the
 * recording kept Twitch's `badge-info`, otherwise from the badge itself (the step it shows, from
 * recordings made before it was kept). Badges Vixion doesn't know use Twitch's own title.
 */
export function badgeLabel(
	set: string,
	version: string,
	info: Record<string, string>,
	title: string | undefined,
	t: BadgeText,
): string {
	switch (set) {
		case 'broadcaster':
			return t.broadcaster;
		case 'moderator':
			return t.moderator;
		case 'vip':
			return t.vip;
		case 'partner':
			return t.verified;
		case 'staff':
		case 'admin':
		case 'global_mod':
			return t.staff;
		case 'artist-badge':
			return t.artist;
		case 'no_audio':
			return t.noAudio;
		case 'no_video':
			return t.noVideo;
		case 'subscriber': {
			const months = int(info.subscriber) || monthsFromTitle(title ?? '');
			return t.subscriber(t.duration(months), tierOf(version));
		}
		case 'founder':
			return t.founder(t.duration(int(info.founder)));
		case 'bits': {
			const amount = int(version);
			return amount ? t.bits(formatNumber(amount)) : (title ?? set);
		}
		case 'sub-gifter': {
			const count = int(version);
			return count ? t.gifter(count, formatNumber(count)) : (title ?? set);
		}
		case 'bits-leader':
			return t.bitsLeader(version);
		case 'sub-gift-leader':
			return t.giftLeader(version);
		case 'predictions': {
			const outcome = info.predictions ?? /^Predicted (.+)$/.exec(title ?? '')?.[1];
			return outcome ? t.prediction(outcome) : (title ?? set);
		}
		default:
			return title || set.replaceAll(/[-_]/g, ' ');
	}
}
