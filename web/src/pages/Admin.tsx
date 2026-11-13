import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { BarChart3, ScrollText, Settings, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import type { Me, Permission } from '@/lib/api';
import { useMe } from '@/lib/session';
import { NotFound } from './NotFound';

type AdminPath = '/admin/stats' | '/admin/logs' | '/admin/users' | '/admin/settings';

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
	return (
		<div className="mx-auto max-w-6xl px-4 sm:px-6">
			<h1 className="text-heading pt-8 pb-5 font-semibold tracking-tight">{t.nav.admin}</h1>
			<nav
				aria-label={t.nav.admin}
				className="border-line mb-7 flex gap-1 overflow-x-auto overflow-y-hidden border-b"
			>
				{pages.map((page) => (
					<Link
						key={page.to}
						to={page.to}
						aria-current={path.startsWith(page.to) ? 'page' : undefined}
						className="text-ui text-muted hover:text-ink aria-[current=page]:text-ink relative -mb-px flex h-12 flex-none items-center gap-2 px-3 font-semibold transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent aria-[current=page]:after:bg-[var(--accent)]"
					>
						{page.icon}
						{labels[page.to]}
					</Link>
				))}
			</nav>
			<Outlet />
		</div>
	);
}

/** `/admin` alone opens the first section this person may see. */
export function AdminIndex() {
	const page = firstAdminPage(useMe());
	return page ? <Navigate to={page} replace /> : null;
}
