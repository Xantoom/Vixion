import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { NotFound } from './pages/NotFound';
import { Shell } from './pages/Shell';
import { StreamersPage } from './pages/Streamers';

// The player, the administration and the statistics load when first opened.
const StreamerPage = lazy(async () => import('./pages/Streamer').then((m) => ({ default: m.StreamerPage })));
const StudioPage = lazy(async () => import('./pages/Studio').then((m) => ({ default: m.StudioPage })));
const StatsPage = lazy(async () => import('./pages/Stats').then((m) => ({ default: m.StatsPage })));
const SettingsPage = lazy(async () => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const UsersPage = lazy(async () => import('./pages/Users').then((m) => ({ default: m.UsersPage })));
const LogsPage = lazy(async () => import('./pages/Logs').then((m) => ({ default: m.LogsPage })));

const root = createRootRoute({ component: Shell, notFoundComponent: () => <NotFound /> });

const routes = [
	createRoute({ getParentRoute: () => root, path: '/', component: StreamersPage }),
	createRoute({ getParentRoute: () => root, path: '/streamers/$id', component: StreamerPage }),
	createRoute({ getParentRoute: () => root, path: '/streams/$id', component: StudioPage }),
	createRoute({ getParentRoute: () => root, path: '/stats', component: StatsPage }),
	createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage }),
	createRoute({ getParentRoute: () => root, path: '/users', component: UsersPage }),
	createRoute({ getParentRoute: () => root, path: '/logs', component: LogsPage }),
];

export const router = createRouter({
	routeTree: root.addChildren(routes),
	defaultPreload: 'intent',
	scrollRestoration: true,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
