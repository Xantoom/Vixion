import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tooltips } from 'xantoom-design/js';
import { App } from './App';
import { queryClient } from './lib/query';
import { installTrustedTypes } from './lib/trusted-types';
import { preloadStart } from './router';
import { applyTheme, usePrefs } from './stores/prefs';

installTrustedTypes();
preloadStart(window.location.pathname);
applyTheme(usePrefs.getState().theme);
// One shared tooltip for every data-tip (mouse, keyboard, a tap on touch), over dialogs and full screen too.
tooltips();
usePrefs.subscribe((state, before) => {
	if (state.theme !== before.theme) applyTheme(state.theme);
	if (state.locale !== before.locale) document.documentElement.lang = state.locale ?? navigator.language;
});

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>
		</StrictMode>,
	);
}
