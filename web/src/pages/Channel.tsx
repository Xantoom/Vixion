import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	BadgeCheck,
	Bookmark,
	CalendarDays,
	CirclePause,
	CircleStop,
	ExternalLink,
	Eye,
	Film,
	Gamepad2,
	HardDrive,
	Play,
	Plus,
	Settings2,
	Timer,
	Trash2,
	TriangleAlert,
	Users,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '@/i18n';
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
	formatDate,
	formatDuration,
	formatNumber,
	formatQuality,
	formatRelative,
} from '@/lib/format';
import { useNow } from '@/lib/now';
import { watched } from '@/lib/progress';
import { useCan, useRouteParams } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Confirm, Dialog } from '@/ui/Dialog';
import { NumberInput } from '@/ui/Field';
import { ActionRow, ChoiceRow, Group, SwitchRow } from '@/ui/Group';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';
import { LiveDot, streamersQuery } from './Streamers';

function channelQuery(login: string) {
	return {
		queryKey: ['channel', login],
		queryFn: async () => api.get<Page>(`/channels/${login}`),
		refetchInterval: 20_000,
	};
}

function Meta({ icon, children, className = '' }: { icon: ReactNode; children: ReactNode; className?: string }) {
	return (
		<span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
			<span className="flex-none opacity-80">{icon}</span>
			<span className="truncate">{children}</span>
		</span>
	);
}

export function ChannelPage() {
	const { login } = useRouteParams();
	const t = useT();
	const { data, isPending, error } = useQuery(channelQuery(login));
	const [tab, setTab] = useState<'recordings' | 'twitch' | null>(null);

	if (isPending) return <PageLoading />;
	if (error) return error instanceof ApiError && error.status === 404 ? <NotFound /> : <NotFound forbidden />;
	const { profile, streamer, streams } = data;
	const name = streamer?.display_name ?? profile?.display_name ?? login;
	const shown = tab ?? (streamer && (streams.length > 0 || !profile?.videos.length) ? 'recordings' : 'twitch');

	return (
		<div className="pb-14">
			<Hero data={data} name={name} />
			<div className="mx-auto max-w-[120rem] px-4 sm:px-6">
				{!profile ? (
					<p className="text-small text-warn mb-6 flex items-center gap-2">
						<TriangleAlert size={16} />
						{t.channel.twitchDown}
					</p>
				) : null}
				<LiveNow data={data} />
				<div role="tablist" aria-label={name} className="border-line mb-6 flex gap-1 border-b">
					<Tab
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
							selected={shown === 'twitch'}
							onSelect={() => {
								setTab('twitch');
							}}
							count={profile.videos.length}
						>
							{t.channel.twitchVideos}
						</Tab>
					) : null}
				</div>
				{shown === 'recordings' ? (
					!streamer ? (
						<Empty>{t.channel.notWatched}</Empty>
					) : streams.length === 0 ? (
						<Empty>{streamer.monitored ? t.streamer.empty : t.streamer.emptyPaused}</Empty>
					) : (
						<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-5 gap-y-8">
							{streams.map((stream, index) => (
								<li key={stream.id} style={{ '--i': index } as React.CSSProperties}>
									<StreamCard stream={stream} login={login} />
								</li>
							))}
						</ul>
					)
				) : profile && profile.videos.length > 0 ? (
					<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-5 gap-y-8">
						{profile.videos.map((video, index) => (
							<li key={video.id} style={{ '--i': index } as React.CSSProperties}>
								<VideoCard video={video} />
							</li>
						))}
					</ul>
				) : (
					<Empty>{t.channel.noVideos}</Empty>
				)}
			</div>
		</div>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return (
		<p className="text-body text-muted border-line-2 rounded-lg border border-dashed px-6 py-14 text-center">
			{children}
		</p>
	);
}

function Tab({
	selected,
	onSelect,
	count,
	children,
}: {
	selected: boolean;
	onSelect: () => void;
	count: number;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			onClick={onSelect}
			className="text-ui text-muted hover:text-ink aria-selected:text-ink relative -mb-px flex h-12 items-center gap-2 px-3 font-semibold transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent aria-selected:after:bg-accent-fill"
		>
			{children}
			<span className="text-caption bg-surface tabular rounded-xs px-1.5 py-0.5 font-medium">{count}</span>
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
		<header className="panel-in">
			<div className="bg-surface-2 relative h-36 overflow-hidden sm:h-52 lg:h-64">
				{banner ? (
					<img src={banner} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
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
			<div className="mx-auto flex max-w-[120rem] flex-wrap items-end gap-x-6 gap-y-4 px-4 sm:px-6">
				<span className="bg-bg relative -mt-14 flex-none rounded-full p-1.5 sm:-mt-20">
					<Avatar src={avatar} name={name} size={128} live={live} className="max-sm:!size-24" />
				</span>
				<div className="flex min-w-0 flex-1 basis-72 flex-col gap-2 pb-1">
					<h1 className="text-heading sm:text-display flex items-center gap-3 font-bold tracking-tight">
						<a
							href={`https://www.twitch.tv/${login}`}
							target="_blank"
							rel="noreferrer"
							data-tip={t.streamer.openTwitch}
							className="hover:text-accent-text flex min-w-0 items-center transition-colors"
						>
							<span className="truncate">{name}</span>
						</a>
						{profile?.partner ? (
							<span data-tip={t.channel.partner} className="flex-none">
								<BadgeCheck size={28} className="text-accent-text" aria-label={t.channel.partner} />
							</span>
						) : null}
						{live ? <LiveDot size={12} /> : null}
					</h1>
					<div className="text-small text-muted flex flex-wrap items-center gap-x-5 gap-y-1">
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
					{profile?.description ? (
						<p className="text-body text-ink-2 mt-1 max-w-3xl">{profile.description}</p>
					) : null}
				</div>
				<div className="flex items-center gap-1.5 pb-1">
					{streamer ? <StreamerActions streamer={streamer} /> : <AddButton login={login} name={name} />}
				</div>
			</div>
		</header>
	);
}

/** The broadcast on air: what it is, and a way to watch it on Twitch. Recordings open once finished. */
function LiveNow({ data }: { data: Page }) {
	const t = useT();
	const now = useNow();
	const { profile, streamer } = data;
	const live = profile?.live;
	if (!live && !streamer?.live) return null;
	const title = live?.title ?? streamer?.live?.title ?? null;
	const game = live?.game ?? streamer?.live?.game ?? null;
	const since = live?.since ?? streamer?.live?.since ?? null;
	const login = streamer?.login ?? profile?.login ?? '';

	return (
		<a
			href={`https://www.twitch.tv/${login}`}
			target="_blank"
			rel="noreferrer"
			className="group bg-card ring-line mt-8 mb-10 flex flex-col overflow-hidden rounded-md shadow-(--shadow-card) ring-1 transition-shadow hover:shadow-(--shadow-lift) sm:flex-row"
		>
			<div className="bg-surface-2 relative aspect-video flex-none sm:w-96">
				{live?.preview_url ? (
					<img
						src={live.preview_url}
						alt=""
						referrerPolicy="no-referrer"
						className="size-full object-cover"
					/>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
				<span className="text-small text-live flex items-center gap-2 font-semibold">
					<LiveDot />
					{t.streamers.live}
					{streamer?.recording ? (
						<span className="text-muted font-medium">{t.channel.beingRecorded}</span>
					) : null}
				</span>
				<h2 className="text-lead line-clamp-2 font-semibold">{title ?? t.stream.untitled}</h2>
				<div className="text-small text-muted flex flex-wrap gap-x-5 gap-y-1">
					{game ? <Meta icon={<Gamepad2 size={16} />}>{game}</Meta> : null}
					{live ? (
						<Meta icon={<Eye size={16} />}>{t.channel.viewers(formatNumber(live.viewers))}</Meta>
					) : null}
					{since ? <Meta icon={<Timer size={16} />}>{formatDuration(now - since)}</Meta> : null}
				</div>
				<span className="text-small text-accent-text mt-auto inline-flex items-center gap-1.5 font-semibold">
					<ExternalLink size={16} />
					{t.channel.watchOnTwitch}
				</span>
			</div>
		</a>
	);
}

function AddButton({ login, name }: { login: string; name: string }) {
	const t = useT();
	const client = useQueryClient();
	const canManage = useCan('streamers.manage');
	const [busy, setBusy] = useState(false);
	if (!canManage) return null;
	const add = async () => {
		setBusy(true);
		try {
			await api.post<Streamer>('/streamers', { login });
			await Promise.all([
				client.invalidateQueries({ queryKey: ['channel', login] }),
				client.invalidateQueries({ queryKey: streamersQuery.queryKey }),
			]);
			toast.ok(t.streamers.added(name));
		} catch (error) {
			toast.error(error);
		} finally {
			setBusy(false);
		}
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
				onClick={() => {
					setSettings(true);
				}}
			>
				<Settings2 size={17} />
				{t.streamer.settings}
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
			className={`text-caption tabular inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 font-semibold backdrop-blur-sm ${className || 'bg-black/70 text-white'}`}
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
			className={`grid size-8 place-items-center pointer-coarse:size-10 rounded-sm bg-black/70 text-white backdrop-blur-sm transition-colors disabled:opacity-50 aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--accent-ink)] ${danger ? 'hover:bg-[var(--danger)]' : 'hover:bg-[var(--accent)] hover:text-[var(--accent-ink)]'}`}
		>
			{children}
		</button>
	);
}

function StreamCard({ stream, login }: { stream: StreamSummary; login: string }) {
	const t = useT();
	const client = useQueryClient();
	const canKeep = useCan('streams.keep');
	const canDelete = useCan('streams.delete');
	const [deleting, setDeleting] = useState(false);
	const [keeping, setKeeping] = useState(false);
	const recording = stream.status === 'recording';
	const refresh = async () => client.invalidateQueries({ queryKey: ['channel', login] });
	const params = { login, id: String(stream.id) };

	const toggleKeep = async () => {
		setKeeping(true);
		try {
			await api.patch(`/streams/${stream.id}`, { keep_forever: !stream.keep_forever });
			await refresh();
		} catch (error) {
			toast.error(error);
		} finally {
			setKeeping(false);
		}
	};

	const quality = formatQuality(stream.height, stream.fps, stream.video_codec);
	const title = stream.title || t.stream.untitled;
	const progress = recording ? null : watched(stream.id);
	// Kept recordings show their mark at all times; the other buttons come with the pointer.
	const reveal =
		'opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100';

	return (
		<article className="group flex flex-col gap-3">
			<div
				className={`bg-surface-2 relative aspect-video overflow-hidden rounded-md ${stream.keep_forever ? 'ring-accent ring-2 ring-offset-2 ring-offset-[var(--bg)]' : ''}`}
			>
				{stream.has_thumbnail ? (
					<img
						src={`/api/streams/${stream.id}/thumbnail`}
						alt=""
						loading="lazy"
						decoding="async"
						className={`size-full object-cover transition-transform duration-500 ease-(--ease-out-soft) ${recording ? 'opacity-50' : 'group-hover:scale-[1.03]'}`}
					/>
				) : null}
				{recording ? (
					<span className="text-small absolute inset-0 grid place-items-center font-semibold text-white">
						<span className="flex items-center gap-2 rounded-sm bg-black/70 px-3 py-1.5">
							<LiveDot size={8} />
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
						<Pill className="bg-danger text-white">{t.stream.failed}</Pill>
					) : null}
				</span>
				{!recording && (canKeep || canDelete) ? (
					<span className="absolute top-2.5 right-2.5 flex gap-1.5">
						{canDelete ? (
							<span className={reveal}>
								<OverlayButton
									label={t.stream.delete}
									danger
									onClick={() => {
										setDeleting(true);
									}}
								>
									<Trash2 size={16} />
								</OverlayButton>
							</span>
						) : null}
						{canKeep ? (
							<span className={stream.keep_forever ? '' : reveal}>
								<OverlayButton
									label={stream.keep_forever ? t.stream.unkeep : t.stream.keep}
									pressed={stream.keep_forever}
									disabled={keeping}
									onClick={() => void toggleKeep()}
								>
									<Bookmark size={16} fill={stream.keep_forever ? 'currentColor' : 'none'} />
								</OverlayButton>
							</span>
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
					<span className="text-body line-clamp-2 leading-snug font-semibold">{title}</span>
				) : (
					<Link
						to="/$login/$id"
						params={params}
						className="text-body hover:text-accent-text line-clamp-2 leading-snug font-semibold transition-colors"
					>
						{title}
					</Link>
				)}
				<div className="text-caption text-muted flex flex-wrap gap-x-4 gap-y-1">
					<Meta icon={<CalendarDays size={14} />}>{formatDate(stream.started_at)}</Meta>
					{stream.game ? <Meta icon={<Gamepad2 size={14} />}>{stream.game}</Meta> : null}
					{stream.size_bytes > 0 ? (
						<Meta icon={<HardDrive size={14} />}>
							<span className="tabular">{formatBytes(stream.size_bytes)}</span>
						</Meta>
					) : null}
				</div>
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
						toast.ok(t.stream.deleted);
						await Promise.all([refresh(), client.invalidateQueries({ queryKey: streamersQuery.queryKey })]);
					} catch (error) {
						toast.error(error);
						throw error;
					}
				}}
			>
				<p>{t.stream.deleteLead}</p>
				{stream.keep_forever ? <p className="text-accent-text mt-2 font-medium">{t.stream.kept}</p> : null}
			</Confirm>
		</article>
	);
}

/** A past broadcast still on Twitch: opens there. */
function VideoCard({ video }: { video: TwitchVideo }) {
	const t = useT();
	const href = `https://www.twitch.tv/videos/${video.id}`;
	return (
		<article className="group flex flex-col gap-3">
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				className="bg-surface-2 relative block aspect-video overflow-hidden rounded-md"
				aria-label={video.title || t.stream.untitled}
			>
				{video.thumbnail_url ? (
					<img
						src={video.thumbnail_url}
						alt=""
						loading="lazy"
						referrerPolicy="no-referrer"
						className="size-full object-cover transition-transform duration-500 ease-(--ease-out-soft) group-hover:scale-[1.03]"
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
					className="text-body hover:text-accent-text line-clamp-2 leading-snug font-semibold transition-colors"
					title={video.title}
				>
					{video.title || t.stream.untitled}
				</a>
				<div className="text-caption text-muted flex flex-wrap gap-x-4 gap-y-1">
					{video.created_at ? (
						<Meta icon={<CalendarDays size={14} />}>{formatDate(video.created_at)}</Meta>
					) : null}
					{video.game ? <Meta icon={<Gamepad2 size={14} />}>{video.game}</Meta> : null}
					<Meta icon={<Eye size={14} />}>{formatNumber(video.views)}</Meta>
				</div>
			</div>
		</article>
	);
}

type RetentionChoice = 'default' | 'forever' | 'custom';

/** Whether to record, how long recordings stay, cutting the broadcast on air, and deleting the streamer. */
function SettingsDialog({ streamer, onClose }: { streamer: Streamer; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	const name = useId();
	const [monitored, setMonitored] = useState(streamer.monitored);
	const initial: RetentionChoice =
		streamer.retention_days === null ? 'default' : streamer.retention_days === 0 ? 'forever' : 'custom';
	const [choice, setChoice] = useState<RetentionChoice>(initial);
	const [days, setDays] = useState(streamer.retention_days || 30);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [stopping, setStopping] = useState(false);
	const fallback = streamer.default_retention_days;

	const save = async () => {
		setBusy(true);
		try {
			await api.patch(`/streamers/${streamer.id}`, {
				monitored,
				retention_days: choice === 'default' ? null : choice === 'forever' ? 0 : days,
			});
			await Promise.all([
				client.invalidateQueries({ queryKey: ['channel'] }),
				client.invalidateQueries({ queryKey: streamersQuery.queryKey }),
			]);
			toast.ok(t.common.saved);
			onClose();
		} catch (error) {
			toast.error(error);
		} finally {
			setBusy(false);
		}
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
			<div className="flex flex-col gap-6">
				<Group title={t.streamer.recordSection}>
					<SwitchRow label={t.streamer.recordLives} checked={monitored} onChange={setMonitored} />
					{streamer.recording ? (
						<li className="flex min-h-12 items-center justify-between gap-3 py-2 pr-2 pl-4">
							<span className="text-ui text-live flex items-center gap-2 font-medium">
								<LiveDot size={8} />
								{t.streamer.liveNow}
							</span>
							<Button
								size="sm"
								variant="danger-ghost"
								onClick={() => {
									setStopping(true);
								}}
							>
								<CircleStop size={15} />
								{t.streamer.cut}
							</Button>
						</li>
					) : null}
				</Group>
				<Group title={t.streamer.keepSection}>
					<ChoiceRow
						name={name}
						label={t.streamer.keepDefault}
						detail={fallback === 0 ? t.streamer.retentionForever : t.common.days(fallback)}
						checked={choice === 'default'}
						onChange={() => {
							setChoice('default');
						}}
					/>
					<ChoiceRow
						name={name}
						label={t.streamer.retentionForever}
						checked={choice === 'forever'}
						onChange={() => {
							setChoice('forever');
						}}
					/>
					<ChoiceRow
						name={name}
						label={t.streamer.keepFor}
						checked={choice === 'custom'}
						onChange={() => {
							setChoice('custom');
						}}
					>
						<NumberInput
							aria-label={t.streamer.retention}
							value={days}
							onChange={setDays}
							min={1}
							max={3650}
							unit={t.common.days(days).replace(/^\d+\s*/, '')}
						/>
					</ChoiceRow>
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
			<StopDialog
				streamer={streamer}
				open={stopping}
				onClose={() => {
					setStopping(false);
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
					await client.invalidateQueries({ queryKey: streamersQuery.queryKey });
					await navigate({ to: '/' });
				} catch (error) {
					toast.error(error);
					throw error;
				}
			}}
		>
			<p>{t.streamer.removeLead}</p>
			{streamer.stream_count > 0 ? (
				<div className="bg-danger-soft mt-4 flex flex-col gap-1 rounded-sm p-3">
					<span className="text-danger font-medium">
						{t.streamer.removeRecordings(streamer.stream_count)}
					</span>
					<span className="text-small text-ink-2">{t.streamer.removeKeep}</span>
				</div>
			) : null}
		</Confirm>
	);
}

function StopDialog({ streamer, open, onClose }: { streamer: Streamer; open: boolean; onClose: () => void }) {
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
					await api.post(`/streamers/${streamer.id}/stop`);
					await client.invalidateQueries({ queryKey: ['channel'] });
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
