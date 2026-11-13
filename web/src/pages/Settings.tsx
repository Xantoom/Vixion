import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { type Settings, type SettingsResponse, api } from '@/lib/api';
import { useCan } from '@/lib/session';
import { Button } from '@/ui/Button';
import { Card, Facts, InfoTip, SettingRow, Toggle } from '@/ui/Card';
import { NumberInput, Select, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

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
		<div className="panel-in flex flex-col gap-6 pb-24">
			<Card title={t.settings.recording} flush>
				<SettingRow label={t.settings.h264Only} tip={t.settings.h264OnlyHint}>
					<Toggle
						label={t.settings.h264Only}
						checked={draft.h264_only}
						onChange={(h264_only) => {
							set({ h264_only });
						}}
					/>
				</SettingRow>
				<SettingRow label={t.settings.recordChat}>
					<Toggle
						label={t.settings.recordChat}
						checked={draft.record_chat}
						onChange={(record_chat) => {
							set({ record_chat });
						}}
					/>
				</SettingRow>
				<SettingRow label={t.settings.pollInterval}>
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
				</SettingRow>
			</Card>

			<Card title={t.settings.retention} flush>
				<SettingRow label={t.settings.retentionDays} tip={t.settings.retentionHint}>
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
				</SettingRow>
				<SettingRow label={t.settings.diskWarning}>
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
				</SettingRow>
				<SettingRow label={t.settings.diskReserve} tip={t.settings.diskReserveHint}>
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
				</SettingRow>
			</Card>

			<Card
				title={
					<>
						{t.settings.token}
						<InfoTip text={t.settings.tokenHint} />
					</>
				}
				actions={
					<span
						className={`text-small inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 font-semibold ${draft.has_twitch_token ? 'bg-ok/15 text-ok' : 'bg-surface-2 text-muted'}`}
					>
						{draft.has_twitch_token ? <Check size={14} /> : null}
						{draft.has_twitch_token ? t.settings.tokenSet : t.settings.tokenNone}
					</span>
				}
			>
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
						className="min-w-60 flex-1 font-mono"
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
			</Card>

			<Card
				title={
					<>
						{t.settings.alerts}
						<InfoTip text={t.settings.webhookHint} />
					</>
				}
			>
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
						type="url"
						aria-label={t.settings.webhook}
						placeholder={t.settings.webhookPlaceholder}
						value={draft.webhook_url}
						onChange={(event) => {
							set({ webhook_url: event.target.value });
						}}
						className="min-w-60 flex-1"
					/>
				</div>
			</Card>

			<Card title={t.settings.system} flush>
				<Facts
					items={[
						[t.settings.mediaMode, data?.system.media_mode ?? ''],
						[t.settings.mediaUrl, data?.system.media_url || t.settings.mediaSame],
						[t.settings.dataDir, data?.system.data_dir ?? ''],
					]}
				/>
			</Card>

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
