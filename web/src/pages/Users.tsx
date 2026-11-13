import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useT } from '@/i18n';
import { type Permission, type Role, type User, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button, IconButton } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Confirm, Dialog } from '@/ui/Dialog';
import { Field, PasswordInput, Segmented, Select, Switch, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

interface RolesResponse {
	roles: Role[];
	permissions: Permission[];
}

function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'accent' | 'muted' }) {
	const tones = {
		plain: 'bg-surface-2 text-ink-2',
		accent: 'bg-accent-soft text-accent-text',
		muted: 'bg-surface-2 text-muted',
	};
	return (
		<span className={`text-caption inline-flex items-center rounded-xs px-1.5 py-0.5 font-semibold ${tones[tone]}`}>
			{children}
		</span>
	);
}

function useRoleName() {
	const t = useT();
	return (role: Role | undefined) =>
		role ? (role.builtin ? (t.users.roleNames[role.builtin] ?? role.name) : role.name) : '';
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
					{users.data.map((user) => (
						<li key={user.id} className="flex items-center gap-3.5 px-5 py-3">
							<Avatar src={null} name={user.username} size={36} />
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
									<span className="text-ui truncate font-semibold">{user.username}</span>
									{user.id === me.id ? <Chip>{t.users.you}</Chip> : null}
									{user.disabled ? <Chip tone="muted">{t.users.disabled}</Chip> : null}
								</div>
								<div className="text-small text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
									<Chip tone="accent">
										{roleName(roleById.get(user.role_id))}
										{Object.keys(user.overrides).length > 0 ? ' +' : ''}
									</Chip>
									<span>
										{user.last_login_at
											? t.users.lastLoginAt(formatRelative(user.last_login_at))
											: t.users.neverSignedIn}
									</span>
								</div>
							</div>
							<div className="flex flex-none">
								<IconButton
									size="sm"
									label={t.common.edit}
									onClick={() => {
										setEditing(user);
									}}
								>
									<Pencil size={16} />
								</IconButton>
								<IconButton
									size="sm"
									label={user.id === me.id ? t.users.cantDeleteSelf : t.common.delete}
									aria-disabled={user.id === me.id || undefined}
									className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&:not([aria-disabled])]:hover:!text-danger"
									onClick={() => {
										if (user.id !== me.id) setDeleting(user);
									}}
								>
									<Trash2 size={16} />
								</IconButton>
							</div>
						</li>
					))}
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
					{roles.data.roles.map((role) => (
						<li key={role.id} className="flex items-center gap-3.5 px-5 py-3.5">
							<div className="flex min-w-0 flex-1 flex-col gap-2">
								<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
									<span className="text-ui font-semibold">{roleName(role)}</span>
									<span className="text-small text-muted tabular inline-flex items-center gap-1">
										<UsersIcon size={14} />
										{t.users.roleUsers(role.users)}
									</span>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{role.builtin === 'admin' ? (
										<Chip tone="accent">{t.users.adminRole}</Chip>
									) : role.permissions.length === 0 ? (
										<span className="text-small text-muted">{t.common.none}</span>
									) : (
										role.permissions.map((permission) => (
											<Chip key={permission}>{t.users.perm[permission] ?? permission}</Chip>
										))
									)}
								</div>
							</div>
							<div className="flex flex-none">
								{role.builtin === 'admin' ? (
									<span className="size-8" aria-hidden />
								) : (
									<IconButton
										size="sm"
										label={t.common.edit}
										onClick={() => {
											setRoleEditing(role);
										}}
									>
										<Pencil size={16} />
									</IconButton>
								)}
								{role.builtin ? (
									<span className="size-8" aria-hidden />
								) : (
									<IconButton
										size="sm"
										label={t.common.delete}
										className="hover:!text-danger"
										onClick={() => {
											setRoleDeleting(role);
										}}
									>
										<Trash2 size={16} />
									</IconButton>
								)}
							</div>
						</li>
					))}
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

type Override = 'role' | 'allow' | 'deny';

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

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (user) {
				const changes: Record<Permission, boolean | null> = {} as Record<Permission, boolean | null>;
				for (const permission of roles.permissions) changes[permission] = overrides[permission] ?? null;
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
		<Dialog open onClose={onClose} title={user ? t.users.editTitle(user.username) : t.users.add} wide>
			<form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
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
				<Field label={t.users.role}>
					{(id) => (
						<Select
							id={id}
							value={roleId}
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
				{user && user.id !== me.id ? (
					<Switch checked={disabled} onChange={setDisabled} label={t.users.disabled} />
				) : null}
				{user && !isAdminRole ? (
					<div className="flex flex-col gap-2">
						<span className="text-ui font-medium">{t.users.permissions}</span>
						<span className="text-small text-muted -mt-1">{t.users.permissionsHint}</span>
						<ul className="divide-line border-line divide-y rounded-sm border">
							{roles.permissions.map((permission) => {
								const fromRole = role?.permissions.includes(permission) ?? false;
								const value: Override =
									overrides[permission] === undefined
										? 'role'
										: overrides[permission]
											? 'allow'
											: 'deny';
								return (
									<li
										key={permission}
										className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
									>
										<span className="text-small">
											{t.users.perm[permission] ?? permission}
											{value === 'role' ? (
												<span className={`ml-2 ${fromRole ? 'text-ok' : 'text-muted'}`}>
													{fromRole ? t.common.on : t.common.off}
												</span>
											) : null}
										</span>
										<Segmented
											label={t.users.perm[permission] ?? permission}
											value={value}
											onChange={(next) => {
												const copy = { ...overrides };
												if (next === 'role') delete copy[permission];
												else copy[permission] = next === 'allow';
												setOverrides(copy);
											}}
											options={[
												{ value: 'role', label: t.users.followRole },
												{ value: 'allow', label: t.users.allow },
												{ value: 'deny', label: t.users.deny },
											]}
										/>
									</li>
								);
							})}
						</ul>
					</div>
				) : null}
				{error ? (
					<p className="text-small text-danger" role="alert">
						{error}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button type="submit" variant="accent" busy={busy}>
						{user ? t.common.save : t.common.create}
					</Button>
				</div>
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
			title={role ? (role.builtin ? (t.users.roleNames[role.builtin] ?? role.name) : role.name) : t.users.addRole}
		>
			<form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
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
				<div className="flex flex-col gap-3.5">
					<span className="text-ui font-medium">{t.users.permissions}</span>
					{permissions.map((permission) => (
						<Switch
							key={permission}
							checked={granted.has(permission)}
							label={<span className="font-normal">{t.users.perm[permission] ?? permission}</span>}
							onChange={(checked) => {
								const next = new Set(granted);
								if (checked) next.add(permission);
								else next.delete(permission);
								setGranted(next);
							}}
						/>
					))}
				</div>
				{error ? (
					<p className="text-small text-danger" role="alert">
						{error}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button type="submit" variant="accent" busy={busy}>
						{role ? t.common.save : t.common.create}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
