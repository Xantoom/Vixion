import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Locale } from '@/i18n';

export type Theme = 'system' | 'light' | 'dark';

/** What one person prefers on this device: kept in the browser. */
interface Prefs {
	theme: Theme;
	/** Null follows the account, then the browser. */
	locale: Locale | null;
	volume: number;
	muted: boolean;
	compressor: boolean;
	chat: boolean;
	/** Chat column width, in pixels, on wide screens. */
	chatWidth: number;
	set: (changes: Partial<Omit<Prefs, 'set'>>) => void;
}

export const usePrefs = create<Prefs>()(
	persist(
		(set) => ({
			theme: 'system',
			locale: null,
			volume: 1,
			muted: false,
			compressor: false,
			chat: true,
			chatWidth: 340,
			set: (changes) => {
				set(changes);
			},
		}),
		{
			name: 'vixion.prefs',
			partialize: (state) => ({
				theme: state.theme,
				locale: state.locale,
				volume: state.volume,
				muted: state.muted,
				compressor: state.compressor,
				chat: state.chat,
				chatWidth: state.chatWidth,
			}),
		},
	),
);

export function applyTheme(theme: Theme) {
	const root = document.documentElement;
	if (theme === 'system') delete root.dataset.theme;
	else root.dataset.theme = theme;
}
