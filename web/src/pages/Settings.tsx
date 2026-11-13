import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { type Settings, type SettingsResponse, api } from '@/lib/api';
import { useCan } from '@/lib/session';
import { Button, IconButton } from '@/ui/Button';
import { Card, Facts, SettingRow, Toggle } from '@/ui/Card';
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

			<Card title={t.settings.twitch} flush>
				<SettingRow
					wide
					label={t.settings.token}
					tip={draft.twitch_token_source === 'stored' ? t.settings.tokenStoredHint : t.settings.tokenHint}
				>
					{draft.twitch_token_source ? (
						<TokenField />
					) : (
						<span className="text-small bg-surface-2 text-muted inline-flex h-8 items-center rounded-xs px-2.5 font-semibold">
							{t.settings.tokenNone}
						</span>
					)}
				</SettingRow>
			</Card>

			<Card title={t.settings.alerts} flush>
				<SettingRow label={t.settings.webhookKind}>
					<Select
						aria-label={t.settings.webhookKind}
						value={draft.webhook_kind}
						onChange={(event) => {
							set({ webhook_kind: event.target.value as Settings['webhook_kind'] });
						}}
						className="w-44"
					>
						<option value="discord">Discord</option>
						<option value="ntfy">ntfy</option>
						<option value="generic">JSON</option>
					</Select>
				</SettingRow>
				<SettingRow label={t.settings.webhook} tip={t.settings.webhookHint} wide>
					<div className="w-[26rem] max-w-full max-sm:w-full">
						<TextInput
							type="url"
							aria-label={t.settings.webhook}
							placeholder={t.settings.webhookPlaceholder}
							value={draft.webhook_url}
							onChange={(event) => {
								set({ webhook_url: event.target.value });
							}}
						/>
					</div>
				</SettingRow>
			</Card>

			<Card title={t.settings.system} flush>
				<Facts
					items={[
						[
							t.settings.mediaMode,
							t.settings.mediaModes[data?.system.media_mode ?? ''] ?? data?.system.media_mode ?? '',
						],
						[
							t.settings.mediaUrl,
							data?.system.media_url ? (
								<code key="url" className="font-mono">
									{data.system.media_url}
								</code>
							) : (
								t.settings.mediaSame
							),
						],
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

/** The Twitch token, hidden until asked for. It can be copied but not changed here. */
function TokenField() {
	const t = useT();
	const [token, setToken] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const fetchToken = async () => {
		if (token !== null) return token;
		setBusy(true);
		try {
			const answer = await api.get<{ token: string | null }>('/settings/twitch-token');
			return answer.token;
		} catch (caught) {
			toast.error(caught);
			return null;
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex w-full items-center gap-1 sm:w-auto">
			<input
				readOnly
				aria-label={t.settings.token}
				value={token ?? '••••••••••••••••••••••••••••••'}
				onFocus={(event) => {
					event.currentTarget.select();
				}}
				className="text-ui text-ink-2 bg-surface-2 border-line h-11 w-[22rem] max-w-full min-w-0 flex-1 rounded-sm border px-3.5 font-mono outline-none pointer-fine:h-10"
			/>
			<IconButton
				size="sm"
				label={token === null ? t.settings.tokenReveal : t.settings.tokenHide}
				disabled={busy}
				onClick={() => {
					if (token !== null) {
						setToken(null);
						return;
					}
					void fetchToken().then(setToken);
				}}
			>
				{token === null ? <Eye size={16} /> : <EyeOff size={16} />}
			</IconButton>
			<IconButton
				size="sm"
				label={t.settings.tokenCopy}
				disabled={busy}
				onClick={() => {
					void fetchToken().then(async (value) => {
						if (!value) return;
						await navigator.clipboard.writeText(value);
						toast.ok(t.settings.tokenCopied);
					});
				}}
			>
				<Copy size={16} />
			</IconButton>
		</div>
	);
}
