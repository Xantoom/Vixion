import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { AdminIndex, AdminLayout } from './pages/Admin';
import { NotFound } from './pages/NotFound';
import { Shell } from './pages/Shell';
import { StreamersPage } from './pages/Streamers';

// The player, the administration and the statistics load when first opened.
const ChannelPage = lazy(async () => import('./pages/Channel').then((m) => ({ default: m.ChannelPage })));
const StudioPage = lazy(async () => import('./pages/Studio').then((m) => ({ default: m.StudioPage })));
const StatsPage = lazy(async () => import('./pages/Stats').then((m) => ({ default: m.StatsPage })));
const SettingsPage = lazy(async () => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const UsersPage = lazy(async () => import('./pages/Users').then((m) => ({ default: m.UsersPage })));
const LogsPage = lazy(async () => import('./pages/Logs').then((m) => ({ default: m.LogsPage })));

const root = createRootRoute({ component: Shell, notFoundComponent: () => <NotFound /> });

const admin = createRoute({ getParentRoute: () => root, path: '/admin', component: AdminLayout });

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
	scrollRestoration: true,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
