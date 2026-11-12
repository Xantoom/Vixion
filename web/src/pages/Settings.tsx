import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { type Settings, type SettingsResponse, api } from '@/lib/api';
import { useCan } from '@/lib/session';
import { Button } from '@/ui/Button';
import { Field, NumberInput, Select, Switch, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';
import { PageHeader } from './Streamers';

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-line grid gap-4 border-t py-7 md:grid-cols-[14rem_1fr] md:gap-10">
			<h2 className="text-lead font-semibold">{title}</h2>
			<div className="flex max-w-2xl flex-col gap-6">{children}</div>
		</section>
	);
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-ui font-medium">{label}</span>
			{children}
			{hint ? <span className="text-small text-muted">{hint}</span> : null}
		</div>
	);
}

export function SettingsPage() {
	const t = useT();
	const can = useCan('settings.manage');
	const client = useQueryClient();
	const { data, isPending, error } = useQuery({
		queryKey: ['settings'],
		queryFn: async () => api.get<SettingsResponse>('/settings'),
		enabled: can,
	});
	const [draft, setDraft] = useState<Settings | null>(null);
	const [token, setToken] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (data) setDraft(data.settings);
	}, [data]);

	if (!can) return <NotFound forbidden />;
	if (isPending || !draft) return error ? <p className="text-danger p-6">{error.message}</p> : <PageLoading />;

	const set = (changes: Partial<Settings>) => {
		setDraft({ ...draft, ...changes });
	};
	const dirty = JSON.stringify(draft) !== JSON.stringify(data?.settings);

	const save = async () => {
		setBusy(true);
		try {
			const saved = await api.put<Settings>('/settings', draft);
			client.setQueryData<SettingsResponse>(['settings'], (old) => (old ? { ...old, settings: saved } : old));
			toast.ok(t.common.saved);
		} catch (caught) {
			toast.error(caught);
		} finally {
			setBusy(false);
		}
	};

	const saveToken = async (value: string | null) => {
		try {
			await api.put('/settings/twitch-token', { token: value });
			setToken('');
			await client.invalidateQueries({ queryKey: ['settings'] });
			toast.ok(t.common.saved);
		} catch (caught) {
			toast.error(caught);
		}
	};

	return (
		<div className="panel-in mx-auto max-w-5xl px-4 pb-28 sm:px-6">
			<PageHeader title={t.settings.title} />

			<Section title={t.settings.recording}>
				<p className="text-small text-muted -mb-2">{t.settings.quality}</p>
				<Switch
					checked={draft.h264_only}
					onChange={(h264_only) => {
						set({ h264_only });
					}}
					label={t.settings.h264Only}
					hint={t.settings.h264OnlyHint}
				/>
				<Switch
					checked={draft.record_chat}
					onChange={(record_chat) => {
						set({ record_chat });
					}}
					label={t.settings.recordChat}
				/>
				<Row label={t.settings.pollInterval}>
					<NumberInput
						aria-label={t.settings.pollInterval}
						value={draft.poll_interval}
						min={10}
						max={600}
						unit={t.settings.seconds}
						onChange={(poll_interval) => {
							set({ poll_interval });
						}}
					/>
				</Row>
			</Section>

			<Section title={t.settings.retention}>
				<Row label={t.settings.retentionDays} hint={t.settings.retentionHint}>
					<NumberInput
						aria-label={t.settings.retentionDays}
						value={draft.retention_days}
						min={0}
						max={3650}
						unit={t.common.days(draft.retention_days).replace(/^\d+\s*/, '')}
						onChange={(retention_days) => {
							set({ retention_days });
						}}
					/>
				</Row>
				<Row label={t.settings.diskWarning}>
					<NumberInput
						aria-label={t.settings.diskWarning}
						value={draft.disk_warning_gb}
						min={0}
						max={100_000}
						unit={t.settings.gb}
						onChange={(disk_warning_gb) => {
							set({ disk_warning_gb });
						}}
					/>
				</Row>
				<Row label={t.settings.diskReserve} hint={t.settings.diskReserveHint}>
					<NumberInput
						aria-label={t.settings.diskReserve}
						value={draft.disk_reserve_gb}
						min={1}
						max={100_000}
						unit={t.settings.gb}
						onChange={(disk_reserve_gb) => {
							set({ disk_reserve_gb });
						}}
					/>
				</Row>
			</Section>

			<Section title={t.settings.twitch}>
				<Row label={t.settings.token} hint={t.settings.tokenHint}>
					<p className={`text-small font-medium ${draft.has_twitch_token ? 'text-ok' : 'text-muted'}`}>
						{draft.has_twitch_token ? t.settings.tokenSet : t.settings.tokenNone}
					</p>
					<form
						className="flex flex-wrap gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void saveToken(token.trim());
						}}
					>
						<TextInput
							type="password"
							autoComplete="off"
							spellCheck={false}
							aria-label={t.settings.token}
							placeholder={t.settings.tokenPlaceholder}
							value={token}
							onChange={(event) => {
								setToken(event.target.value);
							}}
							className="max-w-sm flex-1 font-mono"
						/>
						<Button type="submit" disabled={token.trim().length < 20}>
							{t.settings.tokenSave}
						</Button>
						{draft.has_twitch_token ? (
							<Button variant="ghost" onClick={() => void saveToken(null)}>
								{t.settings.tokenClear}
							</Button>
						) : null}
					</form>
				</Row>
			</Section>

			<Section title={t.settings.alerts}>
				<Field label={t.settings.webhook} hint={t.settings.webhookHint}>
					{(id, describedBy) => (
						<div className="flex flex-wrap gap-2">
							<Select
								aria-label={t.settings.webhookKind}
								value={draft.webhook_kind}
								onChange={(event) => {
									set({ webhook_kind: event.target.value as Settings['webhook_kind'] });
								}}
								className="w-36"
							>
								<option value="discord">Discord</option>
								<option value="ntfy">ntfy</option>
								<option value="generic">JSON</option>
							</Select>
							<TextInput
								id={id}
								type="url"
								aria-describedby={describedBy}
								placeholder={t.settings.webhookPlaceholder}
								value={draft.webhook_url}
								onChange={(event) => {
									set({ webhook_url: event.target.value });
								}}
								className="min-w-60 flex-1"
							/>
						</div>
					)}
				</Field>
			</Section>

			<Section title={t.settings.system}>
				<dl className="text-small grid grid-cols-[auto_1fr] gap-x-8 gap-y-2.5">
					<dt className="text-muted">{t.settings.mediaMode}</dt>
					<dd className="font-mono">{data?.system.media_mode}</dd>
					<dt className="text-muted">{t.settings.mediaUrl}</dt>
					<dd className="font-mono break-all">{data?.system.media_url || t.settings.mediaSame}</dd>
					<dt className="text-muted">{t.settings.dataDir}</dt>
					<dd className="font-mono break-all">{data?.system.data_dir}</dd>
				</dl>
			</Section>

			{dirty ? (
				<div
					className="menu-in fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 md:bottom-6"
					data-up="true"
				>
					<div className="bg-tip text-tip-ink flex items-center gap-3 rounded-md py-2 pr-2 pl-5 shadow-2xl">
						<span className="text-ui">{t.common.unsaved}</span>
						<Button
							variant="ghost"
							className="!text-tip-ink hover:!bg-white/10"
							onClick={() => {
								setDraft(data?.settings ?? draft);
							}}
						>
							{t.common.cancel}
						</Button>
						<Button variant="accent" busy={busy} onClick={() => void save()}>
							{t.common.save}
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
