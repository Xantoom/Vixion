import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, KeyRound, Languages, LogOut, Monitor, Moon, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { LOCALES, type Locale, useLocale, useT } from '@/i18n';
import { useAction } from '@/lib/action';
import { type Alert, api } from '@/lib/api';
import { meQuery, useCan, useMe } from '@/lib/session';
import { type Theme, usePrefs } from '@/stores/prefs';
import { Avatar } from '@/ui/Avatar';
import { Button, IconButton } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, PasswordInput } from '@/ui/Field';
import { Flag } from '@/ui/Flag';
import { Logo } from '@/ui/Logo';
import { Menu, MenuDivider, MenuItem, MenuLabel } from '@/ui/Menu';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { type AdminPath, firstAdminPage } from './Admin';
import { ChannelSearch } from './ChannelSearch';

/** Open alerts, polled for the dot on the administration button. */
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

export function Shell() {
	const t = useT();
	const me = useMe();
	const path = useRouterState({ select: (state) => state.location.pathname });
	const alerts = useOpenAlerts();
	const [searching, setSearching] = useState(false);
	const [revealed, setRevealed] = useState(false);
	const admin = firstAdminPage(me);
	// On a recording the picture takes the whole window: the bar slides over it from the top edge.
	const studio = /^\/[^/]+\/\d+$/.test(path);
	const hidden = studio && !revealed;
	const header = useRef<HTMLElement>(null);

	// Shown over a recording: it goes away once the pointer moves below it.
	useEffect(() => {
		if (!studio || !revealed) return;
		const onMove = (event: PointerEvent) => {
			const bar = header.current;
			if (!bar || bar.contains(document.activeElement)) return;
			if (event.clientY > bar.getBoundingClientRect().bottom + 24) setRevealed(false);
		};
		document.addEventListener('pointermove', onMove);
		return () => {
			document.removeEventListener('pointermove', onMove);
		};
	}, [studio, revealed]);

	return (
		<div className="flex min-h-dvh flex-col">
			{hidden ? (
				<div
					aria-hidden
					className="fixed inset-x-0 top-0 z-50 h-3"
					onPointerEnter={() => {
						setRevealed(true);
					}}
				/>
			) : null}
			<header
				ref={header}
				onFocus={() => {
					if (studio) setRevealed(true);
				}}
				onBlur={(event) => {
					if (studio && !event.currentTarget.contains(event.relatedTarget)) setRevealed(false);
				}}
				className={`bg-bg/90 border-line z-40 border-b backdrop-blur-md transition-transform duration-200 ease-(--ease-out-soft) ${studio ? 'fixed inset-x-0 top-0' : 'sticky top-0'} ${hidden ? '-translate-y-full' : ''}`}
			>
				<div className="mx-auto flex h-16 max-w-[120rem] items-center gap-2 px-4 sm:gap-3 sm:px-6">
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
							<div className="flex items-center gap-1 max-lg:hidden">
								<ThemeButton />
								<LocaleMenu />
								{admin ? (
									<Link
										to={admin}
										aria-label={t.nav.admin}
										data-tip={t.nav.admin}
										aria-current={path.startsWith('/admin') ? 'page' : undefined}
										className="text-muted hover:text-ink hover:bg-surface aria-[current=page]:text-ink aria-[current=page]:bg-surface relative grid size-10 place-items-center rounded-sm transition-colors"
									>
										<ShieldCheck size={20} />
										{alerts > 0 ? (
											<span
												className="bg-danger absolute top-2 right-2 size-2 rounded-full"
												aria-hidden
											/>
										) : null}
									</Link>
								) : null}
							</div>
							<AccountMenu admin={admin} alerts={alerts} />
						</>
					)}
				</div>
			</header>
			<main className="flex-1">
				<Suspense fallback={<PageLoading />}>
					<Outlet />
				</Suspense>
			</main>
		</div>
	);
}

const THEMES: Theme[] = ['system', 'light', 'dark'];

/** One button that steps through system, light and dark. */
export function ThemeButton() {
	const t = useT();
	const theme = usePrefs((state) => state.theme);
	const setPrefs = usePrefs((state) => state.set);
	const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
	const label = t.nav.themeTip[theme];
	return (
		<IconButton
			label={label}
			onClick={() => {
				setPrefs({ theme: THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system' });
			}}
		>
			<Icon size={20} />
		</IconButton>
	);
}

function pickLocale(setPrefs: (changes: { locale: Locale }) => void, next: Locale) {
	setPrefs({ locale: next });
	// Remembered on the account too, for other devices.
	void api.patch('/me', { locale: next }).catch(() => undefined);
}

export function LocaleMenu() {
	const t = useT();
	const locale = useLocale();
	const setPrefs = usePrefs((state) => state.set);
	return (
		<Menu
			label={t.nav.language}
			trigger={(open) => (
				<IconButton label={t.nav.language} aria-expanded={open}>
					<Languages size={20} />
				</IconButton>
			)}
		>
			{(Object.keys(LOCALES) as Locale[]).map((value) => (
				<MenuItem
					key={value}
					icon={<Flag locale={value} size={18} />}
					checked={locale === value}
					onSelect={() => {
						pickLocale(setPrefs, value);
					}}
				>
					{LOCALES[value]}
				</MenuItem>
			))}
		</Menu>
	);
}

/**
 * The account, and below the large breakpoint the theme, the language and the administration too:
 * there they get their name, which an icon alone can't give on a touch screen.
 */
function AccountMenu({ admin, alerts }: { admin: AdminPath | null; alerts: number }) {
	const t = useT();
	const me = useMe();
	const navigate = useNavigate();
	const theme = usePrefs((state) => state.theme);
	const locale = useLocale();
	const setPrefs = usePrefs((state) => state.set);
	const themeIcons = { system: <Monitor size={16} />, light: <Sun size={16} />, dark: <Moon size={16} /> };
	const themeNames = { system: t.nav.themeSystem, light: t.nav.themeLight, dark: t.nav.themeDark };
	const client = useQueryClient();
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
						data-tip={t.nav.account}
						className={`hover:bg-surface flex h-10 flex-none items-center gap-2.5 rounded-sm px-1.5 transition-colors lg:pr-3 ${open ? 'bg-surface' : ''}`}
					>
						<span className="relative flex-none">
							<Avatar src={null} name={me.username} size={30} />
							{alerts > 0 ? (
								<span
									className="bg-danger ring-bg absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 lg:hidden"
									aria-hidden
								/>
							) : null}
						</span>
						<span className="text-ui hidden max-w-36 truncate font-medium lg:inline">{me.username}</span>
					</button>
				)}
			>
				<div className="px-2.5 pt-2 pb-2">
					<div className="text-ui font-semibold">{me.username}</div>
					<div className="text-caption text-muted">{t.users.roleNames[me.role] ?? me.role}</div>
				</div>
				<MenuDivider />
				<div className="lg:hidden">
					{admin ? (
						<>
							<MenuItem
								icon={<ShieldCheck size={16} />}
								onSelect={() => {
									void navigate({ to: admin });
								}}
							>
								<span className="flex items-center gap-2">
									{t.nav.admin}
									{alerts > 0 ? (
										<span className="bg-danger text-caption grid h-5 min-w-5 place-items-center rounded-full px-1.5 font-semibold text-white">
											{alerts}
										</span>
									) : null}
								</span>
							</MenuItem>
							<MenuDivider />
						</>
					) : null}
					<MenuLabel>{t.nav.theme}</MenuLabel>
					{THEMES.map((value) => (
						<MenuItem
							key={value}
							icon={themeIcons[value]}
							checked={theme === value}
							onSelect={() => {
								setPrefs({ theme: value });
							}}
						>
							{themeNames[value]}
						</MenuItem>
					))}
					<MenuLabel>{t.nav.language}</MenuLabel>
					{(Object.keys(LOCALES) as Locale[]).map((value) => (
						<MenuItem
							key={value}
							icon={<Flag locale={value} size={16} />}
							checked={locale === value}
							onSelect={() => {
								pickLocale(setPrefs, value);
							}}
						>
							{LOCALES[value]}
						</MenuItem>
					))}
					<MenuDivider />
				</div>
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
	const { busy, error, run } = useAction();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		await run(async () => {
			await api.patch('/me', { current_password: current, new_password: next });
			toast.ok(t.auth.passwordChanged);
			setCurrent('');
			setNext('');
			onClose();
		});
	};

	return (
		<Dialog open={open} onClose={onClose} title={t.nav.password}>
			<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
				<Field label={t.auth.currentPassword}>
					{(id) => (
						<PasswordInput
							id={id}
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
						<PasswordInput
							id={id}
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
					<Button type="submit" variant="accent" busy={busy}>
						<Check size={16} />
						{t.common.save}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
