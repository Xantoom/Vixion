import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useT } from '@/i18n';
import { type Stats, api } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { PageLoading } from '@/ui/Spinner';
import { NotFound } from './NotFound';
import { PageHeader } from './Streamers';

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
	return (
		<div className="bg-surface flex flex-col gap-1 rounded-md px-4 py-3.5">
			<span className="text-caption text-muted font-medium">{label}</span>
			<span className="text-heading tabular font-semibold tracking-tight">{value}</span>
			{detail ? <span className="text-caption text-muted tabular">{detail}</span> : null}
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
		<div className="panel-in mx-auto max-w-6xl px-4 pb-12 sm:px-6">
			<PageHeader title={t.stats.title} />
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Tile label={t.stats.space} value={formatBytes(data.bytes)} />
				<Tile label={t.stats.recordings} value={formatNumber(data.streams)} />
				<Tile label={t.stats.watchTime} value={formatDuration(data.duration_ms)} />
				<Tile label={t.stats.recordingNow} value={String(data.recording)} />
			</div>

			<section className="mt-8">
				<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
					<h2 className="text-lead font-semibold">{t.stats.storage}</h2>
					<span className="text-small text-muted tabular">
						{t.stats.diskFree(formatBytes(disk.free), formatBytes(disk.total))}
					</span>
				</div>
				<div
					className="bg-surface-2 flex h-3 gap-0.5 overflow-hidden rounded-full"
					role="img"
					aria-label={t.stats.storage}
				>
					{segments.map((segment) =>
						segment.value > 0 ? (
							<div
								key={segment.label}
								title={`${segment.label}: ${formatBytes(segment.value)}`}
								className={`${segment.className} h-full min-w-1 transition-[width] duration-500`}
								style={{ width: `${share(segment.value)}%` }}
							/>
						) : null,
					)}
				</div>
				<ul className="text-small text-ink-2 mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
					{segments.map((segment) => (
						<li key={segment.label} className="flex items-center gap-2">
							<span className={`${segment.className} size-2.5 rounded-full`} />
							{segment.label}
							<span className="text-muted tabular">{formatBytes(segment.value)}</span>
						</li>
					))}
					<li className="flex items-center gap-2">
						<span className="bg-surface-2 ring-line-2 size-2.5 rounded-full ring-1" />
						{t.stats.free}
						<span className="text-muted tabular">{formatBytes(disk.free)}</span>
					</li>
				</ul>
			</section>

			<section className="mt-10">
				<h2 className="text-lead mb-3 font-semibold">{t.stats.perStreamer}</h2>
				<div className="border-line overflow-x-auto rounded-md border">
					<table className="text-small w-full min-w-[34rem]">
						<thead className="text-caption text-muted bg-surface text-left">
							<tr>
								<th className="px-4 py-2.5 font-medium">{t.stats.streamer}</th>
								<th className="px-4 py-2.5 font-medium">{t.stats.size}</th>
								<th className="px-4 py-2.5 text-right font-medium">{t.stats.count}</th>
								<th className="px-4 py-2.5 text-right font-medium">{t.stats.duration}</th>
								<th className="px-4 py-2.5 text-right font-medium">{t.stats.kept}</th>
							</tr>
						</thead>
						<tbody>
							{data.streamers.map((streamer) => (
								<tr key={streamer.id} className="border-line hover:bg-surface border-t">
									<td className="px-4 py-2.5">
										<Link
											to="/streamers/$id"
											params={{ id: String(streamer.id) }}
											className="flex items-center gap-2.5 font-medium hover:underline"
										>
											<Avatar src={streamer.avatar_url} name={streamer.display_name} size={26} />
											{streamer.display_name}
										</Link>
									</td>
									<td className="px-4 py-2.5">
										<div className="flex items-center gap-3">
											<span className="tabular w-16 flex-none">
												{formatBytes(streamer.bytes)}
											</span>
											<div className="hidden h-1.5 flex-1 sm:block">
												<div
													className="bg-accent h-full min-w-0.5 rounded-full"
													style={{ width: `${(streamer.bytes / biggest) * 100}%` }}
												/>
											</div>
										</div>
									</td>
									<td className="tabular px-4 py-2.5 text-right">{streamer.streams}</td>
									<td className="tabular px-4 py-2.5 text-right">
										{formatDuration(streamer.duration_ms)}
									</td>
									<td className="tabular px-4 py-2.5 text-right">{streamer.kept}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section className="mt-10">
				<h2 className="text-lead mb-3 font-semibold">{t.stats.server}</h2>
				<dl className="text-small grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
					<dt className="text-muted">{t.stats.version}</dt>
					<dd className="font-mono">{data.version}</dd>
					<dt className="text-muted">{t.stats.uptime}</dt>
					<dd className="tabular">{formatDuration(data.uptime_ms)}</dd>
					{data.memory !== null ? (
						<>
							<dt className="text-muted">{t.stats.memory}</dt>
							<dd className="tabular">{formatBytes(data.memory)}</dd>
						</>
					) : null}
				</dl>
			</section>
		</div>
	);
}
