import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { currentLocale, useT } from '@/i18n';
import { useAction } from '@/lib/action';
import { ApiError, type Me, api } from '@/lib/api';
import { meQuery } from '@/lib/session';
import { Button } from '@/ui/Button';
import { Field, PasswordInput, TextInput } from '@/ui/Field';
import { Logo } from '@/ui/Logo';
import { LocaleMenu, ThemeButton } from './Shell';

function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
	return (
		<main className="relative grid min-h-dvh place-items-center px-4 py-16">
			<div className="absolute top-3 right-3 flex items-center gap-1 sm:top-4 sm:right-4">
				<ThemeButton />
				<LocaleMenu />
			</div>
			<div className="panel-in w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-4 text-center">
					<Logo size={44} />
					<div>
						<h1 className="text-heading font-semibold tracking-tight">{title}</h1>
						<p className="text-ui text-ink-2 mt-2">{lead}</p>
					</div>
				</div>
				<div className="bg-card ring-line rounded-md p-6 shadow-(--shadow-card) ring-1">{children}</div>
			</div>
		</main>
	);
}

export function SetupPage() {
	const t = useT();
	const client = useQueryClient();
	const [code, setCode] = useState('');
	const [codeError, setCodeError] = useState<string | null>(null);
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const { busy, error, setError, run } = useAction();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (password !== confirm) {
			setError(t.auth.mismatch);
			return;
		}
		setCodeError(null);
		await run(
			async () => {
				await api.post('/setup', { code, username, password, locale: currentLocale() });
				client.setQueryData(['setup'], { needed: false });
				await client.invalidateQueries({ queryKey: meQuery.queryKey });
			},
			(caught) => {
				const code = caught instanceof ApiError ? caught.code : '';
				if (code !== 'bad_setup_code' && code !== 'too_many_attempts') return undefined;
				setCodeError(code === 'bad_setup_code' ? t.auth.badSetupCode : t.auth.tooMany);
				return null;
			},
		);
	};

	return (
		<AuthFrame title={t.auth.setupTitle} lead={t.auth.setupLead}>
			<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
				<Field label={t.auth.setupCode} hint={t.auth.setupCodeHint} error={codeError}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							autoComplete="off"
							autoCapitalize="characters"
							spellCheck={false}
							required
							autoFocus
							placeholder="XXXX-XXXX"
							aria-describedby={describedBy}
							className="font-mono uppercase"
							value={code}
							onChange={(event) => {
								setCode(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.username}>
					{(id) => (
						<TextInput
							id={id}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
							required
							value={username}
							onChange={(event) => {
								setUsername(event.target.value);
							}}
						/>
					)}
				</Field>
				<Field label={t.auth.password} hint={t.auth.passwordHint}>
					{(id, describedBy) => (
						<PasswordInput
							id={id}
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
						<PasswordInput
							id={id}
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
	const { busy, error, run } = useAction();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		await run(
			async () => {
				await api.post('/auth/login', { username, password });
				client.setQueryData(meQuery.queryKey, await api.get<Me>('/me'));
			},
			(caught) => {
				setPassword('');
				const code = caught instanceof ApiError ? caught.code : '';
				return code === 'bad_credentials'
					? t.auth.wrongPassword
					: code === 'too_many_attempts'
						? t.auth.tooMany
						: undefined;
			},
		);
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
						<PasswordInput
							id={id}
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
