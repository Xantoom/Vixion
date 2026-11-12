import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
	BarChart3,
	Check,
	KeyRound,
	LogOut,
	Monitor,
	Moon,
	ScrollText,
	Settings,
	Search,
	Sun,
	Tv,
	Users,
	X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, Suspense, useState } from 'react';
import { LOCALES, type Locale, useLocale, useT } from '@/i18n';
import { type Alert, type Permission, api } from '@/lib/api';
import { meQuery, useCan, useMe } from '@/lib/session';
import { type Theme, usePrefs } from '@/stores/prefs';
import { Avatar } from '@/ui/Avatar';
import { Button, IconButton } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, TextInput } from '@/ui/Field';
import { Flag } from '@/ui/Flag';
import { Logo } from '@/ui/Logo';
import { Menu, MenuDivider, MenuItem, MenuLabel } from '@/ui/Menu';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { ChannelSearch } from './ChannelSearch';

interface NavEntry {
	to: '/' | '/stats' | '/logs' | '/settings' | '/users';
	label: string;
	icon: ReactNode;
	permission?: Permission;
}

function useNav(): NavEntry[] {
	const t = useT();
	const me = useMe();
	const entries: NavEntry[] = [
		{ to: '/', label: t.nav.streamers, icon: <Tv size={19} /> },
		{ to: '/stats', label: t.nav.stats, icon: <BarChart3 size={19} />, permission: 'stats.view' },
		{ to: '/logs', label: t.nav.logs, icon: <ScrollText size={19} />, permission: 'logs.view' },
		{ to: '/users', label: t.nav.users, icon: <Users size={19} />, permission: 'users.manage' },
		{ to: '/settings', label: t.nav.settings, icon: <Settings size={19} />, permission: 'settings.manage' },
	];
	return entries.filter((entry) => !entry.permission || me.admin || me.permissions.includes(entry.permission));
}

/** Open alerts, polled for the dot on the logs entry. */
function useOpenAlerts(): number {
	const can = useCan('logs.view');
	const { data } = useQuery({
		queryKey: ['alerts'],
		queryFn: async () => api.get<Alert[]>('/alerts'),
		enabled: can,
		refetchInterval: 60_000,
	});
	return data?.filter((alert) => !alert.resolved && alert.level !== 'info').length ?? 0;
}

function isActive(path: string, to: string): boolean {
	if (to === '/') return !['/stats', '/logs', '/users', '/settings'].some((page) => path.startsWith(page));
	return path.startsWith(to);
}

export function Shell() {
	const nav = useNav();
	const t = useT();
	const path = useRouterState({ select: (state) => state.location.pathname });
	const alerts = useOpenAlerts();
	const [searching, setSearching] = useState(false);
	// The player takes the whole screen on a phone: no tab bar under it.
	const studio = /^\/[^/]+\/\d+$/.test(path);

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="bg-bg/85 border-line sticky top-0 z-40 border-b backdrop-blur-md">
				<div className="mx-auto flex h-16 max-w-[120rem] items-center gap-2 px-3 sm:gap-3 sm:px-5">
					{searching ? (
						<>
							<ChannelSearch
								onDone={() => {
									setSearching(false);
								}}
							/>
							<IconButton
								label={t.common.close}
								onClick={() => {
									setSearching(false);
								}}
							>
								<X size={20} />
							</IconButton>
						</>
					) : (
						<>
							<Link to="/" className="flex flex-none items-center gap-2.5 rounded-sm" aria-label="Vixion">
								<Logo size={30} />
								<span className="text-lead hidden font-semibold tracking-tight lg:inline">Vixion</span>
							</Link>
							<nav className="ml-2 hidden items-center gap-0.5 md:flex" aria-label={t.nav.menu}>
								{nav.map((entry) => (
									<Link
										key={entry.to}
										to={entry.to}
										title={entry.label}
										aria-label={entry.label}
										aria-current={isActive(path, entry.to) ? 'page' : undefined}
										className="text-ui text-muted hover:text-ink hover:bg-surface aria-[current=page]:text-ink aria-[current=page]:bg-surface relative flex h-10 items-center gap-2 rounded-sm px-2.5 font-medium transition-colors duration-150 xl:px-3"
									>
										{entry.icon}
										<span className="hidden xl:inline">{entry.label}</span>
										{entry.to === '/logs' && alerts > 0 ? (
											<span
												className="bg-danger absolute top-2 right-1.5 size-2 rounded-full"
												aria-hidden
											/>
										) : null}
									</Link>
								))}
							</nav>
							<div className="mx-auto hidden w-full max-w-xl px-2 sm:block">
								<ChannelSearch />
							</div>
							<div className="flex-1 sm:hidden" />
							<IconButton
								label={t.search.label}
								className="sm:hidden"
								onClick={() => {
									setSearching(true);
								}}
							>
								<Search size={20} />
							</IconButton>
							<div className="hidden items-center gap-2 md:flex">
								<ThemeSwitch />
								<LocaleSwitch />
							</div>
							<AccountMenu />
						</>
					)}
				</div>
			</header>
			<main className={`flex-1 ${studio ? '' : 'pb-20 md:pb-0'}`}>
				<Suspense fallback={<PageLoading />}>
					<Outlet />
				</Suspense>
			</main>
			{studio || nav.length < 2 ? null : (
				<nav
					aria-label={t.nav.menu}
					className="bg-bg/90 border-line fixed inset-x-0 bottom-0 z-40 flex border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
				>
					{nav.map((entry) => (
						<Link
							key={entry.to}
							to={entry.to}
							aria-current={isActive(path, entry.to) ? 'page' : undefined}
							className="text-muted aria-[current=page]:text-accent-text relative flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[0.75rem] font-medium"
						>
							{entry.icon}
							<span className="max-w-full truncate px-1">{entry.label}</span>
							{entry.to === '/logs' && alerts > 0 ? (
								<span className="bg-danger absolute top-3 left-[calc(50%+8px)] size-1.5 rounded-full" />
							) : null}
						</Link>
					))}
				</nav>
			)}
		</div>
	);
}

/** A row of icons where one is chosen: the theme, the language. */
function Choice<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; icon: ReactNode }[];
	onChange: (value: T) => void;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="bg-surface flex items-center rounded-full p-1">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					aria-label={option.label}
					title={option.label}
					onClick={() => {
						onChange(option.value);
					}}
					className="text-muted hover:text-ink aria-checked:bg-bg aria-checked:text-ink grid size-8 place-items-center rounded-full transition-[color,background-color,box-shadow] duration-150 aria-checked:shadow-(--shadow-card)"
				>
					{option.icon}
				</button>
			))}
		</div>
	);
}

function useThemeOptions() {
	const t = useT();
	return [
		{ value: 'system' as Theme, label: t.nav.themeSystem, icon: <Monitor size={16} /> },
		{ value: 'light' as Theme, label: t.nav.themeLight, icon: <Sun size={16} /> },
		{ value: 'dark' as Theme, label: t.nav.themeDark, icon: <Moon size={16} /> },
	];
}

function usePickLocale() {
	const setPrefs = usePrefs((state) => state.set);
	return (next: Locale) => {
		setPrefs({ locale: next });
		// Remembered on the account too, for other devices.
		void api.patch('/me', { locale: next }).catch(() => undefined);
	};
}

function ThemeSwitch() {
	const t = useT();
	const theme = usePrefs((state) => state.theme);
	const setPrefs = usePrefs((state) => state.set);
	return (
		<Choice
			label={t.nav.theme}
			value={theme}
			options={useThemeOptions()}
			onChange={(value) => {
				setPrefs({ theme: value });
			}}
		/>
	);
}

function LocaleSwitch() {
	const t = useT();
	const locale = useLocale();
	const pick = usePickLocale();
	return (
		<Choice
			label={t.nav.language}
			value={locale}
			options={(Object.keys(LOCALES) as Locale[]).map((value) => ({
				value,
				label: LOCALES[value],
				icon: <Flag locale={value} />,
			}))}
			onChange={pick}
		/>
	);
}

function AccountMenu() {
	const t = useT();
	const me = useMe();
	const client = useQueryClient();
	const theme = usePrefs((state) => state.theme);
	const locale = useLocale();
	const setPrefs = usePrefs((state) => state.set);
	const pickLocale = usePickLocale();
	const themes = useThemeOptions();
	const [password, setPassword] = useState(false);

	const signOut = async () => {
		await api.post('/auth/logout').catch(() => undefined);
		client.clear();
		client.setQueryData(['setup'], { needed: false });
		client.setQueryData(meQuery.queryKey, null);
	};

	return (
		<>
			<Menu
				label={t.nav.account}
				trigger={(open) => (
					<button
						type="button"
						aria-label={t.nav.account}
						className={`hover:bg-surface flex h-11 flex-none items-center gap-2.5 rounded-full pr-1.5 pl-1.5 transition-colors lg:pr-4 ${open ? 'bg-surface' : ''}`}
					>
						<Avatar src={null} name={me.username} size={32} />
						<span className="text-ui hidden max-w-36 truncate font-medium lg:inline">{me.username}</span>
					</button>
				)}
			>
				<div className="px-2.5 pt-2 pb-2">
					<div className="text-ui font-semibold">{me.username}</div>
					<div className="text-caption text-muted">{t.users.roleNames[me.role] ?? me.role}</div>
				</div>
				<div className="md:hidden">
					<MenuDivider />
					<MenuLabel>{t.nav.theme}</MenuLabel>
					{themes.map((option) => (
						<MenuItem
							key={option.value}
							icon={option.icon}
							checked={theme === option.value}
							onSelect={() => {
								setPrefs({ theme: option.value });
							}}
						>
							{option.label}
						</MenuItem>
					))}
					<MenuLabel>{t.nav.language}</MenuLabel>
					{(Object.keys(LOCALES) as Locale[]).map((value) => (
						<MenuItem
							key={value}
							icon={<Flag locale={value} size={16} />}
							checked={locale === value}
							onSelect={() => {
								pickLocale(value);
							}}
						>
							{LOCALES[value]}
						</MenuItem>
					))}
				</div>
				<MenuDivider />
				<MenuItem
					icon={<KeyRound size={16} />}
					onSelect={() => {
						setPassword(true);
					}}
				>
					{t.nav.password}
				</MenuItem>
				<MenuItem icon={<LogOut size={16} />} onSelect={() => void signOut()}>
					{t.nav.signOut}
				</MenuItem>
				<div className="text-caption text-muted px-2.5 pt-1.5 pb-1">{t.nav.version(me.version)}</div>
			</Menu>
			<PasswordDialog
				open={password}
				onClose={() => {
					setPassword(false);
				}}
			/>
		</>
	);
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.patch('/me', { current_password: current, new_password: next });
			toast.ok(t.auth.passwordChanged);
			setCurrent('');
			setNext('');
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onClose={onClose} title={t.nav.password}>
			<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
				<Field label={t.auth.currentPassword}>
					{(id) => (
						<TextInput
							id={id}
							type="password"
							autoComplete="current-password"
							required
							value={current}
							onChange={(event) => {
								setCurrent(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.newPassword} hint={t.auth.passwordHint} error={error}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							aria-describedby={describedBy}
							value={next}
							onChange={(event) => {
								setNext(event.target.value);
							}}
						/>
					)}
				</Field>
				<div className="flex justify-end gap-2 pt-2">
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button type="submit" variant="primary" busy={busy}>
						<Check size={16} />
						{t.common.save}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
