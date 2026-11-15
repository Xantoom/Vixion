import { describe, expect, test } from 'bun:test';
import { en } from '@/i18n/en';
import { fr } from '@/i18n/fr';
import type { Alert } from './api';

// Numbers are formatted in the browser's language, which Bun doesn't have.
Object.defineProperty(navigator, 'languages', { value: ['fr'], configurable: true });

const { alertText } = await import('./alerts');

const alert = (kind: string, message: string): Alert => ({
	id: 1,
	level: 'warning',
	kind,
	message,
	created_at: 0,
	resolved: false,
});

describe('alertText', () => {
	test('names the kind in the reader’s language', () => {
		expect(alertText(alert('disk_low', 'Only 7.8 GB free for recordings'), fr).title).toBe(
			'Plus que 8,4 Go libres pour les enregistrements',
		);
		expect(alertText(alert('disk_full', 'No room left on disk: the recording of zerator stopped'), fr).title).toBe(
			'Disque plein : enregistrement de zerator arrêté',
		);
	});

	test('keeps the error itself as a detail', () => {
		expect(alertText(alert('crash:gotaga', 'Recording gotaga crashed: broken pipe'), en)).toEqual({
			title: 'Recording of gotaga crashed',
			detail: 'broken pipe',
		});
		expect(alertText(alert('twitch_unreachable', 'Twitch can’t be reached: timed out'), fr)).toEqual({
			title: 'Twitch injoignable',
			detail: 'timed out',
		});
	});

	test('shows an unknown kind as the server wrote it', () => {
		expect(alertText(alert('something_new', 'Something: happened'), fr)).toEqual({
			title: 'Something: happened',
			detail: null,
		});
	});
});
