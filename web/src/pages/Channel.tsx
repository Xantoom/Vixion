import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	BadgeCheck,
	Bookmark,
	CalendarDays,
	CircleDot,
	CirclePause,
	CircleStop,
	ExternalLink,
	Eye,
	Film,
	Gamepad2,
	Play,
	Plus,
	Settings2,
	Timer,
	Trash2,
	TriangleAlert,
	Users,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, memo, useId, useState } from 'react';
import { SettingRow } from 'xantoom-design/react';
import { useT } from '@/i18n';
import { useAction } from '@/lib/action';
import {
	ApiError,
	type ChannelPage as Page,
	type StreamSummary,
	type Streamer,
	type TwitchVideo,
	api,
} from '@/lib/api';
import {
	formatBytes,
	formatClock,
	formatDateFull,
	formatDateTime,
	formatDuration,
	formatNumber,
	formatQuality,
	formatRelative,
} from '@/lib/format';
import { useNow } from '@/lib/now';
import { forgetProgress, watched } from '@/lib/progress';
import { channelQuery, streamersQuery } from '@/lib/queries';
import { useCan, useRouteParams } from '@/lib/session';
import { boxArt } from '@/lib/twitch';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Confirm, Dialog } from '@/ui/Dialog';
import { ActionRow, Group, SwitchRow } from '@/ui/Group';
import { RetentionMenu } from '@/ui/Retention';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

function Meta({ icon, children, className = '' }: { icon: ReactNode; children: ReactNode; className?: string }) {
	return (
		<span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
			<span className="flex-none opacity-80">{icon}</span>
			<span className="truncate">{children}</span>
		</span>
	);
}

/** Cards past the first rows are laid out and painted only near the screen. */
const OFFSCREEN_FROM = 12;

export function ChannelPage() {
	const { login } = useRouteParams();
	const t = useT();
	const { data, isPending, error, refetch } = useQuery(channelQuery(login));
	const [tab, setTab] = useState<'recordings' | 'twitch' | null>(null);
	const tabs = useId();
	// Asked once here rather than by every card.
	const canKeep = useCan('streams.keep');
	const canDelete = useCan('streams.delete');
	const canManage = useCan('streamers.manage');

	if (isPending) return <PageLoading />;
	if (error) return error instanceof ApiError && error.status === 404 ? <NotFound /> : <NotFound forbidden />;
	const { profile, streamer, streams } = data;
	const name = streamer?.display_name ?? profile?.display_name ?? login;
	// The Twitch tab chosen earlier is gone while Twitch can't be reached.
	const chosen = tab === 'twitch' && !profile ? null : tab;
	const shown = chosen ?? (streamer && (streams.length > 0 || !profile?.videos.length) ? 'recordings' : 'twitch');
	// One stop for the Tab key; the arrows go from tab to tab and open the one they reach.
	const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const list = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
		const index = list.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0) return;
		const target =
			event.key === 'ArrowRight'
				? list[(index + 1) % list.length]
				: event.key === 'ArrowLeft'
					? list[(index - 1 + list.length) % list.length]
					: event.key === 'Home'
						? list[0]
						: event.key === 'End'
							? list.at(-1)
							: undefined;
		if (!target) return;
		event.preventDefault();
		target.focus();
		target.click();
	};

	return (
		<div className="pb-14">
			<Hero data={data} name={name} />
			<div className="mx-auto max-w-[120rem] px-4 sm:px-6">
				{!profile ? (
					<p className="text-small text-warning mb-6 flex items-center gap-2">
						<TriangleAlert size={16} />
						{t.channel.twitchDown}
					</p>
				) : null}
				<LiveNow data={data} />
				<div
					role="tablist"
					aria-label={name}
					onKeyDown={onTabKey}
					className="border-line mt-10 mb-8 flex gap-1 border-b"
				>
					<Tab
						id={`${tabs}-recordings`}
						selected={shown === 'recordings'}
						onSelect={() => {
							setTab('recordings');
						}}
						count={streams.length}
					>
						{t.channel.recordings}
					</Tab>
					{profile ? (
						<Tab
							id={`${tabs}-twitch`}
							selected={shown === 'twitch'}
							onSelect={() => {
								setTab('twitch');
								// Twitch shows the running broadcast's picture only after a while: asked
								// again on each visit until it has one.
								if (profile.live && profile.videos.some((video) => !video.thumbnail_url))
									void refetch();
							}}
							count={profile.videos.length}
						>
							{t.channel.twitchVideos}
						</Tab>
					) : null}
				</div>
				<div role="tabpanel" aria-labelledby={`${tabs}-${shown}`}>
					{shown === 'recordings' ? (
						!streamer ? (
							<Empty>{t.channel.notWatched}</Empty>
						) : streams.length === 0 ? (
							<Empty>{streamer.monitored ? t.streamer.empty : t.streamer.emptyPaused}</Empty>
						) : (
							<ul className="x-stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-10">
								{streams.map((stream, index) => (
									<li
										key={stream.id}
										style={{ '--x-index': index, '--x-lazy-size': '22rem' } as React.CSSProperties}
										className={index >= OFFSCREEN_FROM ? 'x-lazy' : undefined}
									>
										<StreamCard
											stream={stream}
											login={login}
											canKeep={canKeep}
											canDelete={canDelete}
											streamerId={canManage ? streamer.id : null}
										/>
									</li>
								))}
							</ul>
						)
					) : profile && profile.videos.length > 0 ? (
						<ul className="x-stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-10">
							{profile.videos.map((video, index) => (
								<li
									key={video.id}
									style={{ '--x-index': index, '--x-lazy-size': '22rem' } as React.CSSProperties}
									className={index >= OFFSCREEN_FROM ? 'x-lazy' : undefined}
								>
									<VideoCard
										video={video}
										// The broadcast on air has no picture yet: the live one stands in.
										fallback={index === 0 && profile.live ? profile.live.preview_url : null}
									/>
								</li>
							))}
						</ul>
					) : (
						<Empty>{t.channel.noVideos}</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return (
		<p className="text-body text-fg-faint border-line-strong rounded-lg border border-dashed px-6 py-14 text-center">
			{children}
		</p>
	);
}

function Tab({
	id,
	selected,
	onSelect,
	count,
	children,
}: {
	id: string;
	selected: boolean;
	onSelect: () => void;
	count: number;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			id={id}
			role="tab"
			aria-selected={selected}
			tabIndex={selected ? 0 : -1}
			onClick={onSelect}
			className="text-ui text-fg-faint hover:text-fg aria-selected:text-fg relative -mb-px flex h-12 items-center gap-2 px-3 font-semibold transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent aria-selected:after:bg-accent-fill"
		>
			{children}
			<span className="text-caption bg-raised x-tabular rounded-xs px-1.5 py-0.5 font-medium">{count}</span>
		</button>
	);
}

/** The top of the page: the banner, who the channel is, and what can be done with it. */
function Hero({ data, name }: { data: Page; name: string }) {
	const t = useT();
	const { profile, streamer } = data;
	const avatar = streamer?.avatar_url ?? profile?.avatar_url ?? null;
	const banner = profile?.banner_url ?? streamer?.banner_url ?? null;
	const live = Boolean(profile?.live ?? streamer?.live) || streamer?.recording != null;
	const login = streamer?.login ?? profile?.login ?? '';

	return (
		<header className="x-enter">
			<div className="bg-raised-2 relative h-36 overflow-hidden sm:h-52 lg:h-64">
				{banner ? (
					<img
						src={banner}
						alt=""
						fetchPriority="high"
						referrerPolicy="no-referrer"
						className="size-full object-cover"
					/>
				) : avatar ? (
					<img
						src={avatar}
						alt=""
						referrerPolicy="no-referrer"
						className="size-full scale-125 object-cover opacity-60 blur-3xl saturate-150"
					/>
				) : null}
				<div className="from-bg via-bg/25 absolute inset-0 bg-gradient-to-t from-0% via-35% to-transparent to-70%" />
			</div>
			{/* The picture beside the name, the actions in the corner under the banner. */}
			<div className="mx-auto flex max-w-[120rem] flex-col gap-4 px-4 pt-5 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-4 sm:flex-nowrap sm:gap-6">
					<div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
						<Avatar src={avatar} name={name} size={112} live={live} className="max-sm:!size-20" />
						<div className="flex min-w-0 flex-col gap-2">
							<h1 className="text-heading sm:text-display flex flex-wrap items-center gap-x-3 gap-y-1 leading-tight font-bold tracking-tight">
								<a
									href={`https://www.twitch.tv/${login}`}
									target="_blank"
									rel="noreferrer"
									data-tip={t.streamer.openTwitch}
									className="hover:text-accent flex max-w-full min-w-0 items-center transition-colors"
								>
									<span className="truncate">{name}</span>
								</a>
								{profile?.partner ? (
									<span data-tip={t.channel.partner} className="flex-none">
										<BadgeCheck size={28} className="text-accent" aria-label={t.channel.partner} />
									</span>
								) : null}
								{live ? <LivePill /> : null}
							</h1>
							<div className="text-small text-fg-faint flex flex-wrap items-center gap-x-6 gap-y-1.5">
								{profile ? (
									<Meta icon={<Users size={16} />}>
										{t.channel.followers(formatNumber(profile.followers))}
									</Meta>
								) : null}
								{streamer ? (
									<Meta icon={<Film size={16} />}>{t.streamers.streams(streamer.stream_count)}</Meta>
								) : null}
								{streamer && !streamer.monitored ? (
									<Meta icon={<CirclePause size={16} />}>{t.streamers.paused}</Meta>
								) : null}
								{!live && (profile?.last_broadcast ?? streamer?.last_stream_at) ? (
									<Meta icon={<CalendarDays size={16} />}>
										{t.channel.lastLive(
											formatRelative(profile?.last_broadcast ?? streamer?.last_stream_at ?? 0),
										)}
									</Meta>
								) : null}
							</div>
						</div>
					</div>
					{/* The settings stay in the corner; adding a channel takes its own row on a phone. */}
					<div
						className={`flex flex-none items-center gap-1.5 ${streamer ? '' : 'max-sm:w-full max-sm:*:flex-1'}`}
					>
						{streamer ? <StreamerActions streamer={streamer} /> : <AddButton login={login} name={name} />}
					</div>
				</div>
			</div>
		</header>
	);
}

/** The red « Live » label: a dot and the word, centred together on the line they sit in. */
function LivePill({ className = '' }: { className?: string }) {
	const t = useT();
	return (
		<span
			className={`bg-live text-caption inline-flex h-5 flex-none items-center gap-1.5 rounded-xs px-1.5 leading-none font-bold tracking-wide text-white uppercase ${className}`}
		>
			<span className="live-dot size-1.5 rounded-full bg-white" aria-hidden />
			{t.streamers.live}
		</span>
	);
}

/** A broadcast being recorded right now: the recorder's red mark, named by its tooltip. */
function RecordingMark({ size = 16 }: { size?: number }) {
	const t = useT();
	return (
		<span role="img" aria-label={t.channel.beingRecorded} data-tip={t.channel.beingRecorded} className="flex-none">
			<CircleDot size={size} strokeWidth={2.4} className="live-dot text-live" />
		</span>
	);
}

/** The broadcast on air: what it is, a way to watch it on Twitch, and whether it is being recorded. */
function LiveNow({ data }: { data: Page }) {
	const t = useT();
	const now = useNow();
	const client = useQueryClient();
	const canManage = useCan('streamers.manage');
	const { busy, run } = useAction('toast');
	const { profile, streamer } = data;
	const live = profile?.live;
	if (!live && !streamer?.live) return null;
	const title = live?.title ?? streamer?.live?.title ?? null;
	const game = live?.game ?? streamer?.live?.game ?? null;
	const viewers = live?.viewers ?? streamer?.live?.viewers ?? null;
	const since = live?.since ?? streamer?.live?.since ?? null;
	const login = streamer?.login ?? profile?.login ?? '';
	const href = `https://www.twitch.tv/${login}`;
	// Cut by hand while still on air: it can be taken up again, in the same stream.
	const resumable = canManage && streamer?.monitored && streamer.stopped && !streamer.recording;

	const resume = async () => {
		if (!streamer) return;
		await run(async () => {
			await api.post(`/streamers/${streamer.id}/resume`);
			await client.invalidateQueries({ queryKey: ['channel'] });
			toast.ok(t.streamer.resumed);
		});
	};

	return (
		<article className="group bg-raised ring-line relative mt-8 mb-10 flex flex-col overflow-hidden rounded-md shadow-sm ring-1 transition-shadow hover:shadow-md sm:flex-row">
			<div className="bg-raised-2 relative aspect-video flex-none sm:w-96">
				{live?.preview_url ? (
					<img
						src={live.preview_url}
						alt=""
						referrerPolicy="no-referrer"
						className="size-full object-cover"
					/>
				) : null}
				<span className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
					<LivePill />
					{streamer?.recording ? (
						<span className="grid size-5 place-items-center rounded-xs bg-white shadow-sm">
							<RecordingMark size={13} />
						</span>
					) : null}
				</span>
				<span className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-end justify-between gap-2">
					{viewers != null ? (
						<Pill>
							<Eye size={13} />
							{t.channel.viewers(formatNumber(viewers))}
						</Pill>
					) : (
						<span />
					)}
					{since ? (
						<Pill>
							<Timer size={13} />
							{formatDuration(now - since)}
						</Pill>
					) : null}
				</span>
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
				<div className="flex min-w-0 items-start gap-4">
					{live?.game_art_url ? (
						<img
							src={live.game_art_url}
							alt=""
							referrerPolicy="no-referrer"
							className="bg-raised-2 aspect-[3/4] w-14 flex-none rounded-xs object-cover shadow-sm sm:w-16"
						/>
					) : null}
					<div className="flex min-w-0 flex-col gap-1.5">
						<h2 className="text-lead line-clamp-2 font-semibold">
							{/* The whole card opens the broadcast; the buttons in it stay their own. */}
							<a
								href={href}
								target="_blank"
								rel="noreferrer"
								className="hover:text-accent transition-colors after:absolute after:inset-0"
							>
								{title ?? t.stream.untitled}
							</a>
						</h2>
						{game ? (
							<span className="text-small text-fg-faint flex items-center gap-1.5">
								<Gamepad2 size={16} className="flex-none opacity-80" />
								<span className="truncate">{game}</span>
							</span>
						) : null}
					</div>
				</div>
				<div className="mt-auto flex flex-wrap items-center justify-between gap-3">
					<span className="text-small text-accent inline-flex items-center gap-1.5 font-semibold">
						<ExternalLink size={16} />
						{t.channel.watchOnTwitch}
					</span>
					{resumable ? (
						<Button size="sm" variant="outline" busy={busy} className="z-10" onClick={() => void resume()}>
							<CircleDot size={15} />
							{t.streamer.resume}
						</Button>
					) : null}
				</div>
			</div>
		</article>
	);
}

function AddButton({ login, name }: { login: string; name: string }) {
	const t = useT();
	const client = useQueryClient();
	const canManage = useCan('streamers.manage');
	const { busy, run } = useAction('toast');
	if (!canManage) return null;
	const add = async () => {
		await run(async () => {
			await api.post<Streamer>('/streamers', { login });
			await Promise.all([
				client.invalidateQueries({ queryKey: ['channel', login] }),
				client.invalidateQueries({ queryKey: streamersQuery.queryKey }),
			]);
			toast.ok(t.streamers.added(name));
		});
	};
	return (
		<Button variant="accent" busy={busy} data-tip={t.channel.addHint} onClick={() => void add()}>
			<Plus size={18} strokeWidth={2.4} />
			{t.channel.add}
		</Button>
	);
}

function StreamerActions({ streamer }: { streamer: Streamer }) {
	const t = useT();
	const canManage = useCan('streamers.manage');
	const [settings, setSettings] = useState(false);
	if (!canManage) return null;
	return (
		<>
			<Button
				variant="outline"
				className="max-sm:w-10 max-sm:px-0"
				onClick={() => {
					setSettings(true);
				}}
			>
				<Settings2 size={17} />
				{/* On a phone the icon alone, so the button keeps its corner beside the name. */}
				<span className="max-sm:sr-only">{t.streamer.settings}</span>
			</Button>
			{settings ? (
				<SettingsDialog
					streamer={streamer}
					onClose={() => {
						setSettings(false);
					}}
				/>
			) : null}
		</>
	);
}

/** A small label laid on a picture. */
function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
	return (
		<span
			className={`text-caption x-tabular inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 font-semibold backdrop-blur-sm ${className || 'bg-black/70 text-white'}`}
		>
			{children}
		</span>
	);
}

/** A square button laid on a picture. */
function OverlayButton({
	label,
	onClick,
	pressed,
	danger = false,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	pressed?: boolean;
	danger?: boolean;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			data-tip={label}
			aria-pressed={pressed}
			disabled={disabled}
			onClick={onClick}
			className={`grid size-8 place-items-center pointer-coarse:size-10 rounded-sm bg-black/70 text-white backdrop-blur-sm transition-colors disabled:opacity-50 aria-pressed:bg-[var(--x-fill-2)] aria-pressed:text-[var(--x-on-fill)] ${danger ? 'hover:bg-danger-fill' : 'hover:bg-[var(--x-fill-2)] hover:text-[var(--x-on-fill)]'}`}
		>
			{children}
		</button>
	);
}

/** Two lines of title at most, and always the room of two: every card has the same height. */
const CARD_TITLE = 'text-body line-clamp-2 leading-snug font-semibold';

/**
 * The line under a card's title, never wrapped: when (the full date on hover), the game (its box
 * art on hover, the name cut first when room runs out), and one more fact.
 */
function CardMeta({ at, game, extra }: { at: number | null; game: string | null; extra: string | null }) {
	return (
		<p className="text-small text-fg-faint x-tabular flex min-w-0 items-baseline gap-1.5 whitespace-nowrap [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']">
			{at == null ? null : (
				<span data-tip={formatDateFull(at)} className="flex-none">
					{formatDateTime(at)}
				</span>
			)}
			{game ? (
				<span data-tip={game} data-tip-poster={boxArt(game, 144)} className="min-w-0 truncate">
					{game}
				</span>
			) : null}
			{extra ? <span className="flex-none">{extra}</span> : null}
		</p>
	);
}

/** Drawn again only when its recording changed: the page's refresh keeps the others as they were. */
const StreamCard = memo(function StreamCard({
	stream,
	login,
	canKeep,
	canDelete,
	streamerId,
}: {
	stream: StreamSummary;
	login: string;
	canKeep: boolean;
	canDelete: boolean;
	/** Set when the recording in progress may be cut. */
	streamerId: number | null;
}) {
	const t = useT();
	const client = useQueryClient();
	const [deleting, setDeleting] = useState(false);
	const [stopping, setStopping] = useState(false);
	const { busy: keeping, run } = useAction('toast');
	const recording = stream.status === 'recording';
	const refresh = async () => client.invalidateQueries({ queryKey: ['channel', login] });
	const params = { login, id: String(stream.id) };

	const toggleKeep = async () => {
		await run(async () => {
			await api.patch(`/streams/${stream.id}`, { keep_forever: !stream.keep_forever });
			await refresh();
		});
	};

	const quality = formatQuality(stream.height, stream.fps, stream.video_codec);
	const title = stream.title || t.stream.untitled;
	const progress = recording ? null : watched(stream.id);

	return (
		<article className="group flex flex-col gap-3">
			<div
				className={`bg-raised-2 relative aspect-video overflow-hidden rounded-md ${stream.keep_forever ? 'ring-fill-2 ring-2 ring-offset-2 ring-offset-[var(--x-bg)]' : ''}`}
			>
				{stream.has_thumbnail ? (
					<img
						src={`/api/streams/${stream.id}/thumbnail`}
						alt=""
						loading="lazy"
						decoding="async"
						className={`size-full object-cover transition-transform duration-500 ease-(--ease-out-soft) ${recording ? 'opacity-50' : 'motion-safe:group-hover:scale-[1.03]'}`}
					/>
				) : recording ? null : (
					// No picture yet (or none could be taken): a quiet mark rather than an empty box.
					<span className="text-fg-faint/60 absolute inset-0 grid place-items-center" aria-hidden>
						<Film size={36} strokeWidth={1.5} />
					</span>
				)}
				{recording ? (
					<span className="text-small absolute inset-0 grid place-items-center font-semibold text-white">
						<span className="flex items-center gap-2 rounded-sm bg-black/70 px-3 py-1.5">
							<RecordingMark size={15} />
							{t.stream.recordingNow}
						</span>
					</span>
				) : (
					<Link to="/$login/$id" params={params} aria-label={title} className="absolute inset-0">
						<span className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
							<span className="grid size-14 place-items-center rounded-full bg-white/90 text-black shadow-lg">
								<Play size={24} fill="currentColor" className="ml-0.5" />
							</span>
						</span>
					</Link>
				)}
				<span className="pointer-events-none absolute top-2.5 left-2.5 flex gap-1.5">
					{stream.status === 'failed' ? (
						<Pill className="bg-danger-fill text-white">{t.stream.failed}</Pill>
					) : null}
				</span>
				{recording && streamerId != null ? (
					<span className="absolute top-2.5 right-2.5 z-10">
						<OverlayButton
							label={t.streamer.stop}
							danger
							onClick={() => {
								setStopping(true);
							}}
						>
							<CircleStop size={16} />
						</OverlayButton>
					</span>
				) : null}
				{!recording && (canKeep || canDelete) ? (
					<span className="absolute top-2.5 right-2.5 flex gap-1.5">
						{canDelete ? (
							<OverlayButton
								label={t.stream.delete}
								danger
								onClick={() => {
									setDeleting(true);
								}}
							>
								<Trash2 size={16} />
							</OverlayButton>
						) : null}
						{canKeep ? (
							<OverlayButton
								label={stream.keep_forever ? t.stream.unkeep : t.stream.keep}
								pressed={stream.keep_forever}
								disabled={keeping}
								onClick={() => void toggleKeep()}
							>
								<Bookmark size={16} fill={stream.keep_forever ? 'currentColor' : 'none'} />
							</OverlayButton>
						) : null}
					</span>
				) : null}
				{progress ? (
					<span className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
						<span className="block h-full bg-accent-fill" style={{ width: `${progress * 100}%` }} />
					</span>
				) : null}
				<span className="pointer-events-none absolute inset-x-2.5 bottom-3 flex items-end justify-between gap-2">
					{quality ? <Pill>{quality}</Pill> : <span />}
					{recording ? null : <Pill>{formatClock(stream.duration_ms / 1000)}</Pill>}
				</span>
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				{recording ? (
					<span className={CARD_TITLE}>{title}</span>
				) : (
					<Link
						to="/$login/$id"
						params={params}
						title={title}
						className={`${CARD_TITLE} hover:text-accent transition-colors`}
					>
						{title}
					</Link>
				)}
				<CardMeta
					at={stream.started_at}
					game={stream.game}
					extra={stream.size_bytes > 0 ? formatBytes(stream.size_bytes) : null}
				/>
			</div>
			<Confirm
				open={deleting}
				onClose={() => {
					setDeleting(false);
				}}
				title={t.stream.deleteTitle}
				confirm={t.common.delete}
				onConfirm={async () => {
					try {
						await api.delete(`/streams/${stream.id}`);
						forgetProgress([stream.id]);
						toast.ok(t.stream.deleted);
						await Promise.all([refresh(), client.invalidateQueries({ queryKey: streamersQuery.queryKey })]);
					} catch (error) {
						toast.error(error);
						throw error;
					}
				}}
			>
				<p>{t.stream.deleteLead}</p>
				{stream.keep_forever ? <p className="text-accent mt-2 font-medium">{t.stream.kept}</p> : null}
			</Confirm>
			{streamerId != null ? (
				<StopDialog
					streamerId={streamerId}
					open={stopping}
					onClose={() => {
						setStopping(false);
					}}
				/>
			) : null}
		</article>
	);
});

/** A past broadcast still on Twitch: opens there. */
const VideoCard = memo(function VideoCard({ video, fallback }: { video: TwitchVideo; fallback: string | null }) {
	const t = useT();
	const thumbnail = video.thumbnail_url ?? fallback;
	const href = `https://www.twitch.tv/videos/${video.id}`;
	return (
		<article className="group flex flex-col gap-3">
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				className="bg-raised-2 relative block aspect-video overflow-hidden rounded-md"
				aria-label={video.title || t.stream.untitled}
			>
				{thumbnail ? (
					<img
						src={thumbnail}
						alt=""
						loading="lazy"
						referrerPolicy="no-referrer"
						className="size-full object-cover transition-transform duration-500 ease-(--ease-out-soft) motion-safe:group-hover:scale-[1.03]"
					/>
				) : null}
				<span className="absolute top-2.5 right-2.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
					<Pill>
						<ExternalLink size={13} />
						Twitch
					</Pill>
				</span>
				<span className="absolute right-2.5 bottom-2.5">
					<Pill>{formatClock(video.duration_s)}</Pill>
				</span>
			</a>
			<div className="flex min-w-0 flex-col gap-1.5">
				<a
					href={href}
					target="_blank"
					rel="noreferrer"
					className={`${CARD_TITLE} hover:text-accent transition-colors`}
					title={video.title}
				>
					{video.title || t.stream.untitled}
				</a>
				<CardMeta at={video.created_at} game={video.game} extra={t.channel.views(formatNumber(video.views))} />
			</div>
		</article>
	);
});

/** Whether to record, how long streams stay, and deleting the streamer. */
function SettingsDialog({ streamer, onClose }: { streamer: Streamer; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	const [monitored, setMonitored] = useState(streamer.monitored);
	// null follows the general setting, 0 keeps them for good.
	const [retention, setRetention] = useState<number | null>(streamer.retention_days);
	const { busy, run } = useAction('toast');
	const [removing, setRemoving] = useState(false);
	const fallback = streamer.default_retention_days;

	const save = async () => {
		await run(async () => {
			await api.patch(`/streamers/${streamer.id}`, { monitored, retention_days: retention });
			await Promise.all([
				client.invalidateQueries({ queryKey: ['channel'] }),
				client.invalidateQueries({ queryKey: streamersQuery.queryKey }),
			]);
			toast.ok(t.common.saved);
			onClose();
		});
	};

	return (
		<Dialog
			open
			onClose={onClose}
			title={t.streamer.settingsTitle(streamer.display_name)}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button variant="accent" busy={busy} onClick={() => void save()}>
						{t.common.save}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-8">
				<Group title={t.streamer.recordSection}>
					<SwitchRow label={t.streamer.recordLives} checked={monitored} onChange={setMonitored} />
				</Group>
				<Group title={t.streamer.keepSection}>
					<SettingRow label={t.streamer.keepRow}>
						{(control) => (
							<RetentionMenu
								id={control.id}
								label={t.streamer.keepRow}
								value={retention}
								fallback={fallback}
								onChange={setRetention}
							/>
						)}
					</SettingRow>
				</Group>
				<Group>
					<ActionRow
						danger
						onClick={() => {
							setRemoving(true);
						}}
					>
						<Trash2 size={16} />
						{t.streamer.remove}
					</ActionRow>
				</Group>
			</div>
			<RemoveDialog
				streamer={streamer}
				open={removing}
				onClose={() => {
					setRemoving(false);
				}}
			/>
		</Dialog>
	);
}

function RemoveDialog({ streamer, open, onClose }: { streamer: Streamer; open: boolean; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	const navigate = useNavigate();
	return (
		<Confirm
			open={open}
			onClose={onClose}
			title={t.streamer.removeTitle(streamer.display_name)}
			confirm={t.common.delete}
			onConfirm={async () => {
				try {
					await api.delete(`/streamers/${streamer.id}?recordings=true`);
					const pages = client.getQueriesData<Page>({ queryKey: ['channel'] });
					const page = pages.find(([, data]) => data?.streamer?.id === streamer.id)?.[1];
					forgetProgress(page?.streams.map((stream) => stream.id) ?? []);
					await client.invalidateQueries({ queryKey: streamersQuery.queryKey });
					await navigate({ to: '/' });
				} catch (error) {
					toast.error(error);
					throw error;
				}
			}}
		>
			{streamer.stream_count > 0 ? (
				<div className="bg-danger-soft flex flex-col gap-1 rounded-sm p-3">
					<span className="text-danger font-medium">
						{t.streamer.removeRecordings(streamer.stream_count)}
					</span>
					<span className="text-small text-fg-muted">{t.streamer.removeKeep}</span>
				</div>
			) : null}
		</Confirm>
	);
}

function StopDialog({ streamerId, open, onClose }: { streamerId: number; open: boolean; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	return (
		<Confirm
			open={open}
			onClose={onClose}
			title={t.streamer.stopTitle}
			confirm={t.streamer.stop}
			onConfirm={async () => {
				try {
					// Answers once the recording is closed, so the pages show it stopped.
					await api.post(`/streamers/${streamerId}/stop`);
					await Promise.all([
						client.invalidateQueries({ queryKey: ['channel'] }),
						client.invalidateQueries({ queryKey: streamersQuery.queryKey }),
					]);
				} catch (error) {
					toast.error(error);
					throw error;
				}
			}}
		>
			<p>{t.streamer.stopLead}</p>
		</Confirm>
	);
}
