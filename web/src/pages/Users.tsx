import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lock, Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '@/i18n';
import { type Permission, type Role, type User, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Confirm, Dialog } from '@/ui/Dialog';
import { Field, KNOB, PasswordInput, SWITCH, Select, Switch, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

interface RolesResponse {
	roles: Role[];
	permissions: Permission[];
}

/** Permissions by what they are about, in the order they are shown. */
const GROUPS: { key: 'recordings' | 'channels' | 'admin'; permissions: Permission[] }[] = [
	{ key: 'recordings', permissions: ['streams.view', 'streams.download', 'streams.keep', 'streams.delete'] },
	{ key: 'channels', permissions: ['streamers.manage'] },
	{ key: 'admin', permissions: ['stats.view', 'logs.view', 'users.manage', 'settings.manage'] },
];

/** The groups, keeping only the permissions the server knows, and any it knows that no group has. */
function grouped(known: Permission[]) {
	const listed = new Set(GROUPS.flatMap((group) => group.permissions));
	const groups = GROUPS.map((group) => ({
		...group,
		permissions: group.permissions.filter((permission) => known.includes(permission)),
	}));
	groups.at(-1)?.permissions.push(...known.filter((permission) => !listed.has(permission)));
	return groups.filter((group) => group.permissions.length > 0);
}

function useRoleName() {
	const t = useT();
	return (role: Role | undefined) =>
		role ? (role.builtin ? (t.users.roleNames[role.builtin] ?? role.name) : role.name) : '';
}

/** A list row that opens something: the whole row is the button. */
function Row({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
	const inner = 'flex min-h-16 w-full items-center gap-3.5 px-5 py-3 text-left';
	if (!onClick) return <li className={inner}>{children}</li>;
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={`${inner} group hover:bg-surface focus-visible:bg-surface transition-colors duration-100 outline-none`}
			>
				{children}
				<ChevronRight
					size={18}
					className="text-muted flex-none transition-transform duration-150 group-hover:translate-x-0.5"
				/>
			</button>
		</li>
	);
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<Button size="sm" onClick={onClick} aria-label={label}>
			<Plus size={15} />
			<span className="max-sm:hidden">{label}</span>
		</Button>
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
	const [roleEditing, setRoleEditing] = useState<Role | 'new' | null>(null);
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

	return (
		<div className="panel-in flex flex-col gap-6">
			<Card
				title={t.users.accounts}
				count={users.data.length}
				actions={
					<AddButton
						label={t.users.add}
						onClick={() => {
							setEditing('new');
						}}
					/>
				}
				flush
			>
				<ul className="divide-line divide-y">
					{users.data.map((user) => (
						<Row
							key={user.id}
							onClick={() => {
								setEditing(user);
							}}
						>
							<span className={`flex-none ${user.disabled ? 'opacity-40 grayscale' : ''}`}>
								<Avatar src={null} name={user.username} size={36} />
							</span>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-ui truncate font-semibold">
									{user.username}
									{user.id === me.id ? (
										<span className="text-muted font-normal"> ({t.users.you})</span>
									) : null}
								</span>
								<span className="text-small text-muted truncate">
									{user.disabled
										? t.users.disabled
										: [
												roleName(roleById.get(user.role_id)),
												user.last_login_at
													? t.users.lastLoginAt(formatRelative(user.last_login_at))
													: t.users.neverSignedIn,
											].join(' · ')}
								</span>
							</span>
						</Row>
					))}
				</ul>
			</Card>

			<Card
				title={t.users.roles}
				count={roles.data.roles.length}
				actions={
					<AddButton
						label={t.users.addRole}
						onClick={() => {
							setRoleEditing('new');
						}}
					/>
				}
				flush
			>
				<ul className="divide-line divide-y">
					{roles.data.roles.map((role) => {
						const admin = role.builtin === 'admin';
						return (
							<Row
								key={role.id}
								onClick={
									admin
										? undefined
										: () => {
												setRoleEditing(role);
											}
								}
							>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="text-ui truncate font-semibold">{roleName(role)}</span>
									<span className="text-small text-muted truncate">
										{admin ? t.users.adminRole : t.users.rights(role.permissions.length)} ·{' '}
										{t.users.roleUsers(role.users)}
									</span>
								</span>
								{admin ? <Lock size={16} className="text-muted flex-none" aria-hidden /> : null}
							</Row>
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
		</div>
	);
}

/** A permission's switch; `changed` marks one that differs from the role. */
function PermissionSwitch({
	permission,
	checked,
	onChange,
	changed = false,
}: {
	permission: Permission;
	checked: boolean;
	onChange: (checked: boolean) => void;
	changed?: boolean;
}) {
	const t = useT();
	const id = useId();
	return (
		<li className="flex min-h-12 items-center justify-between gap-4 px-4">
			<label htmlFor={id} className="text-ui text-ink flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-3">
				{t.users.perm[permission] ?? permission}
				{changed ? (
					<span className="bg-accent size-1.5 flex-none rounded-full" title={t.users.changed}>
						<span className="sr-only">{t.users.changed}</span>
					</span>
				) : null}
			</label>
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

/** The permissions under their group's name; `item` draws each one. */
function PermissionList({ known, item }: { known: Permission[]; item: (permission: Permission) => ReactNode }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-5">
			{grouped(known).map((group) => (
				<section key={group.key} className="flex flex-col gap-2">
					<h3 className="text-caption text-ink-2 px-1 font-semibold tracking-wider uppercase">
						{t.users.groups[group.key]}
					</h3>
					<ul className="bg-surface ring-line divide-line divide-y rounded-md ring-1">
						{group.permissions.map(item)}
					</ul>
				</section>
			))}
		</div>
	);
}

/** Cancel and save, with a delete on the other side when there is something to delete. */
function Footer({
	formId,
	busy,
	creating,
	onClose,
	onDelete,
}: {
	formId: string;
	busy: boolean;
	creating: boolean;
	onClose: () => void;
	onDelete?: () => void;
}) {
	const t = useT();
	return (
		<>
			{onDelete ? (
				<Button variant="ghost" className="text-danger mr-auto -ml-3" onClick={onDelete}>
					{t.common.delete}
				</Button>
			) : null}
			<Button variant="ghost" onClick={onClose}>
				{t.common.cancel}
			</Button>
			<Button type="submit" form={formId} variant="accent" busy={busy}>
				{creating ? t.common.create : t.common.save}
			</Button>
		</>
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
	const roleName = useRoleName();
	const formId = useId();
	const fallbackRole = roles.roles.find((role) => role.builtin === 'user')?.id ?? roles.roles[0]?.id ?? 0;
	const [username, setUsername] = useState(user?.username ?? '');
	const [password, setPassword] = useState('');
	const [roleId, setRoleId] = useState(user?.role_id ?? fallbackRole);
	const [active, setActive] = useState(!(user?.disabled ?? false));
	const [overrides, setOverrides] = useState<Partial<Record<Permission, boolean>>>(user?.overrides ?? {});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const self = user?.id === me.id;
	const role = roles.roles.find((entry) => entry.id === roleId);
	const fromRole = (permission: Permission) => role?.permissions.includes(permission) ?? false;
	// An exception the role already gives is no exception.
	const changed = (permission: Permission) => {
		const value = overrides[permission];
		return value !== undefined && value !== fromRole(permission);
	};
	const exceptions = roles.permissions.filter(changed).length;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (user) {
				const changes = {} as Record<Permission, boolean | null>;
				for (const permission of roles.permissions)
					changes[permission] = changed(permission) ? (overrides[permission] ?? null) : null;
				await api.patch(`/users/${user.id}`, {
					role_id: roleId,
					disabled: !active,
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
			title={user ? user.username : t.users.add}
			footer={
				<Footer
					formId={formId}
					busy={busy}
					creating={!user}
					onClose={onClose}
					onDelete={
						user && !self
							? () => {
									setDeleting(true);
								}
							: undefined
					}
				/>
			}
		>
			<form id={formId} className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
				{user ? null : (
					<Field label={t.users.username}>
						{(id) => (
							<TextInput
								id={id}
								required
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
				<Field label={t.users.role}>
					{(id) => (
						<Select
							id={id}
							value={roleId}
							disabled={self}
							onChange={(event) => {
								setRoleId(Number(event.target.value));
							}}
						>
							{roles.roles
								.filter((entry) => entry.builtin !== 'admin' || me.admin)
								.map((entry) => (
									<option key={entry.id} value={entry.id}>
										{roleName(entry)}
									</option>
								))}
						</Select>
					)}
				</Field>
				{user && !self ? (
					<div className="bg-surface ring-line rounded-md px-4 py-3 ring-1">
						<Switch checked={active} onChange={setActive} label={t.users.active} />
					</div>
				) : null}
				{user && role?.builtin !== 'admin' ? (
					<details className="group" open={exceptions > 0 || undefined}>
						<summary className="text-ui text-ink bg-surface ring-line hover:bg-surface-2 flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-md px-4 font-medium ring-1 transition-colors [&::-webkit-details-marker]:hidden">
							{t.users.customPermissions}
							{exceptions > 0 ? (
								<span className="text-small text-accent-text font-normal">
									{t.users.exceptions(exceptions)}
								</span>
							) : null}
							<ChevronDown
								size={18}
								className="text-muted ml-auto transition-transform duration-150 group-open:rotate-180"
							/>
						</summary>
						<div className="flex flex-col gap-4 pt-5">
							<PermissionList
								known={roles.permissions}
								item={(permission) => (
									<PermissionSwitch
										key={permission}
										permission={permission}
										changed={changed(permission)}
										checked={
											changed(permission)
												? (overrides[permission] ?? false)
												: fromRole(permission)
										}
										onChange={(checked) => {
											const copy = { ...overrides };
											if (checked === fromRole(permission)) delete copy[permission];
											else copy[permission] = checked;
											setOverrides(copy);
										}}
									/>
								)}
							/>
							{exceptions > 0 ? (
								<button
									type="button"
									className="text-small text-accent-text w-fit font-medium hover:underline"
									onClick={() => {
										setOverrides({});
									}}
								>
									{t.users.resetToRole}
								</button>
							) : null}
						</div>
					</details>
				) : null}
				{error ? (
					<p className="text-small text-danger" role="alert">
						{error}
					</p>
				) : null}
			</form>
			{user ? (
				<Confirm
					open={deleting}
					onClose={() => {
						setDeleting(false);
					}}
					title={t.users.deleteTitle(user.username)}
					confirm={t.common.delete}
					onConfirm={async () => {
						try {
							await api.delete(`/users/${user.id}`);
							await onSaved();
							onClose();
						} catch (caught) {
							toast.error(caught);
							throw caught;
						}
					}}
				>
					{t.users.deleteLead}
				</Confirm>
			) : null}
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
	const [deleting, setDeleting] = useState(false);

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
			footer={
				<Footer
					formId={formId}
					busy={busy}
					creating={!role}
					onClose={onClose}
					onDelete={
						role && !role.builtin
							? () => {
									setDeleting(true);
								}
							: undefined
					}
				/>
			}
		>
			<form id={formId} className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
				{role?.builtin ? null : (
					<Field label={t.users.roleName}>
						{(id) => (
							<TextInput
								id={id}
								required
								maxLength={40}
								value={name}
								onChange={(event) => {
									setName(event.target.value);
								}}
							/>
						)}
					</Field>
				)}
				<PermissionList
					known={permissions}
					item={(permission) => (
						<PermissionSwitch
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
			{role ? (
				<Confirm
					open={deleting}
					onClose={() => {
						setDeleting(false);
					}}
					title={t.users.deleteRoleTitle(roleName(role))}
					confirm={t.common.delete}
					onConfirm={async () => {
						try {
							await api.delete(`/roles/${role.id}`);
							await onSaved();
							onClose();
						} catch (caught) {
							toast.error(caught);
							throw caught;
						}
					}}
				>
					{t.users.deleteRoleLead}
				</Confirm>
			) : null}
		</Dialog>
	);
}
