import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useT } from '@/i18n';
import { type Stats, api } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Card } from '@/ui/Card';
import { PageLoading } from '@/ui/Spinner';
import { NotFound } from './NotFound';

function Tile({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
	return (
		<div className="bg-card ring-line flex flex-col gap-4 rounded-md p-6 ring-1">
			<span className="text-small text-muted font-medium">{label}</span>
			<span className="flex flex-col gap-1">
				<span className="text-heading x-tabular font-semibold tracking-tight">{value}</span>
				{detail ? <span className="text-small text-muted x-tabular">{detail}</span> : null}
			</span>
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

	const { disk, memory } = data;
	// What `docker stats` shows: the container, its recently used disk cache included.
	const container = memory.cgroup === null ? null : Math.max(0, memory.cgroup - (memory.cache_inactive ?? 0));
	const used = disk.total - disk.free;
	const other = Math.max(0, used - data.bytes);
	const share = (value: number) => (disk.total > 0 ? (value / disk.total) * 100 : 0);
	const unmapped = data.folders ? [data.folders.config, data.folders.recordings].filter((f) => f.unmapped) : [];
	const biggest = Math.max(1, ...data.streamers.map((s) => s.bytes));
	const segments = [
		{ label: t.stats.usedByVixion, value: data.bytes, className: 'bg-accent-fill' },
		{ label: t.stats.otherFiles, value: other, className: 'bg-line-2' },
	];

	return (
		<div className="x-enter flex flex-col gap-8">
			<div className="flex flex-col gap-4">
				{/* The disk first: how much the recordings take, and how much room is left. Full width, so
				    it is as tall as what it holds, not stretched to a column of tiles beside it. */}
				<section className="bg-card ring-line flex flex-col gap-6 rounded-md p-6 ring-1">
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
						<div className="flex flex-col gap-2">
							<h2 className="text-small text-muted font-medium">{t.stats.space}</h2>
							<span className="text-display x-tabular font-semibold tracking-tight">
								{formatBytes(data.bytes)}
							</span>
						</div>
						{disk.total > 0 ? (
							<span className="text-small text-muted x-tabular pb-1">
								{t.stats.diskFree(formatBytes(disk.free), formatBytes(disk.total))}
							</span>
						) : null}
					</div>
					{disk.total > 0 ? (
						<div className="flex flex-col gap-4">
							<div
								className="bg-surface-2 flex h-2.5 gap-0.5 overflow-hidden rounded-xs"
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
							<ul className="text-small text-ink-2 flex flex-wrap gap-x-7 gap-y-2">
								{segments.map((segment) => (
									<li key={segment.label} className="flex items-center gap-2">
										<span className={`${segment.className} size-2.5 rounded-xs`} />
										{segment.label}
										<span className="text-muted x-tabular">{formatBytes(segment.value)}</span>
									</li>
								))}
								<li className="flex items-center gap-2">
									<span className="bg-surface-2 ring-line-2 size-2.5 rounded-xs ring-1" />
									{t.stats.free}
									<span className="text-muted x-tabular">{formatBytes(disk.free)}</span>
								</li>
							</ul>
						</div>
					) : null}
				</section>
				{/* Under it, the counts side by side; on a phone, the memory and its detail take a whole line. */}
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 max-sm:[&>:last-child]:col-span-2">
					<Tile label={t.stats.recordings} value={formatNumber(data.streams)} />
					<Tile label={t.stats.watchTime} value={formatDuration(data.duration_ms)} />
					<Tile
						label={t.stats.memory}
						value={formatBytes(memory.process)}
						detail={
							container === null
								? null
								: t.stats.memoryContainer(formatBytes(container), formatBytes(memory.cache_active ?? 0))
						}
					/>
				</div>
			</div>

			{data.streamers.length > 0 ? (
				<Card title={t.stats.perStreamer} flush>
					<ul className="divide-line divide-y">
						{data.streamers.map((streamer) => (
							<li key={streamer.id}>
								<Link
									to="/$login"
									params={{ login: streamer.login }}
									className="hover:bg-surface flex min-h-18 items-center gap-4 px-6 py-4 transition-colors"
								>
									<Avatar src={streamer.avatar_url} name={streamer.display_name} size={36} />
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="text-ui truncate font-semibold">{streamer.display_name}</span>
										<span className="text-small text-muted x-tabular">
											<span className="whitespace-nowrap">
												{t.streamers.streams(streamer.streams)}
											</span>
											{' · '}
											<span className="whitespace-nowrap">
												{formatDuration(streamer.duration_ms)}
											</span>
										</span>
									</span>
									{/* The size, and a bar against the biggest streamer. */}
									<span className="flex w-20 flex-none flex-col items-end gap-2 sm:w-48">
										<span className="text-ui x-tabular font-medium">
											{formatBytes(streamer.bytes)}
										</span>
										<span className="bg-surface-2 h-1.5 w-full overflow-hidden rounded-xs">
											<span
												className="bg-accent-fill block h-full min-w-0.5 rounded-xs"
												style={{ width: `${(streamer.bytes / biggest) * 100}%` }}
											/>
										</span>
									</span>
								</Link>
							</li>
						))}
					</ul>
				</Card>
			) : null}

			{/* Only when it matters: a folder outside any volume is lost with the container. */}
			{unmapped.length > 0 ? (
				<p className="reveal bg-warn-soft text-warn text-small flex items-start gap-3 rounded-md px-6 py-4">
					<TriangleAlert size={18} className="mt-0.5 flex-none" />
					<span>
						{unmapped.map((folder) => (
							<code key={folder.path} className="font-mono">
								{folder.path}{' '}
							</code>
						))}
						{t.stats.unmapped}
					</span>
				</p>
			) : null}
		</div>
	);
}
