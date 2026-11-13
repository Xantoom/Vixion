import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
	Ban,
	CircleCheck,
	Ellipsis,
	Film,
	Lock,
	Pencil,
	Plus,
	RotateCcw,
	ShieldCheck,
	Trash2,
	Tv,
	Users as UsersIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '@/i18n';
import { type Permission, type Role, type User, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button, IconButton } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Confirm, Dialog } from '@/ui/Dialog';
import { Field, KNOB, PasswordInput, SWITCH, Switch, TextInput } from '@/ui/Field';
import { Menu, MenuDivider, MenuItem } from '@/ui/Menu';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

interface RolesResponse {
	roles: Role[];
	permissions: Permission[];
}

type GroupKey = 'recordings' | 'channels' | 'admin';

/** Permissions by what they are about, in the order they are shown. */
const GROUPS: { key: GroupKey; icon: ReactNode; permissions: Permission[] }[] = [
	{
		key: 'recordings',
		icon: <Film size={15} />,
		permissions: ['streams.view', 'streams.download', 'streams.keep', 'streams.delete'],
	},
	{ key: 'channels', icon: <Tv size={15} />, permissions: ['streamers.manage'] },
	{
		key: 'admin',
		icon: <ShieldCheck size={15} />,
		permissions: ['stats.view', 'logs.view', 'users.manage', 'settings.manage'],
	},
];

/** The groups, keeping only the permissions the server knows, and any it knows that no group has. */
function grouped(known: Permission[]) {
	const listed = new Set(GROUPS.flatMap((group) => group.permissions));
	const groups = GROUPS.map((group) => ({
		...group,
		permissions: group.permissions.filter((permission) => known.includes(permission)),
	}));
	const rest = known.filter((permission) => !listed.has(permission));
	groups.at(-1)?.permissions.push(...rest);
	return groups.filter((group) => group.permissions.length > 0);
}

function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'accent' | 'muted' }) {
	const tones = {
		plain: 'bg-surface-2 text-ink-2',
		accent: 'bg-accent-soft text-accent-text',
		muted: 'bg-surface-2 text-muted',
	};
	return (
		<span
			className={`text-caption inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 font-semibold whitespace-nowrap ${tones[tone]}`}
		>
			{children}
		</span>
	);
}

function useRoleName() {
	const t = useT();
	return (role: Role | undefined) =>
		role ? (role.builtin ? (t.users.roleNames[role.builtin] ?? role.name) : role.name) : '';
}

/** What a role allows, a line per group: "Recordings watch, download". */
function RoleSummary({ role, known }: { role: Role; known: Permission[] }) {
	const t = useT();
	if (role.builtin === 'admin') {
		return (
			<span className="text-small text-ink-2 inline-flex items-center gap-1.5">
				<ShieldCheck size={14} className="text-accent-text" />
				{t.users.adminRole}
			</span>
		);
	}
	const lines = grouped(known)
		.map((group) => ({ ...group, granted: group.permissions.filter((p) => role.permissions.includes(p)) }))
		.filter((group) => group.granted.length > 0);
	if (lines.length === 0) return <span className="text-small text-muted">{t.users.noPermission}</span>;
	return (
		<ul className="text-small flex flex-col gap-1">
			{lines.map((group) => (
				<li key={group.key} className="flex min-w-0 items-baseline gap-2">
					<span className="text-muted inline-flex flex-none items-center gap-1.5 self-center">
						{group.icon}
						<span className="sr-only sm:not-sr-only">{t.users.groups[group.key]}</span>
					</span>
					<span className="text-ink-2 min-w-0">
						{group.granted.map((p) => t.users.permShort[p] ?? p).join(', ')}
					</span>
				</li>
			))}
		</ul>
	);
}

export function UsersPage() {
	const t = useT();
	const can = useCan('users.manage');
	const me = useMe();
	const users = useQuery({ queryKey: ['users'], queryFn: async () => api.get<User[]>('/users'), enabled: can });
	const roles = useQuery({
		queryKey: ['roles'],
		queryFn: async () => api.get<RolesResponse>('/roles'),
		enabled: can,
	});
	const roleName = useRoleName();
	const [editing, setEditing] = useState<User | 'new' | null>(null);
	const [deleting, setDeleting] = useState<User | null>(null);
	const [roleEditing, setRoleEditing] = useState<Role | 'new' | null>(null);
	const [roleDeleting, setRoleDeleting] = useState<Role | null>(null);
	const client = useQueryClient();
	const refresh = async () =>
		Promise.all([
			client.invalidateQueries({ queryKey: ['users'] }),
			client.invalidateQueries({ queryKey: ['roles'] }),
		]);

	if (!can) return <NotFound forbidden />;
	if (users.isPending || roles.isPending) return <PageLoading />;
	if (users.error || roles.error) return <p className="text-danger p-6">{(users.error ?? roles.error)?.message}</p>;

	const roleById = new Map(roles.data.roles.map((role) => [role.id, role]));
	const setDisabled = async (user: User, disabled: boolean) => {
		try {
			await api.patch(`/users/${user.id}`, { disabled });
			await refresh();
			toast.ok(t.common.saved);
		} catch (error) {
			toast.error(error);
		}
	};
	// The whole row opens the editor; the buttons inside it keep their own clicks.
	const row =
		'hover:bg-surface/60 flex cursor-pointer items-center gap-3.5 px-5 py-3.5 transition-colors duration-100';

	return (
		<div className="panel-in flex flex-col gap-6">
			<Card
				title={t.users.accounts}
				count={users.data.length}
				actions={
					<Button
						size="sm"
						variant="accent"
						onClick={() => {
							setEditing('new');
						}}
					>
						<Plus size={15} strokeWidth={2.4} />
						{t.users.add}
					</Button>
				}
				flush
			>
				<ul className="divide-line divide-y">
					{users.data.map((user) => {
						const exceptions = Object.keys(user.overrides).length;
						const self = user.id === me.id;
						return (
							<li
								key={user.id}
								className={row}
								onClick={(event) => {
									if (!(event.target as HTMLElement).closest('button, a')) setEditing(user);
								}}
							>
								<span className={user.disabled ? 'opacity-45 grayscale' : ''}>
									<Avatar src={null} name={user.username} size={36} />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-1.5">
									<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
										<button
											type="button"
											className="text-ui hover:text-accent-text truncate text-left font-semibold transition-colors"
											onClick={() => {
												setEditing(user);
											}}
										>
											{user.username}
										</button>
										{self ? <Chip>{t.users.you}</Chip> : null}
										{user.disabled ? (
											<Chip tone="muted">
												<Ban size={12} />
												{t.users.disabled}
											</Chip>
										) : null}
									</div>
									<div className="text-small text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
										<Chip tone="accent">{roleName(roleById.get(user.role_id))}</Chip>
										{exceptions > 0 ? <Chip>{t.users.exceptions(exceptions)}</Chip> : null}
										<span className="ml-1">
											{user.last_login_at
												? t.users.lastLoginAt(formatRelative(user.last_login_at))
												: t.users.neverSignedIn}
										</span>
									</div>
								</div>
								<Menu
									label={t.users.actionsFor(user.username)}
									trigger={() => (
										<IconButton size="sm" label={t.users.actionsFor(user.username)}>
											<Ellipsis size={18} />
										</IconButton>
									)}
								>
									<MenuItem
										icon={<Pencil size={16} />}
										onSelect={() => {
											setEditing(user);
										}}
									>
										{t.common.edit}
									</MenuItem>
									{self ? null : (
										<MenuItem
											icon={user.disabled ? <CircleCheck size={16} /> : <Ban size={16} />}
											onSelect={() => void setDisabled(user, !user.disabled)}
										>
											{user.disabled ? t.users.enable : t.users.disable}
										</MenuItem>
									)}
									<MenuDivider />
									<MenuItem
										icon={<Trash2 size={16} />}
										danger
										disabled={self}
										onSelect={() => {
											setDeleting(user);
										}}
									>
										{t.common.delete}
									</MenuItem>
								</Menu>
							</li>
						);
					})}
				</ul>
			</Card>

			<Card
				title={t.users.roles}
				count={roles.data.roles.length}
				actions={
					<Button
						size="sm"
						onClick={() => {
							setRoleEditing('new');
						}}
					>
						<Plus size={15} />
						{t.users.addRole}
					</Button>
				}
				flush
			>
				<ul className="divide-line divide-y">
					{roles.data.roles.map((role) => {
						const locked = role.builtin === 'admin';
						return (
							<li
								key={role.id}
								className={locked ? 'flex items-center gap-3.5 px-5 py-3.5' : row}
								onClick={(event) => {
									if (!locked && !(event.target as HTMLElement).closest('button, a'))
										setRoleEditing(role);
								}}
							>
								<div className="flex min-w-0 flex-1 flex-col gap-2">
									<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
										{locked ? (
											<span className="text-ui font-semibold">{roleName(role)}</span>
										) : (
											<button
												type="button"
												className="text-ui hover:text-accent-text text-left font-semibold transition-colors"
												onClick={() => {
													setRoleEditing(role);
												}}
											>
												{roleName(role)}
											</button>
										)}
										<span className="text-small text-muted tabular inline-flex items-center gap-1">
											<UsersIcon size={14} />
											{t.users.roleUsers(role.users)}
										</span>
									</div>
									<RoleSummary role={role} known={roles.data.permissions} />
								</div>
								{locked ? (
									<span
										className="text-muted grid size-8 flex-none place-items-center"
										data-tip={t.users.adminHint}
										aria-label={t.users.adminHint}
										role="img"
									>
										<Lock size={15} />
									</span>
								) : (
									<Menu
										label={t.users.actionsFor(roleName(role))}
										trigger={() => (
											<IconButton size="sm" label={t.users.actionsFor(roleName(role))}>
												<Ellipsis size={18} />
											</IconButton>
										)}
									>
										<MenuItem
											icon={<Pencil size={16} />}
											onSelect={() => {
												setRoleEditing(role);
											}}
										>
											{t.common.edit}
										</MenuItem>
										{role.builtin ? null : (
											<>
												<MenuDivider />
												<MenuItem
													icon={<Trash2 size={16} />}
													danger
													onSelect={() => {
														setRoleDeleting(role);
													}}
												>
													{t.common.delete}
												</MenuItem>
											</>
										)}
									</Menu>
								)}
							</li>
						);
					})}
				</ul>
			</Card>

			{editing ? (
				<UserDialog
					user={editing === 'new' ? null : editing}
					roles={roles.data}
					onClose={() => {
						setEditing(null);
					}}
					onSaved={refresh}
				/>
			) : null}
			{roleEditing ? (
				<RoleDialog
					role={roleEditing === 'new' ? null : roleEditing}
					permissions={roles.data.permissions}
					onClose={() => {
						setRoleEditing(null);
					}}
					onSaved={refresh}
				/>
			) : null}
			<Confirm
				open={deleting !== null}
				onClose={() => {
					setDeleting(null);
				}}
				title={t.users.deleteTitle(deleting?.username ?? '')}
				confirm={t.common.delete}
				onConfirm={async () => {
					try {
						await api.delete(`/users/${deleting?.id}`);
						await refresh();
					} catch (error) {
						toast.error(error);
						throw error;
					}
				}}
			>
				{t.users.deleteLead}
			</Confirm>
			<Confirm
				open={roleDeleting !== null}
				onClose={() => {
					setRoleDeleting(null);
				}}
				title={t.users.deleteRoleTitle(roleDeleting?.name ?? '')}
				confirm={t.common.delete}
				onConfirm={async () => {
					try {
						await api.delete(`/roles/${roleDeleting?.id}`);
						await refresh();
					} catch (error) {
						toast.error(error);
						throw error;
					}
				}}
			>
				{t.users.deleteRoleLead}
			</Confirm>
		</div>
	);
}

/** One permission with its explanation and a switch; `badge` sits beside the name, `action` under it. */
function PermissionRow({
	permission,
	checked,
	onChange,
	badge,
	action,
}: {
	permission: Permission;
	checked: boolean;
	onChange: (checked: boolean) => void;
	badge?: ReactNode;
	action?: ReactNode;
}) {
	const t = useT();
	const id = useId();
	return (
		<li className="flex items-center justify-between gap-4 py-2.5">
			<div className="flex min-w-0 flex-col gap-0.5">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<label htmlFor={id} className="text-ui text-ink cursor-pointer">
						{t.users.perm[permission] ?? permission}
					</label>
					{badge}
				</div>
				{t.users.permHint[permission] ? (
					<span className="text-small text-muted">{t.users.permHint[permission]}</span>
				) : null}
				{action}
			</div>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				onClick={() => {
					onChange(!checked);
				}}
				className={SWITCH}
			>
				<span className={`${KNOB} ${checked ? 'translate-x-5' : ''}`} />
			</button>
		</li>
	);
}

/** The permissions under their group's name; `row` draws each one. */
function PermissionGroups({ known, row }: { known: Permission[]; row: (permission: Permission) => ReactNode }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-4">
			{grouped(known).map((group) => (
				<section key={group.key} className="flex flex-col">
					<h3 className="text-caption text-muted flex items-center gap-1.5 pb-1 font-semibold tracking-wide uppercase">
						{group.icon}
						{t.users.groups[group.key]}
					</h3>
					<ul className="divide-line divide-y">{group.permissions.map(row)}</ul>
				</section>
			))}
		</div>
	);
}

/** Roles to pick from, each with what it allows. */
function RolePicker({
	roles,
	known,
	value,
	onChange,
}: {
	roles: Role[];
	known: Permission[];
	value: number;
	onChange: (id: number) => void;
}) {
	const t = useT();
	const roleName = useRoleName();
	const name = useId();
	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="text-ui mb-2 font-medium">{t.users.role}</legend>
			{roles.map((role) => (
				<label
					key={role.id}
					className="ring-line has-checked:ring-accent has-checked:bg-accent-soft/40 has-focus-visible:outline-accent flex cursor-pointer items-start gap-3 rounded-sm px-3.5 py-3 ring-1 transition-[background-color,box-shadow] duration-150 has-checked:ring-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
				>
					<input
						type="radio"
						name={name}
						checked={role.id === value}
						onChange={() => {
							onChange(role.id);
						}}
						className="mt-1 size-4 flex-none accent-[var(--accent)]"
					/>
					<span className="flex min-w-0 flex-col gap-1">
						<span className="text-ui font-semibold">{roleName(role)}</span>
						<RoleSummary role={role} known={known} />
					</span>
				</label>
			))}
		</fieldset>
	);
}

function UserDialog({
	user,
	roles,
	onClose,
	onSaved,
}: {
	user: User | null;
	roles: RolesResponse;
	onClose: () => void;
	onSaved: () => Promise<unknown>;
}) {
	const t = useT();
	const me = useMe();
	const formId = useId();
	const fallbackRole = roles.roles.find((role) => role.builtin === 'user')?.id ?? roles.roles[0]?.id ?? 0;
	const [username, setUsername] = useState(user?.username ?? '');
	const [password, setPassword] = useState('');
	const [roleId, setRoleId] = useState(user?.role_id ?? fallbackRole);
	const [disabled, setDisabled] = useState(user?.disabled ?? false);
	const [overrides, setOverrides] = useState<Partial<Record<Permission, boolean>>>(user?.overrides ?? {});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const role = roles.roles.find((entry) => entry.id === roleId);
	const isAdminRole = role?.builtin === 'admin';
	const fromRole = (permission: Permission) => role?.permissions.includes(permission) ?? false;
	// An exception the new role already gives is no exception any more.
	const exception = (permission: Permission) => {
		const value = overrides[permission];
		return value !== undefined && value !== fromRole(permission);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (user) {
				const changes = {} as Record<Permission, boolean | null>;
				for (const permission of roles.permissions)
					changes[permission] = exception(permission) ? (overrides[permission] ?? null) : null;
				await api.patch(`/users/${user.id}`, {
					role_id: roleId,
					disabled,
					overrides: changes,
					...(password ? { password } : {}),
				});
			} else {
				await api.post('/users', { username: username.trim(), password, role_id: roleId });
			}
			await onSaved();
			toast.ok(t.common.saved);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onClose={onClose}
			title={user ? t.users.editTitle(user.username) : t.users.add}
			wide
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button type="submit" form={formId} variant="accent" busy={busy}>
						{user ? t.common.save : t.common.create}
					</Button>
				</>
			}
		>
			<form id={formId} className="flex flex-col gap-6" onSubmit={(event) => void submit(event)}>
				<div className={`grid gap-5 ${user ? '' : 'sm:grid-cols-2'}`}>
					{user ? null : (
						<Field label={t.users.username}>
							{(id) => (
								<TextInput
									id={id}
									required
									autoFocus
									autoComplete="off"
									autoCapitalize="none"
									value={username}
									onChange={(event) => {
										setUsername(event.target.value);
									}}
								/>
							)}
						</Field>
					)}
					<Field
						label={user ? t.users.newPassword : t.users.password}
						hint={user ? t.users.newPasswordHint : t.auth.passwordHint}
					>
						{(id, describedBy) => (
							<PasswordInput
								id={id}
								autoComplete="new-password"
								required={!user}
								minLength={8}
								aria-describedby={describedBy}
								value={password}
								onChange={(event) => {
									setPassword(event.target.value);
								}}
							/>
						)}
					</Field>
				</div>
				<RolePicker
					roles={roles.roles.filter((entry) => entry.builtin !== 'admin' || me.admin)}
					known={roles.permissions}
					value={roleId}
					onChange={setRoleId}
				/>
				{user && user.id !== me.id ? (
					<Switch
						checked={disabled}
						onChange={setDisabled}
						label={t.users.disabledLabel}
						hint={t.users.disabledHint}
					/>
				) : null}
				{user && !isAdminRole ? (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-0.5">
							<span className="text-ui font-medium">{t.users.accountPermissions}</span>
							<span className="text-small text-muted">{t.users.accountPermissionsHint}</span>
						</div>
						<PermissionGroups
							known={roles.permissions}
							row={(permission) => {
								const changed = exception(permission);
								return (
									<PermissionRow
										key={permission}
										permission={permission}
										checked={changed ? (overrides[permission] ?? false) : fromRole(permission)}
										onChange={(checked) => {
											const copy = { ...overrides };
											if (checked === fromRole(permission)) delete copy[permission];
											else copy[permission] = checked;
											setOverrides(copy);
										}}
										badge={changed ? <Chip tone="accent">{t.users.exception}</Chip> : null}
										action={
											changed ? (
												<button
													type="button"
													className="text-small text-accent-text mt-1 inline-flex w-fit items-center gap-1 font-medium hover:underline"
													onClick={() => {
														const copy = { ...overrides };
														delete copy[permission];
														setOverrides(copy);
													}}
												>
													<RotateCcw size={13} />
													{t.users.backToRole}
												</button>
											) : null
										}
									/>
								);
							}}
						/>
					</div>
				) : null}
				{user && isAdminRole ? (
					<p className="text-small text-muted bg-surface flex items-center gap-2 rounded-sm px-3.5 py-3">
						<ShieldCheck size={16} className="text-accent-text flex-none" />
						{t.users.adminHint}
					</p>
				) : null}
				{error ? (
					<p className="text-small text-danger" role="alert">
						{error}
					</p>
				) : null}
			</form>
		</Dialog>
	);
}

function RoleDialog({
	role,
	permissions,
	onClose,
	onSaved,
}: {
	role: Role | null;
	permissions: Permission[];
	onClose: () => void;
	onSaved: () => Promise<unknown>;
}) {
	const t = useT();
	const roleName = useRoleName();
	const formId = useId();
	const [name, setName] = useState(role?.name ?? '');
	const [granted, setGranted] = useState<Set<Permission>>(new Set(role?.permissions ?? ['streams.view']));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const body = {
				name: name.trim(),
				permissions: permissions.filter((permission) => granted.has(permission)),
			};
			if (role) await api.patch(`/roles/${role.id}`, role.builtin ? { permissions: body.permissions } : body);
			else await api.post('/roles', body);
			await onSaved();
			toast.ok(t.common.saved);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onClose={onClose}
			title={role ? roleName(role) : t.users.addRole}
			wide
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button type="submit" form={formId} variant="accent" busy={busy}>
						{role ? t.common.save : t.common.create}
					</Button>
				</>
			}
		>
			<form id={formId} className="flex flex-col gap-6" onSubmit={(event) => void submit(event)}>
				{role?.builtin ? null : (
					<Field label={t.users.roleName}>
						{(id) => (
							<TextInput
								id={id}
								required
								autoFocus
								maxLength={40}
								value={name}
								onChange={(event) => {
									setName(event.target.value);
								}}
							/>
						)}
					</Field>
				)}
				{role ? (
					<p className="text-small text-muted -mt-2 inline-flex items-center gap-1.5">
						<UsersIcon size={14} />
						{t.users.roleUsers(role.users)}
					</p>
				) : null}
				<PermissionGroups
					known={permissions}
					row={(permission) => (
						<PermissionRow
							key={permission}
							permission={permission}
							checked={granted.has(permission)}
							onChange={(checked) => {
								const next = new Set(granted);
								if (checked) next.add(permission);
								else next.delete(permission);
								setGranted(next);
							}}
						/>
					)}
				/>
				{error ? (
					<p className="text-small text-danger" role="alert">
						{error}
					</p>
				) : null}
			</form>
		</Dialog>
	);
}
