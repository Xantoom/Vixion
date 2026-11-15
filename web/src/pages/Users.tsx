import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lock, Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '@/i18n';
import { useAction } from '@/lib/action';
import { type Permission, type Role, type User, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Confirm, Dialog } from '@/ui/Dialog';
import { Field, PasswordInput, Select, TextInput } from '@/ui/Field';
import { Group, SwitchRow } from '@/ui/Group';
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

/** A titled list: the name above in small capitals, an add link beside it, the rows in a box. */
function Section({
	title,
	add,
	onAdd,
	children,
}: {
	title: string;
	add: string;
	onAdd: () => void;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<section className="flex flex-col gap-3">
			<div className="flex min-h-8 items-center justify-between gap-3 px-1">
				<h2 className="text-caption text-ink-2 font-semibold tracking-wider uppercase">{title}</h2>
				<button
					type="button"
					onClick={onAdd}
					aria-label={add}
					className="text-small text-accent-text touch-target relative -mr-1.5 inline-flex h-8 items-center gap-1 rounded-xs px-1.5 font-semibold hover:underline"
				>
					<Plus size={15} strokeWidth={2.4} />
					{t.common.add}
				</button>
			</div>
			<ul className="bg-card ring-line divide-line divide-y overflow-hidden rounded-md ring-1">{children}</ul>
		</section>
	);
}

/** A list row: what it is on the left, one short fact on the right, and the whole row opens it. */
function Row({ onClick, children, aside }: { onClick?: () => void; children: ReactNode; aside: ReactNode }) {
	const inner = 'flex min-h-16 w-full items-center gap-3.5 px-5 py-3 text-left';
	const content = (
		<>
			{children}
			<span className="text-small text-muted ml-auto flex flex-none items-center gap-1.5 pl-2">{aside}</span>
		</>
	);
	if (!onClick) return <li className={inner}>{content}</li>;
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={`${inner} hover:bg-surface focus-visible:bg-surface transition-colors duration-100 outline-none`}
			>
				{content}
				<ChevronRight size={18} className="text-muted -mr-1 flex-none" />
			</button>
		</li>
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
		<div className="panel-in flex flex-col gap-8">
			<Section
				title={t.users.accounts}
				add={t.users.add}
				onAdd={() => {
					setEditing('new');
				}}
			>
				{users.data.map((user) => (
					<Row
						key={user.id}
						onClick={() => {
							setEditing(user);
						}}
						aside={user.disabled ? t.users.disabled : roleName(roleById.get(user.role_id))}
					>
						<span className={`flex-none ${user.disabled ? 'opacity-40 grayscale' : ''}`}>
							<Avatar src={null} name={user.username} size={32} />
						</span>
						<span className={`text-ui min-w-0 truncate font-medium ${user.disabled ? 'text-muted' : ''}`}>
							{user.username}
							{user.id === me.id ? (
								<span className="text-muted font-normal"> · {t.users.you}</span>
							) : null}
						</span>
					</Row>
				))}
			</Section>

			<Section
				title={t.users.roles}
				add={t.users.addRole}
				onAdd={() => {
					setRoleEditing('new');
				}}
			>
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
							aside={
								admin ? (
									<>
										{t.users.adminRole}
										<Lock size={15} aria-hidden />
									</>
								) : (
									t.users.rights(role.permissions.length)
								)
							}
						>
							<span className="text-ui min-w-0 truncate font-medium">{roleName(role)}</span>
						</Row>
					);
				})}
			</Section>

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
	return (
		<SwitchRow
			label={t.users.perm[permission] ?? permission}
			checked={checked}
			onChange={onChange}
			badge={
				changed ? (
					<span className="bg-accent size-1.5 flex-none rounded-full" title={t.users.changed}>
						<span className="sr-only">{t.users.changed}</span>
					</span>
				) : null
			}
		/>
	);
}

/** The permissions under their group's name; `item` draws each one. */
function PermissionList({ known, item }: { known: Permission[]; item: (permission: Permission) => ReactNode }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-7">
			{grouped(known).map((group) => (
				<Group key={group.key} title={t.users.groups[group.key]}>
					{group.permissions.map(item)}
				</Group>
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
				<Button variant="danger-ghost" className="mr-auto -ml-3" onClick={onDelete}>
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
	const { busy, error, run } = useAction();
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
		await run(async () => {
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
		});
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
			<form id={formId} className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
				{user ? (
					<p className="text-small text-muted -mt-1 -mb-1">
						{user.last_login_at
							? t.users.lastLoginAt(formatRelative(user.last_login_at))
							: t.users.neverSignedIn}
					</p>
				) : null}
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
					<Group>
						<SwitchRow label={t.users.active} checked={active} onChange={setActive} />
					</Group>
				) : null}
				{user && role?.builtin !== 'admin' ? (
					<details className="group fold" open={exceptions > 0 || undefined}>
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
									className="reveal text-small text-accent-text w-fit font-medium hover:underline"
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
					<p className="text-small text-danger reveal" role="alert">
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
				/>
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
	const { busy, error, run } = useAction();
	const [deleting, setDeleting] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		await run(async () => {
			const body = {
				name: name.trim(),
				permissions: permissions.filter((permission) => granted.has(permission)),
			};
			if (role) await api.patch(`/roles/${role.id}`, role.builtin ? { permissions: body.permissions } : body);
			else await api.post('/roles', body);
			await onSaved();
			toast.ok(t.common.saved);
			onClose();
		});
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
			<form id={formId} className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
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
					<p className="text-small text-danger reveal" role="alert">
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
