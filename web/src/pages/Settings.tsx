import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NumberField, Select, SettingRow, Settings as SettingsList, Switch } from 'xantoom-design/react';
import { useT } from '@/i18n';
import { useAction } from '@/lib/action';
import { type Folder, type Settings, type SettingsResponse, type Stats, api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Button } from '@/ui/Button';
import { TextInput } from '@/ui/Field';
import { RetentionMenu } from '@/ui/Retention';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

const WEBHOOK_KINDS: { value: Settings['webhook_kind']; label: string }[] = [
	{ value: 'discord', label: 'Discord' },
	{ value: 'ntfy', label: 'ntfy' },
	{ value: 'generic', label: 'JSON' },
];

export function SettingsPage() {
	const t = useT();
	const can = useCan('settings.manage');
	const client = useQueryClient();
	const { data, isPending, error } = useQuery({
		queryKey: ['settings'],
		queryFn: async () => api.get<SettingsResponse>('/settings'),
		enabled: can,
	});
	// What was changed here and not saved yet; until then the page shows the server's settings.
	const [edits, setEdits] = useState<Settings | null>(null);
	const draft = edits ?? data?.settings ?? null;
	const { busy, run } = useAction('toast');

	if (!can) return <NotFound forbidden />;
	if (isPending || !draft) return error ? <p className="text-danger p-6">{error.message}</p> : <PageLoading />;

	const set = (changes: Partial<Settings>) => {
		setEdits({ ...draft, ...changes });
	};
	const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(data?.settings);

	const save = async () => {
		await run(async () => {
			const saved = await api.put<Settings>('/settings', draft);
			client.setQueryData<SettingsResponse>(['settings'], (old) => (old ? { ...old, settings: saved } : old));
			setEdits(null);
			toast.ok(t.common.saved);
		});
	};

	return (
		<div className="x-enter flex flex-col gap-8 pb-24">
			<SettingsList title={t.settings.recording} level={2}>
				<SettingRow label={t.settings.h264Only} description={t.settings.h264OnlyHint}>
					{(control) => (
						<Switch
							{...control}
							checked={draft.h264_only}
							onChange={(h264_only) => {
								set({ h264_only });
							}}
						/>
					)}
				</SettingRow>
				<SettingRow label={t.settings.recordChat}>
					{(control) => (
						<Switch
							{...control}
							checked={draft.record_chat}
							onChange={(record_chat) => {
								set({ record_chat });
							}}
						/>
					)}
				</SettingRow>
			</SettingsList>

			<SettingsList title={t.settings.retention} level={2}>
				<SettingRow label={t.settings.retentionDays} description={t.settings.retentionHint}>
					{/* The same lengths as a streamer's own, picked the same way. */}
					{(control) => (
						<RetentionMenu
							id={control.id}
							describedBy={control['aria-describedby']}
							label={t.settings.retentionDays}
							value={draft.retention_days}
							framed
							onChange={(retention_days) => {
								set({ retention_days: retention_days ?? 0 });
							}}
						/>
					)}
				</SettingRow>
				<SettingRow label={t.settings.diskWarning}>
					{(control) => (
						<NumberField
							{...control}
							value={draft.disk_warning_gb}
							min={0}
							max={100_000}
							unit={t.settings.gb}
							onChange={(disk_warning_gb) => {
								set({ disk_warning_gb });
							}}
						/>
					)}
				</SettingRow>
				<SettingRow label={t.settings.diskReserve} description={t.settings.diskReserveHint}>
					{(control) => (
						<NumberField
							{...control}
							value={draft.disk_reserve_gb}
							min={1}
							max={100_000}
							unit={t.settings.gb}
							onChange={(disk_reserve_gb) => {
								set({ disk_reserve_gb });
							}}
						/>
					)}
				</SettingRow>
			</SettingsList>

			<SettingsList title={t.settings.twitch} level={2}>
				<SettingRow
					label={t.settings.token}
					description={
						draft.twitch_token_source === 'stored' ? t.settings.tokenStoredHint : t.settings.tokenHint
					}
				>
					{() => <span className="x-badge">{t.settings.tokenSet}</span>}
				</SettingRow>
			</SettingsList>

			<SettingsList title={t.settings.alerts} level={2}>
				<SettingRow label={t.settings.webhookKind}>
					{(control) => (
						<Select
							{...control}
							value={draft.webhook_kind}
							onChange={(webhook_kind) => {
								set({ webhook_kind });
							}}
							options={WEBHOOK_KINDS}
							className="w-44"
						/>
					)}
				</SettingRow>
				<SettingRow label={t.settings.webhook} description={t.settings.webhookHint}>
					{(control) => (
						<TextInput
							{...control}
							type="url"
							placeholder={t.settings.webhookPlaceholder}
							value={draft.webhook_url}
							onChange={(event) => {
								set({ webhook_url: event.target.value });
							}}
							className="w-[26rem] max-w-full"
						/>
					)}
				</SettingRow>
			</SettingsList>

			<ServerCard />

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
								setEdits(null);
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

/** What runs and where its files live: read-only, at the end of the settings. */
function ServerCard() {
	const t = useT();
	const can = useCan('stats.view');
	const { data } = useQuery({ queryKey: ['stats'], queryFn: async () => api.get<Stats>('/stats'), enabled: can });
	if (!data) return null;
	const facts: [string, ReactNode][] = [
		[t.settings.version, data.version],
		[t.settings.uptime, formatDuration(data.uptime_ms)],
		...(data.folders
			? ([
					[t.settings.configFolder, <FolderFact key="config" folder={data.folders.config} />],
					[t.settings.recordingsFolder, <FolderFact key="recordings" folder={data.folders.recordings} />],
				] as [string, ReactNode][])
			: []),
	];
	return (
		<section className="x-settings reveal" aria-labelledby="server-facts">
			<h2 id="server-facts">{t.settings.server}</h2>
			{/* Read, not changed: laid out like the setting rows above. */}
			<ul>
				{facts.map(([label, value]) => (
					<li key={label}>
						<span className="x-setting-text">
							<span>{label}</span>
						</span>
						<span className="text-fg-muted min-w-0 flex-[1_1_16rem] text-end break-all">{value}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** A folder as Vixion sees it, and where it comes from on the host. */
function FolderFact({ folder }: { folder: Folder }) {
	const t = useT();
	return (
		<span className="flex flex-col items-end gap-1">
			<code className="font-mono">{folder.path}</code>
			{folder.source ? (
				<span className="text-small text-fg-faint">
					<code className="font-mono">{folder.source}</code> {t.settings.onHost}
				</span>
			) : null}
			{folder.unmapped ? (
				<span className="text-small text-warning flex items-center gap-1.5">
					<TriangleAlert size={14} className="flex-none" />
					{t.stats.unmapped}
				</span>
			) : null}
		</span>
	);
}
