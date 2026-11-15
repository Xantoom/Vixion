import { describe, expect, test } from 'bun:test';
import { en } from '@/i18n/en';
import { fr } from '@/i18n/fr';
import { badgeInfo, badgeLabel } from './badges';

// Numbers are formatted in the browser's language, which Bun doesn't have.
Object.defineProperty(navigator, 'languages', { value: ['fr'], configurable: true });

const label = (badge: string, info: string | undefined, title?: string, t = fr.player.badges) => {
	const [set = '', version = ''] = badge.split('/');
	return badgeLabel(set, version, badgeInfo(info), title, t);
};

describe('subscriber badges', () => {
	test('exact months from badge-info', () => {
		expect(label('subscriber/12', 'subscriber/14')).toBe('Abonnement 1 an 2 mois');
		expect(label('subscriber/3', 'subscriber/5')).toBe('Abonnement 5 mois');
		expect(label('subscriber/24', 'subscriber/24')).toBe('Abonnement 2 ans');
		expect(label('subscriber/3024', 'subscriber/30')).toBe('Abonnement 2 ans 6 mois · niveau 3');
		expect(label('subscriber/0', 'subscriber/1')).toBe('Abonnement 1 mois');
	});
	test('older recordings fall back on the badge title', () => {
		expect(label('subscriber/3042', undefined, '3.5-Year Subscriber')).toBe('Abonnement 3 ans 6 mois · niveau 3');
		expect(label('subscriber/0', undefined, 'Subscriber')).toBe('Abonnement');
	});
	test('english', () => {
		expect(label('subscriber/12', 'subscriber/13', undefined, en.player.badges)).toBe(
			'Subscriber for 1 year 1 month',
		);
	});
});

test('other badges', () => {
	expect(label('founder/0', 'founder/7')).toBe('Fondateur, abonnement 7 mois');
	expect(label('moderator/1', undefined, 'Moderator')).toBe('Modérateur');
	expect(label('sub-gifter/50', undefined)).toBe('50 abonnements offerts');
	expect(label('predictions/blue-1', 'predictions/Team A⸝ B')).toBe('Pronostic : Team A, B');
	expect(label('glhf-pledge/1', undefined, 'GLHF Pledge')).toBe('GLHF Pledge');
	expect(label('some-event_badge/1', undefined)).toBe('some event badge');
});
