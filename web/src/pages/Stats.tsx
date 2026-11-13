import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleDot, Clock3, Film, HardDrive, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { type Folder, type Stats, api } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Card, Facts } from '@/ui/Card';
import { PageLoading } from '@/ui/Spinner';
import { NotFound } from './NotFound';

function Tile({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
	return (
		<div className="bg-card ring-line flex flex-col gap-1 rounded-md px-4 py-3.5 ring-1">
			<span className="text-small text-muted flex items-center gap-2 font-medium">
				{icon}
				{label}
			</span>
			<span className="text-heading tabular font-semibold tracking-tight">{value}</span>
		</div>
	);
}

export function StatsPage() {
	const t = useT();
	const can = useCan('stats.view');
	const { data, isPending, error } = useQuery({
		queryKey: ['stats'],
		queryFn: async () => api.get<Stats>('/stats'),
		enabled: can,
		refetchInterval: 30_000,
	});
	if (!can) return <NotFound forbidden />;
	if (isPending) return <PageLoading />;
	if (error) return <p className="text-danger p-6">{error.message}</p>;

	const { disk } = data;
	const used = disk.total - disk.free;
	const other = Math.max(0, used - data.bytes);
	const share = (value: number) => (disk.total > 0 ? (value / disk.total) * 100 : 0);
	const biggest = Math.max(1, ...data.streamers.map((s) => s.bytes));
	const segments = [
		{ label: t.stats.usedByVixion, value: data.bytes, className: 'bg-accent' },
		{ label: t.stats.otherFiles, value: other, className: 'bg-line-2' },
	];

	return (
		<div className="panel-in flex flex-col gap-6">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Tile icon={<HardDrive size={16} />} label={t.stats.space} value={formatBytes(data.bytes)} />
				<Tile icon={<Film size={16} />} label={t.stats.recordings} value={formatNumber(data.streams)} />
				<Tile icon={<Clock3 size={16} />} label={t.stats.watchTime} value={formatDuration(data.duration_ms)} />
				<Tile icon={<CircleDot size={16} />} label={t.stats.recordingNow} value={String(data.recording)} />
			</div>

			<Card
				title={t.stats.storage}
				actions={
					<span className="text-small text-muted tabular">
						{t.stats.diskFree(formatBytes(disk.free), formatBytes(disk.total))}
					</span>
				}
			>
				<div
					className="bg-surface-2 flex h-3 gap-0.5 overflow-hidden rounded-xs"
					role="img"
					aria-label={t.stats.storage}
				>
					{segments.map((segment) =>
						segment.value > 0 ? (
							<div
								key={segment.label}
								data-tip={`${segment.label} ${formatBytes(segment.value)}`}
								className={`${segment.className} h-full min-w-1 transition-[width] duration-500`}
								style={{ width: `${share(segment.value)}%` }}
							/>
						) : null,
					)}
				</div>
				<ul className="text-small text-ink-2 mt-3 flex flex-wrap gap-x-6 gap-y-1">
					{segments.map((segment) => (
						<li key={segment.label} className="flex items-center gap-2">
							<span className={`${segment.className} size-2.5 rounded-xs`} />
							{segment.label}
							<span className="text-muted tabular">{formatBytes(segment.value)}</span>
						</li>
					))}
					<li className="flex items-center gap-2">
						<span className="bg-surface-2 ring-line-2 size-2.5 rounded-xs ring-1" />
						{t.stats.free}
						<span className="text-muted tabular">{formatBytes(disk.free)}</span>
					</li>
				</ul>
			</Card>

			<Card title={t.stats.perStreamer} count={data.streamers.length} flush>
				{/* On a phone, one block per streamer instead of five columns. */}
				<ul className="divide-line divide-y sm:hidden">
					{data.streamers.map((streamer) => (
						<li key={streamer.id} className="flex flex-col gap-2 px-5 py-3">
							<div className="flex items-center gap-2.5">
								<Link
									to="/$login"
									params={{ login: streamer.login }}
									className="text-small flex min-w-0 flex-1 items-center gap-2.5 font-semibold"
								>
									<Avatar src={streamer.avatar_url} name={streamer.display_name} size={28} />
									<span className="truncate">{streamer.display_name}</span>
								</Link>
								<span className="text-small tabular flex-none font-medium">
									{formatBytes(streamer.bytes)}
								</span>
							</div>
							<div className="h-1.5">
								<div
									className="bg-accent h-full min-w-0.5 rounded-xs"
									style={{ width: `${(streamer.bytes / biggest) * 100}%` }}
								/>
							</div>
							<p className="text-caption text-muted tabular flex flex-wrap gap-x-3">
								<span>
									{t.stats.count} {streamer.streams}
								</span>
								<span>
									{t.stats.duration} {formatDuration(streamer.duration_ms)}
								</span>
								<span>
									{t.stats.kept} {streamer.kept}
								</span>
							</p>
						</li>
					))}
				</ul>
				<div className="overflow-x-auto max-sm:hidden">
					<table className="text-small w-full min-w-[34rem]">
						<thead className="text-caption text-muted text-left">
							<tr>
								<th className="px-5 py-2.5 font-medium">{t.stats.streamer}</th>
								<th className="px-5 py-2.5 font-medium">{t.stats.size}</th>
								<th className="px-5 py-2.5 text-right font-medium">{t.stats.count}</th>
								<th className="px-5 py-2.5 text-right font-medium">{t.stats.duration}</th>
								<th className="px-5 py-2.5 text-right font-medium">{t.stats.kept}</th>
							</tr>
						</thead>
						<tbody>
							{data.streamers.map((streamer) => (
								<tr
									key={streamer.id}
									className="border-line hover:bg-surface border-t transition-colors"
								>
									<td className="px-5 py-3">
										<Link
											to="/$login"
											params={{ login: streamer.login }}
											className="flex items-center gap-2.5 font-semibold"
										>
											<Avatar src={streamer.avatar_url} name={streamer.display_name} size={28} />
											{streamer.display_name}
										</Link>
									</td>
									<td className="px-5 py-3">
										<div className="flex items-center gap-3">
											<span className="tabular w-16 flex-none">
												{formatBytes(streamer.bytes)}
											</span>
											<div className="hidden h-1.5 flex-1 sm:block">
												<div
													className="bg-accent h-full min-w-0.5 rounded-xs"
													style={{ width: `${(streamer.bytes / biggest) * 100}%` }}
												/>
											</div>
										</div>
									</td>
									<td className="tabular px-5 py-3 text-right">{streamer.streams}</td>
									<td className="tabular px-5 py-3 text-right">
										{formatDuration(streamer.duration_ms)}
									</td>
									<td className="tabular px-5 py-3 text-right">{streamer.kept}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Card>

			<Card title={t.stats.server} flush>
				<Facts
					items={[
						[t.stats.version, data.version],
						[t.stats.uptime, formatDuration(data.uptime_ms)],
						...(data.folders
							? ([
									[t.stats.configFolder, <FolderFact key="config" folder={data.folders.config} />],
									[
										t.stats.recordingsFolder,
										<FolderFact key="recordings" folder={data.folders.recordings} />,
									],
								] as [string, ReactNode][])
							: []),
					]}
				/>
			</Card>
		</div>
	);
}

/** A folder as Vixion sees it, where it comes from on the host, and the room left on its disk. */
function FolderFact({ folder }: { folder: Folder }) {
	const t = useT();
	return (
		<span className="flex flex-col items-end gap-0.5">
			<code className="font-mono">{folder.path}</code>
			{folder.source ? (
				<span className="text-small text-muted">
					<code className="font-mono">{folder.source}</code> {t.stats.onHost}
				</span>
			) : null}
			{folder.unmapped ? (
				<span className="text-small text-warn flex items-center gap-1.5">
					<TriangleAlert size={14} className="flex-none" />
					{t.stats.unmapped}
				</span>
			) : null}
			{folder.disk.total > 0 ? (
				<span className="text-small text-muted">
					{t.stats.diskFree(formatBytes(folder.disk.free), formatBytes(folder.disk.total))}
				</span>
			) : null}
		</span>
	);
}
