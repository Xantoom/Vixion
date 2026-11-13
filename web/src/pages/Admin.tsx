import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { BarChart3, ScrollText, Settings, Users } from 'lucide-react';
import { type ReactNode, Suspense } from 'react';
import { useT } from '@/i18n';
import type { Me, Permission } from '@/lib/api';
import { useMe } from '@/lib/session';
import { PageLoading } from '@/ui/Spinner';
import { NotFound } from './NotFound';

export type AdminPath = '/admin/stats' | '/admin/logs' | '/admin/users' | '/admin/settings';

const PAGES: { to: AdminPath; permission: Permission; icon: ReactNode }[] = [
	{ to: '/admin/stats', permission: 'stats.view', icon: <BarChart3 size={18} /> },
	{ to: '/admin/logs', permission: 'logs.view', icon: <ScrollText size={18} /> },
	{ to: '/admin/users', permission: 'users.manage', icon: <Users size={18} /> },
	{ to: '/admin/settings', permission: 'settings.manage', icon: <Settings size={18} /> },
];

function allowed(me: Me) {
	return PAGES.filter((page) => me.admin || me.permissions.includes(page.permission));
}

/** Where the administration button leads: the first section this person may open. */
export function firstAdminPage(me: Me): AdminPath | null {
	return allowed(me)[0]?.to ?? null;
}

/** Statistics, logs, users and settings, as tabs of one page. */
export function AdminLayout() {
	const t = useT();
	const me = useMe();
	const path = useRouterState({ select: (state) => state.location.pathname });
	const pages = allowed(me);
	if (pages.length === 0) return <NotFound forbidden />;
	const labels: Record<AdminPath, string> = {
		'/admin/stats': t.nav.stats,
		'/admin/logs': t.nav.logs,
		'/admin/users': t.nav.users,
		'/admin/settings': t.nav.settings,
	};
	const current = pages.find((page) => path.startsWith(page.to));
	return (
		<div
			data-admin
			className="mx-auto grid max-w-[calc(13rem+2.5rem+72rem+3rem)] grid-cols-[minmax(0,1fr)] gap-x-10 px-4 pt-6 pb-16 sm:px-6 lg:grid-cols-[13rem_minmax(0,72rem)] lg:pt-10"
		>
			<nav aria-label={t.nav.admin} className="max-lg:mb-6 lg:sticky lg:top-24 lg:self-start">
				<p className="text-caption text-muted mb-2 px-3 font-semibold tracking-wide uppercase max-lg:hidden">
					{t.nav.admin}
				</p>
				<ul className="grid grid-cols-2 gap-1 sm:flex sm:overflow-x-auto lg:flex-col">
					{pages.map((page) => (
						<li key={page.to} className="flex-none">
							<Link
								to={page.to}
								aria-current={path.startsWith(page.to) ? 'page' : undefined}
								className="text-ui text-ink-2 hover:bg-surface hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:text-ink relative flex h-10 items-center gap-2.5 rounded-sm px-3 font-medium transition-colors aria-[current=page]:font-semibold"
							>
								<span className="text-muted [[aria-current=page]>&]:text-accent-text">{page.icon}</span>
								{labels[page.to]}
							</Link>
						</li>
					))}
				</ul>
			</nav>
			<div className="min-w-0">
				{current ? (
					<h1 className="text-heading mb-6 font-semibold tracking-tight">{labels[current.to]}</h1>
				) : null}
				<Suspense fallback={<PageLoading />}>
					<Outlet />
				</Suspense>
			</div>
		</div>
	);
}

/** `/admin` alone opens the first section this person may see. */
export function AdminIndex() {
	const page = firstAdminPage(useMe());
	return page ? <Navigate to={page} replace /> : null;
}
