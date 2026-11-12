import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { currentLocale, useT } from '@/i18n';
import { type Me, api } from '@/lib/api';
import { meQuery } from '@/lib/session';
import { Button } from '@/ui/Button';
import { Field, TextInput } from '@/ui/Field';
import { Logo } from '@/ui/Logo';

function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
	return (
		<main className="bg-canvas grid min-h-dvh place-items-center px-4 py-10">
			<div className="panel-in w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-4 text-center">
					<Logo size={44} />
					<div>
						<h1 className="text-heading font-semibold tracking-tight">{title}</h1>
						<p className="text-ui text-muted mt-2">{lead}</p>
					</div>
				</div>
				<div className="bg-bg border-line rounded-md border p-6 shadow-sm">{children}</div>
			</div>
		</main>
	);
}

export function SetupPage() {
	const t = useT();
	const client = useQueryClient();
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (password !== confirm) {
			setError(t.auth.mismatch);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.post('/setup', { username, password, locale: currentLocale() });
			client.setQueryData(['setup'], { needed: false });
			await client.invalidateQueries({ queryKey: meQuery.queryKey });
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthFrame title={t.auth.setupTitle} lead={t.auth.setupLead}>
			<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
				<Field label={t.auth.username}>
					{(id) => (
						<TextInput
							id={id}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
							required
							autoFocus
							value={username}
							onChange={(event) => {
								setUsername(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.password} hint={t.auth.passwordHint}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							aria-describedby={describedBy}
							value={password}
							onChange={(event) => {
								setPassword(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.passwordConfirm} error={error}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							type="password"
							autoComplete="new-password"
							required
							aria-describedby={describedBy}
							value={confirm}
							onChange={(event) => {
								setConfirm(event.target.value);
							}}
						/>
					)}
				</Field>
				<Button type="submit" variant="accent" busy={busy} className="mt-2">
					{t.auth.createAdmin}
				</Button>
			</form>
		</AuthFrame>
	);
}

export function LoginPage() {
	const t = useT();
	const client = useQueryClient();
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post('/auth/login', { username, password });
			const me = await api.get<Me>('/me');
			client.setQueryData(meQuery.queryKey, me);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
			setPassword('');
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthFrame title={t.auth.loginTitle} lead={t.auth.loginLead}>
			<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
				<Field label={t.auth.username}>
					{(id) => (
						<TextInput
							id={id}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
							required
							autoFocus
							value={username}
							onChange={(event) => {
								setUsername(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.password} error={error}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							type="password"
							autoComplete="current-password"
							required
							aria-describedby={describedBy}
							value={password}
							onChange={(event) => {
								setPassword(event.target.value);
							}}
						/>
					)}
				</Field>
				<Button type="submit" variant="accent" busy={busy} className="mt-2">
					{t.auth.signIn}
				</Button>
			</form>
		</AuthFrame>
	);
}
