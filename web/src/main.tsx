import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient } from './lib/query';
import { applyTheme, usePrefs } from './stores/prefs';

applyTheme(usePrefs.getState().theme);
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
