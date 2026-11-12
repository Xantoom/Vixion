import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Clock3, Film, HardDrive, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { type Streamer, api } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber, formatRelative } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { PageLoading } from '@/ui/Spinner';
import { focusChannelSearch } from './ChannelSearch';

export const streamersQuery = {
	queryKey: ['streamers'],
	queryFn: async () => api.get<Streamer[]>('/streamers'),
	refetchInterval: 15_000,
};

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 pt-7 pb-6 sm:pt-9">
			<h1 className="text-heading font-semibold tracking-tight">{title}</h1>
			{children ? <div className="flex items-center gap-2">{children}</div> : null}
		</div>
	);
}

export function StreamersPage() {
	const t = useT();
	const canManage = useCan('streamers.manage');
	const { data, isPending, error } = useQuery(streamersQuery);
	const sorted = (data ?? []).toSorted((a, b) =>
		a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }),
	);

	return (
		<div className="mx-auto max-w-[120rem] px-4 sm:px-6">
			<PageHeader
				title={
					<>
						{t.streamers.title}
						{data && data.length > 0 ? (
							<span className="text-muted ml-3 font-normal tabular">{data.length}</span>
						) : null}
					</>
				}
			/>
			{isPending ? (
				<PageLoading />
			) : error ? (
				<p className="text-ui text-danger py-10">{error.message}</p>
			) : data.length === 0 ? (
				<div className="panel-in border-line-2 flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-20 text-center">
					<h2 className="text-title font-semibold">{t.streamers.emptyTitle}</h2>
					<p className="text-body text-muted max-w-md">
						{canManage ? t.streamers.emptyLead : t.streamers.emptyLeadViewer}
					</p>
					{canManage ? (
						<Button variant="accent" className="mt-3" onClick={focusChannelSearch}>
							<Search size={17} />
							{t.streamers.emptyAction}
						</Button>
					) : null}
				</div>
			) : (
				<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-5 pb-12">
					{sorted.map((streamer, index) => (
						<li key={streamer.id} style={{ '--i': index } as React.CSSProperties}>
							<StreamerCard streamer={streamer} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The red pill of a channel on air, with what Vixion is doing about it. */
export function LiveBadge({ streamer, className = '' }: { streamer: Streamer; className?: string }) {
	const t = useT();
	const recording = streamer.recording;
	const label = recording
		? recording.state === 'ad'
			? t.streamers.ad
			: recording.state === 'waiting'
				? t.streamers.waiting
				: t.streamers.recording
		: t.streamers.live;
	return (
		<span
			className={`bg-live text-live-ink text-caption inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold shadow-sm ${className}`}
		>
			<span className="live-dot size-2 rounded-full bg-white" />
			{label}
			{recording ? (
				<span className="tabular font-medium opacity-85">{formatDuration(recording.duration_ms)}</span>
			) : null}
		</span>
	);
}

/** What a channel is doing, in a line: its game when live, its last broadcast otherwise. */
export function StreamerStatus({ streamer }: { streamer: Streamer }) {
	const t = useT();
	if (streamer.live) {
		return (
			<span className="text-small text-ink-2 truncate" title={streamer.live.title ?? undefined}>
				{streamer.live.game ?? streamer.live.title}
			</span>
		);
	}
	if (!streamer.monitored) return <span className="text-small text-muted">{t.streamers.paused}</span>;
	return (
		<span className="text-small text-muted truncate">
			{streamer.last_stream_at
				? t.streamers.lastStream(formatRelative(streamer.last_stream_at))
				: t.streamers.noStreams}
		</span>
	);
}

/** A picture behind a channel: its latest recording, its Twitch banner, or its avatar blurred. */
export function Cover({
	streamer,
	className = '',
}: {
	streamer: Pick<Streamer, 'cover_stream_id' | 'banner_url' | 'avatar_url'>;
	className?: string;
}) {
	const src = streamer.cover_stream_id
		? `/api/streams/${streamer.cover_stream_id}/thumbnail`
		: (streamer.banner_url ?? null);
	if (src) {
		return (
			<img
				src={src}
				alt=""
				loading="lazy"
				decoding="async"
				referrerPolicy="no-referrer"
				className={`size-full object-cover ${className}`}
			/>
		);
	}
	return streamer.avatar_url ? (
		<img
			src={streamer.avatar_url}
			alt=""
			loading="lazy"
			referrerPolicy="no-referrer"
			className={`size-full scale-125 object-cover opacity-70 blur-2xl saturate-150 ${className}`}
		/>
	) : (
		<div className="bg-surface-2 size-full" />
	);
}

function Stat({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
	return (
		<span className="text-caption text-muted tabular inline-flex items-center gap-1.5" title={label}>
			{icon}
			{children}
		</span>
	);
}

function StreamerCard({ streamer }: { streamer: Streamer }) {
	const t = useT();
	const live = streamer.live !== null || streamer.recording !== null;
	return (
		<Link
			to="/$login"
			params={{ login: streamer.login }}
			className={`group bg-card ring-line flex h-full flex-col overflow-hidden rounded-lg shadow-(--shadow-card) ring-1 transition-[box-shadow,translate] duration-200 hover:-translate-y-0.5 hover:shadow-(--shadow-lift) ${live ? 'ring-live/50' : ''}`}
		>
			<div className="bg-surface-2 relative aspect-[16/7] overflow-hidden">
				<Cover
					streamer={streamer}
					className={`transition-transform duration-500 ease-(--ease-out-soft) group-hover:scale-[1.04] ${streamer.monitored ? '' : 'grayscale'}`}
				/>
				<div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
				{live ? <LiveBadge streamer={streamer} className="absolute top-3 left-3" /> : null}
				{streamer.live?.viewers ? (
					<span className="bg-tip/80 text-tip-ink text-caption tabular absolute top-3 right-3 rounded-full px-2.5 py-1 font-medium backdrop-blur-sm">
						{t.channel.viewers(formatNumber(streamer.live.viewers))}
					</span>
				) : null}
			</div>
			<div className="flex flex-1 flex-col px-4 pb-4">
				<div className="flex items-end gap-3">
					<span className="bg-card relative -mt-8 flex-none rounded-full p-1">
						<Avatar src={streamer.avatar_url} name={streamer.display_name} size={60} />
					</span>
					<span className="text-lead min-w-0 truncate pb-1 font-semibold tracking-tight">
						{streamer.display_name}
					</span>
				</div>
				<div className="mt-1.5 flex min-h-6 flex-col">
					<StreamerStatus streamer={streamer} />
				</div>
				<div className="border-line mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t pt-3">
					<Stat icon={<Film size={15} />} label={t.streamers.streams(streamer.stream_count)}>
						{streamer.stream_count}
					</Stat>
					<Stat icon={<HardDrive size={15} />} label={t.stats.space}>
						{formatBytes(streamer.total_bytes)}
					</Stat>
					<Stat icon={<Clock3 size={15} />} label={t.stats.watchTime}>
						{formatDuration(streamer.total_duration_ms)}
					</Stat>
				</div>
			</div>
		</Link>
	);
}
