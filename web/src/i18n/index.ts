import { usePrefs } from '@/stores/prefs';
import { en, type Messages } from './en';
import { fr } from './fr';

export const LOCALES = { en: 'English', fr: 'Français' } as const;
export type Locale = keyof typeof LOCALES;

const messages: Record<Locale, Messages> = { en, fr };

/** The browser's language when it is one Vixion speaks, else English. */
export function browserLocale(): Locale {
	for (const tag of navigator.languages) {
		const base = tag.slice(0, 2).toLowerCase();
		if (base in LOCALES) return base as Locale;
	}
	return 'en';
}

export function currentLocale(): Locale {
	return usePrefs.getState().locale ?? browserLocale();
}

export function useLocale(): Locale {
	return usePrefs((state) => state.locale) ?? browserLocale();
}

/** The messages in the chosen language; the component re-renders when it changes. */
export function useT(): Messages {
	return messages[useLocale()];
}

/** For code outside components (toasts from stores). */
export function t(): Messages {
	return messages[currentLocale()];
}
