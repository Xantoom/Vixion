import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { AdminIndex, AdminLayout } from './pages/Admin';
import { NotFound, PageError } from './pages/NotFound';
import { Shell } from './pages/Shell';
import { StreamersPage } from './pages/Streamers';
import { channelQuery, streamQuery } from './lib/queries';
import { queryClient } from './lib/query';
import { routeParams } from './lib/session';

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

/**
 * The page opened by the address the tab started on: its code and its data are asked for at once,
 * while the app still finds out who is signed in, rather than one after the other.
 */
export function preloadStart(pathname: string) {
	const admin = /^\/admin\/(stats|logs|users|settings)/.exec(pathname)?.[1] as keyof typeof pages | undefined;
	if (admin) {
		void pages[admin]().catch(() => undefined);
		return;
	}
	if (pathname === '/' || pathname.startsWith('/admin')) return;
	const { login, id } = routeParams(pathname);
	if (/^\d+$/.test(id)) {
		void pages.studio().catch(() => undefined);
		void queryClient.prefetchQuery(streamQuery(id));
	} else if (login && !id) {
		void pages.channel().catch(() => undefined);
		void queryClient.prefetchQuery(channelQuery(login));
	}
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
		createRoute({
			getParentRoute: () => admin,
			path: '/stats',
			component: lazyRouteComponent(pages.stats, 'StatsPage'),
		}),
		createRoute({
			getParentRoute: () => admin,
			path: '/logs',
			component: lazyRouteComponent(pages.logs, 'LogsPage'),
		}),
		createRoute({
			getParentRoute: () => admin,
			path: '/users',
			component: lazyRouteComponent(pages.users, 'UsersPage'),
		}),
		createRoute({
			getParentRoute: () => admin,
			path: '/settings',
			component: lazyRouteComponent(pages.settings, 'SettingsPage'),
		}),
	]),
	// Channels live at their Twitch name, like on Twitch; the pages above take precedence. The data
	// is asked for as the link is pointed at (or followed), alongside the page's code; the page
	// doesn't wait for it to show, it picks up the request on its way.
	createRoute({
		getParentRoute: () => root,
		path: '/$login',
		component: lazyRouteComponent(pages.channel, 'ChannelPage'),
		loader: ({ params }) => {
			void queryClient.prefetchQuery(channelQuery(params.login.toLowerCase()));
		},
	}),
	createRoute({
		getParentRoute: () => root,
		path: '/$login/$id',
		component: lazyRouteComponent(pages.studio, 'StudioPage'),
		loader: ({ params }) => {
			if (/^\d+$/.test(params.id)) void queryClient.prefetchQuery(streamQuery(params.id));
		},
	}),
];

export const router = createRouter({
	routeTree: root.addChildren(routes),
	defaultPreload: 'intent',
	// The query cache decides what is fresh: the loaders run on each hover and it answers.
	defaultPreloadStaleTime: 0,
	defaultErrorComponent: PageError,
	scrollRestoration: true,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
