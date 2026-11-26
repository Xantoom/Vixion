import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { type ReactNode, memo, useMemo } from 'react';
import { useT } from '@/i18n';
import type { Streamer } from '@/lib/api';
import { compareNames, formatRelative } from '@/lib/format';
import { streamersQuery } from '@/lib/queries';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { PageLoading } from '@/ui/Spinner';
import { focusChannelSearch } from './ChannelSearch';

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 pt-8 pb-7 sm:pt-10 sm:pb-8">
			<h1 className="text-heading font-semibold tracking-tight">{title}</h1>
			{children ? <div className="flex items-center gap-2">{children}</div> : null}
		</div>
	);
}

export function StreamersPage() {
	const t = useT();
	const canManage = useCan('streamers.manage');
	const { data, isPending, error } = useQuery(streamersQuery);
	const sorted = useMemo(() => (data ?? []).toSorted((a, b) => compareNames(a.display_name, b.display_name)), [data]);

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
					{canManage ? (
						<Button variant="accent" className="mt-3" onClick={focusChannelSearch}>
							<Search size={17} />
							{t.streamers.emptyAction}
						</Button>
					) : null}
				</div>
			) : (
				<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-6 pb-12 2xl:grid-cols-[repeat(auto-fill,minmax(23rem,1fr))] 2xl:gap-7">
					{sorted.map((streamer, index) => (
						<li key={streamer.id} style={{ '--i': index } as React.CSSProperties}>
							<StreamerCard
								streamer={streamer}
								priority={index < 6 ? (index === 0 ? 'high' : 'auto') : 'lazy'}
							/>
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
	priority = 'lazy',
	className = '',
}: {
	streamer: Pick<Streamer, 'banner_url' | 'avatar_url'>;
	priority?: Priority;
	className?: string;
}) {
	const loading = priority === 'lazy' ? 'lazy' : 'eager';
	const fetchPriority = priority === 'high' ? 'high' : undefined;
	if (streamer.banner_url) {
		return (
			<img
				src={streamer.banner_url}
				alt=""
				loading={loading}
				fetchPriority={fetchPriority}
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
			loading={loading}
			fetchPriority={fetchPriority}
			referrerPolicy="no-referrer"
			className={`size-full scale-125 object-cover opacity-60 blur-2xl saturate-150 ${className}`}
		/>
	) : (
		<div className="bg-surface-2 size-full" />
	);
}

/**
 * How soon a card's banner loads: the first is likely the largest picture of the page and goes
 * first, the rest of the first rows come at once, the others as they near the screen.
 */
type Priority = 'high' | 'auto' | 'lazy';

/** Drawn again only when its streamer changed: a refresh keeps the others as they were. */
const StreamerCard = memo(function StreamerCard({ streamer, priority }: { streamer: Streamer; priority: Priority }) {
	const t = useT();
	const live = streamer.live !== null || streamer.recording !== null;
	const lastLive = streamer.live?.since ?? streamer.last_stream_at;
	return (
		<Link
			to="/$login"
			params={{ login: streamer.login }}
			className={`group bg-card ring-line flex h-full flex-col overflow-hidden rounded-md shadow-(--shadow-card) ring-1 transition-[box-shadow,translate] duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-(--shadow-lift)`}
		>
			{/* Not recorded: the pictures fade, the words stay readable and say so. */}
			<div
				className={`bg-surface-2 relative aspect-[3/1] overflow-hidden ${streamer.monitored ? '' : 'opacity-50 grayscale'}`}
			>
				<Banner
					streamer={streamer}
					priority={priority}
					className="transition-transform duration-500 ease-(--ease-out-soft) motion-safe:group-hover:scale-[1.04]"
				/>
			</div>
			<div className="flex items-center gap-4 px-5 pt-0 pb-5">
				<span className="bg-card relative -mt-7 flex-none self-start rounded-full p-1">
					<Avatar
						src={streamer.avatar_url}
						name={streamer.display_name}
						size={64}
						live={live}
						className={streamer.monitored ? '' : 'opacity-50 grayscale'}
					/>
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-3">
					<span className="flex items-center gap-2">
						<span className="text-lead min-w-0 truncate font-semibold tracking-tight">
							{streamer.display_name}
						</span>
						{live ? <LiveDot /> : null}
					</span>
					{/* Not recorded on a line of its own; then each fact whole: on a narrow card the last one
					    goes to the next line rather than being cut, the dot staying at the end of its line. */}
					<span className="text-small text-muted flex flex-wrap gap-x-1.5">
						{streamer.monitored ? null : (
							<span className="text-ink-2 basis-full font-medium">{t.streamers.paused}</span>
						)}
						<span className="whitespace-nowrap">
							{t.streamers.streams(streamer.stream_count)}
							{lastLive ? ' ·' : null}
						</span>
						{lastLive ? (
							<span className="whitespace-nowrap" data-tip={t.streamers.lastLiveTip}>
								{formatRelative(lastLive)}
							</span>
						) : null}
					</span>
				</div>
			</div>
		</Link>
	);
});
