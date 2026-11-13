import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { AdminIndex, AdminLayout } from './pages/Admin';
import { NotFound, PageError } from './pages/NotFound';
import { Shell } from './pages/Shell';
import { StreamersPage } from './pages/Streamers';

// The player, the channel pages and the administration load apart from the rest; each is
// fetched ahead of time (see below) so opening one doesn't wait on the network.
const pages = {
	channel: async () => fresh(import('./pages/Channel')),
	studio: async () => fresh(import('./pages/Studio')),
	stats: async () => fresh(import('./pages/Stats')),
	settings: async () => fresh(import('./pages/Settings')),
	users: async () => fresh(import('./pages/Users')),
	logs: async () => fresh(import('./pages/Logs')),
};

/**
 * After an update, a tab opened before it asks for files that are gone: the page reloads once to
 * get the new ones, rather than staying blank. A second failure within a minute is a real one.
 */
async function fresh<T>(load: Promise<T>): Promise<T> {
	try {
		return await load;
	} catch (error) {
		const key = 'vixion:reloaded';
		let last = 0;
		try {
			last = Number(sessionStorage.getItem(key) ?? 0);
			sessionStorage.setItem(key, String(Date.now()));
		} catch {
			// Without storage, reloading could loop: show the error instead.
			throw error;
		}
		if (Date.now() - last > 60_000) {
			window.location.reload();
			return new Promise<T>(() => {});
		}
		throw error;
	}
}
const ChannelPage = lazy(async () => pages.channel().then((m) => ({ default: m.ChannelPage })));
const StudioPage = lazy(async () => pages.studio().then((m) => ({ default: m.StudioPage })));
const StatsPage = lazy(async () => pages.stats().then((m) => ({ default: m.StatsPage })));
const SettingsPage = lazy(async () => pages.settings().then((m) => ({ default: m.SettingsPage })));
const UsersPage = lazy(async () => pages.users().then((m) => ({ default: m.UsersPage })));
const LogsPage = lazy(async () => pages.logs().then((m) => ({ default: m.LogsPage })));

/** Fetches the pages people open next, once the browser is idle: channels and the player first. */
export function preloadPages(admin: boolean) {
	const run = () => {
		void pages.channel();
		void pages.studio();
		if (admin) for (const load of [pages.stats, pages.logs, pages.users, pages.settings]) void load();
	};
	if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 });
	else setTimeout(run, 1500);
}

const root = createRootRoute({ component: Shell, notFoundComponent: () => <NotFound /> });

const admin = createRoute({
	getParentRoute: () => root,
	path: '/admin',
	component: AdminLayout,
	// Opening the administration fetches all its sections at once.
	loader: () => {
		for (const load of [pages.stats, pages.logs, pages.users, pages.settings]) void load();
	},
});

const routes = [
	createRoute({ getParentRoute: () => root, path: '/', component: StreamersPage }),
	admin.addChildren([
		createRoute({ getParentRoute: () => admin, path: '/', component: AdminIndex }),
		createRoute({ getParentRoute: () => admin, path: '/stats', component: StatsPage }),
		createRoute({ getParentRoute: () => admin, path: '/logs', component: LogsPage }),
		createRoute({ getParentRoute: () => admin, path: '/users', component: UsersPage }),
		createRoute({ getParentRoute: () => admin, path: '/settings', component: SettingsPage }),
	]),
	// Channels live at their Twitch name, like on Twitch; the pages above take precedence.
	createRoute({ getParentRoute: () => root, path: '/$login', component: ChannelPage }),
	createRoute({ getParentRoute: () => root, path: '/$login/$id', component: StudioPage }),
];

export const router = createRouter({
	routeTree: root.addChildren(routes),
	defaultPreload: 'intent',
	defaultErrorComponent: PageError,
	scrollRestoration: true,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
