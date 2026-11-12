import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	Bookmark,
	BookmarkCheck,
	ChevronLeft,
	CircleStop,
	ExternalLink,
	MoreHorizontal,
	SlidersHorizontal,
	Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n';
import { ApiError, type StreamSummary, type Streamer, api } from '@/lib/api';
import { formatBytes, formatClock, formatDate, formatDuration, formatQuality, formatRelative } from '@/lib/format';
import { useCan, useRouteId } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button, IconButton } from '@/ui/Button';
import { Confirm, Dialog } from '@/ui/Dialog';
import { NumberInput, Segmented, Switch } from '@/ui/Field';
import { Menu, MenuItem } from '@/ui/Menu';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';
import { StreamerStatus, streamersQuery } from './Streamers';

interface StreamerDetail {
	streamer: Streamer;
	streams: StreamSummary[];
}

export function streamerQuery(id: string) {
	return {
		queryKey: ['streamer', id],
		queryFn: async () => api.get<StreamerDetail>(`/streamers/${id}`),
		refetchInterval: 15_000,
	};
}

export function StreamerPage() {
	const id = useRouteId();
	const t = useT();
	const canManage = useCan('streamers.manage');
	const { data, isPending, error } = useQuery(streamerQuery(id));
	const [options, setOptions] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [stopping, setStopping] = useState(false);

	if (isPending) return <PageLoading />;
	if (error) return error instanceof ApiError && error.status === 404 ? <NotFound /> : <NotFound forbidden />;
	const { streamer, streams } = data;
	const live = streamer.live !== null || streamer.recording !== null;

	return (
		<div className="mx-auto max-w-[110rem] px-4 sm:px-6">
			<Link
				to="/"
				className="text-small text-muted hover:text-ink mt-5 -ml-1 inline-flex items-center gap-1 rounded-xs pr-2"
			>
				<ChevronLeft size={16} />
				{t.nav.streamers}
			</Link>
			<header className="panel-in flex flex-wrap items-center gap-4 pt-3 pb-6 sm:gap-5">
				<Avatar src={streamer.avatar_url} name={streamer.display_name} size={72} live={live} />
				<div className="flex min-w-0 flex-1 basis-[calc(100%-6rem)] flex-col gap-1 sm:basis-0">
					<h1 className="text-heading truncate font-semibold tracking-tight">{streamer.display_name}</h1>
					<StreamerStatus streamer={streamer} />
					{streamer.live?.title ? (
						<p className="text-small text-ink-2 line-clamp-2">
							{streamer.live.game ? <span className="text-muted">{streamer.live.game} · </span> : null}
							{streamer.live.title}
						</p>
					) : null}
					<p className="text-caption text-muted tabular">
						{t.streamers.streams(streamer.stream_count)} ·{' '}
						{t.streamer.used(formatBytes(streamer.total_bytes))}
					</p>
				</div>
				<div className="flex items-center gap-1 max-sm:w-full max-sm:justify-end">
					{streamer.recording?.stream_id ? (
						<Link to="/streams/$id" params={{ id: String(streamer.recording.stream_id) }}>
							<Button variant="accent" tabIndex={-1}>
								{t.streamers.recording}
								<span className="tabular opacity-80">
									{formatDuration(streamer.recording.duration_ms)}
								</span>
							</Button>
						</Link>
					) : null}
					<Menu
						label={t.streamer.options}
						trigger={() => (
							<IconButton label={t.streamer.options}>
								<MoreHorizontal size={20} />
							</IconButton>
						)}
					>
						<MenuItem icon={<ExternalLink size={15} />} href={`https://www.twitch.tv/${streamer.login}`}>
							{t.streamer.openTwitch}
						</MenuItem>
						{canManage ? (
							<>
								<MenuItem
									icon={<SlidersHorizontal size={15} />}
									onSelect={() => {
										setOptions(true);
									}}
								>
									{t.streamer.options}
								</MenuItem>
								{streamer.recording ? (
									<MenuItem
										icon={<CircleStop size={15} />}
										onSelect={() => {
											setStopping(true);
										}}
									>
										{t.streamer.stop}
									</MenuItem>
								) : null}
								<MenuItem
									danger
									icon={<Trash2 size={15} />}
									onSelect={() => {
										setRemoving(true);
									}}
								>
									{t.streamer.remove}
								</MenuItem>
							</>
						) : null}
					</Menu>
				</div>
			</header>

			<h2 className="text-lead mb-3 font-semibold">{t.streamer.recordings}</h2>
			{streams.length === 0 ? (
				<p className="text-ui text-muted border-line-2 rounded-md border border-dashed px-6 py-12 text-center">
					{streamer.monitored ? t.streamer.empty : t.streamer.emptyPaused}
				</p>
			) : (
				<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-x-4 gap-y-6 pb-12">
					{streams.map((stream, index) => (
						<li key={stream.id} style={{ '--i': index } as React.CSSProperties}>
							<StreamCard stream={stream} streamerId={id} />
						</li>
					))}
				</ul>
			)}

			{canManage ? (
				<>
					<OptionsDialog
						streamer={streamer}
						open={options}
						onClose={() => {
							setOptions(false);
						}}
					/>
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
				</>
			) : null}
		</div>
	);
}

function StreamCard({ stream, streamerId }: { stream: StreamSummary; streamerId: string }) {
	const t = useT();
	const client = useQueryClient();
	const canKeep = useCan('streams.keep');
	const canDelete = useCan('streams.delete');
	const [deleting, setDeleting] = useState(false);
	const [keeping, setKeeping] = useState(false);
	const recording = stream.status === 'recording';
	const refresh = async () => client.invalidateQueries({ queryKey: ['streamer', streamerId] });

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
	const expiresSoon = stream.expires_at !== null && stream.expires_at - Date.now() < 2 * 86_400_000;

	return (
		<article className="group relative flex flex-col gap-2.5">
			<Link
				to="/streams/$id"
				params={{ id: String(stream.id) }}
				className="bg-surface relative block aspect-video overflow-hidden rounded-sm"
				aria-label={stream.title || t.stream.untitled}
			>
				{stream.has_thumbnail ? (
					<img
						src={`/api/streams/${stream.id}/thumbnail`}
						alt=""
						loading="lazy"
						decoding="async"
						className="size-full object-cover transition-transform duration-500 ease-(--ease-out-soft) group-hover:scale-[1.03]"
					/>
				) : (
					<div className="bg-surface-2 size-full" />
				)}
				<div className="absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
					<span className="flex gap-1.5">
						{recording ? (
							<span className="bg-live text-live-ink text-caption inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 font-semibold">
								<span className="live-dot size-1.5 rounded-full bg-white" />
								{t.stream.recording}
							</span>
						) : null}
						{stream.status === 'failed' ? (
							<span className="bg-danger text-caption rounded-xs px-1.5 py-0.5 font-semibold text-white">
								{t.stream.failed}
							</span>
						) : null}
						{stream.part > 1 ? (
							<span className="bg-tip/85 text-tip-ink text-caption rounded-xs px-1.5 py-0.5 font-medium">
								{t.stream.part(stream.part)}
							</span>
						) : null}
					</span>
					<span className="bg-tip/85 text-tip-ink text-caption tabular rounded-xs px-1.5 py-0.5 font-mono font-medium">
						{formatClock(stream.duration_ms / 1000)}
					</span>
				</div>
			</Link>
			<div className="flex items-start gap-1">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<Link
						to="/streams/$id"
						params={{ id: String(stream.id) }}
						className="text-ui hover:text-accent-text line-clamp-2 font-semibold transition-colors"
						title={stream.title}
					>
						{stream.title || t.stream.untitled}
					</Link>
					<p className="text-caption text-muted truncate">
						{stream.game ? `${stream.game} · ` : ''}
						{formatDate(stream.started_at)}
					</p>
					<p className="text-caption text-muted tabular truncate">
						{[formatBytes(stream.size_bytes), quality].filter(Boolean).join(' · ')}
					</p>
					{stream.keep_forever ? (
						<p className="text-caption text-accent-text font-medium">{t.stream.kept}</p>
					) : stream.expires_at !== null && !recording ? (
						<p className={`text-caption ${expiresSoon ? 'text-warn font-medium' : 'text-muted'}`}>
							{stream.expires_at < Date.now()
								? t.stream.expired
								: t.stream.expires(formatRelative(stream.expires_at))}
						</p>
					) : null}
				</div>
				{canKeep ? (
					<IconButton
						size="sm"
						label={stream.keep_forever ? t.stream.unkeep : t.stream.keep}
						aria-pressed={stream.keep_forever}
						disabled={keeping}
						onClick={() => void toggleKeep()}
					>
						{stream.keep_forever ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
					</IconButton>
				) : null}
				{canDelete && !recording ? (
					<IconButton
						size="sm"
						label={t.stream.delete}
						className="hover:!text-danger"
						onClick={() => {
							setDeleting(true);
						}}
					>
						<Trash2 size={17} />
					</IconButton>
				) : null}
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

type RetentionChoice = 'default' | 'forever' | 'custom';

function OptionsDialog({ streamer, open, onClose }: { streamer: Streamer; open: boolean; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	const [monitored, setMonitored] = useState(streamer.monitored);
	const initial: RetentionChoice =
		streamer.retention_days === null ? 'default' : streamer.retention_days === 0 ? 'forever' : 'custom';
	const [choice, setChoice] = useState<RetentionChoice>(initial);
	const [days, setDays] = useState(streamer.retention_days || 30);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		setBusy(true);
		try {
			await api.patch(`/streamers/${streamer.id}`, {
				monitored,
				retention_days: choice === 'default' ? null : choice === 'forever' ? 0 : days,
			});
			await Promise.all([
				client.invalidateQueries({ queryKey: ['streamer'] }),
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
			open={open}
			onClose={onClose}
			title={t.streamer.options}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>
						{t.common.cancel}
					</Button>
					<Button variant="primary" busy={busy} onClick={() => void save()}>
						{t.common.save}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-6">
				<Switch
					checked={monitored}
					onChange={setMonitored}
					label={t.streamer.monitored}
					hint={t.streamer.monitoredHint}
				/>
				<div className="flex flex-col gap-3">
					<span className="text-ui font-medium">{t.streamer.retention}</span>
					<Segmented
						label={t.streamer.retention}
						value={choice}
						onChange={setChoice}
						options={[
							{ value: 'default', label: t.streamer.retentionDefault },
							{ value: 'forever', label: t.streamer.retentionForever },
							{ value: 'custom', label: t.streamer.retentionCustom },
						]}
					/>
					{choice === 'custom' ? (
						<NumberInput
							aria-label={t.streamer.retention}
							value={days}
							onChange={setDays}
							min={1}
							max={3650}
							unit={t.common.days(days).replace(/^\d+\s*/, '')}
						/>
					) : null}
				</div>
			</div>
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
			confirm={t.streamer.remove}
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
					await client.invalidateQueries({ queryKey: ['streamer'] });
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
