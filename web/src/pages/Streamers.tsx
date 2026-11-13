import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarDays, Film, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { type Streamer, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
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
				<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-5 pb-12 2xl:grid-cols-[repeat(auto-fill,minmax(23rem,1fr))] 2xl:gap-6">
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

/** The red dot of a channel on air. */
export function LiveDot({ size = 10, className = '' }: { size?: number; className?: string }) {
	const t = useT();
	return (
		<span
			role="img"
			aria-label={t.streamers.live}
			data-tip={t.streamers.live}
			className={`live-dot bg-live inline-block flex-none rounded-full ${className}`}
			style={{ width: size, height: size }}
		/>
	);
}

/** A channel's Twitch banner, or its avatar blurred when it has none. */
export function Banner({
	streamer,
	className = '',
}: {
	streamer: Pick<Streamer, 'banner_url' | 'avatar_url'>;
	className?: string;
}) {
	if (streamer.banner_url) {
		return (
			<img
				src={streamer.banner_url}
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
			className={`size-full scale-125 object-cover opacity-60 blur-2xl saturate-150 ${className}`}
		/>
	) : (
		<div className="bg-surface-2 size-full" />
	);
}

function StreamerCard({ streamer }: { streamer: Streamer }) {
	const t = useT();
	const live = streamer.live !== null || streamer.recording !== null;
	const lastLive = streamer.live?.since ?? streamer.last_stream_at;
	return (
		<Link
			to="/$login"
			params={{ login: streamer.login }}
			className={`group bg-card ring-line flex h-full flex-col overflow-hidden rounded-md shadow-(--shadow-card) ring-1 transition-[box-shadow,translate] duration-200 hover:-translate-y-0.5 hover:shadow-(--shadow-lift) ${streamer.monitored ? '' : 'opacity-60'}`}
		>
			<div className="bg-surface-2 relative aspect-[3/1] overflow-hidden">
				<Banner
					streamer={streamer}
					className="transition-transform duration-500 ease-(--ease-out-soft) group-hover:scale-[1.04]"
				/>
			</div>
			<div className="flex items-center gap-3.5 px-4 pt-0 pb-4">
				<span className="bg-card relative -mt-7 flex-none self-start rounded-full p-1">
					<Avatar src={streamer.avatar_url} name={streamer.display_name} size={64} live={live} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-2.5">
					<span className="flex items-center gap-2">
						<span className="text-lead min-w-0 truncate font-semibold tracking-tight">
							{streamer.display_name}
						</span>
						{live ? <LiveDot /> : null}
					</span>
					<span className="text-small text-muted flex flex-wrap items-center gap-x-4 gap-y-1">
						<span className="tabular inline-flex items-center gap-1.5">
							<Film size={15} />
							{t.streamers.streams(streamer.stream_count)}
						</span>
						{lastLive ? (
							<span className="inline-flex items-center gap-1.5" data-tip={t.streamers.lastLiveTip}>
								<CalendarDays size={15} />
								{formatRelative(lastLive)}
							</span>
						) : null}
					</span>
				</div>
			</div>
		</Link>
	);
}
