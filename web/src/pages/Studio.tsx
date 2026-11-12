import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
	ChevronLeft,
	Download,
	FileJson,
	FileText,
	FileVideo,
	Gauge,
	Maximize,
	MessageSquare,
	MessageSquareOff,
	Minimize,
	Pause,
	Play,
	RefreshCw,
	RotateCcw,
	RotateCw,
	Volume1,
	Volume2,
	VolumeX,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { ApiError, type StreamDetail, api } from '@/lib/api';
import { formatBytes, formatClock, formatDate, formatDuration, formatNumber, formatQuality } from '@/lib/format';
import { useCan, useRouteId } from '@/lib/session';
import { ChatPanel } from '@/player/ChatPanel';
import { type Engine, type EngineError, type PlaybackState, createEngine } from '@/player/engine';
import { usePrefs } from '@/stores/prefs';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Menu, MenuDivider, MenuItem } from '@/ui/Menu';
import { PageLoading, Spinner } from '@/ui/Spinner';
import { NotFound } from './NotFound';

/** Starts a download of each link, one after the other (browsers allow a few in a row from a click). */
function downloadAll(urls: string[]) {
	urls.forEach((url, index) => {
		setTimeout(() => {
			const link = document.createElement('a');
			link.href = url;
			link.rel = 'noopener';
			link.download = '';
			document.body.append(link);
			link.click();
			link.remove();
		}, index * 600);
	});
}

function useFullscreen(target: React.RefObject<HTMLElement | null>) {
	const [active, setActive] = useState(false);
	const native = typeof document !== 'undefined' && document.fullscreenEnabled;
	useEffect(() => {
		const onChange = () => {
			setActive(document.fullscreenElement === target.current && target.current !== null);
		};
		document.addEventListener('fullscreenchange', onChange);
		return () => {
			document.removeEventListener('fullscreenchange', onChange);
		};
	}, [target]);
	const toggle = useCallback(() => {
		if (!native) {
			// Phones without element fullscreen: the studio covers the page instead.
			setActive((value) => !value);
			return;
		}
		if (document.fullscreenElement) void document.exitFullscreen();
		else void target.current?.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
	}, [native, target]);
	return { active, toggle, native };
}

export function StudioPage() {
	const id = useRouteId();
	// The media link changes on every answer: the page keeps the one it opened with.
	const detail = useQuery({
		queryKey: ['stream', id],
		queryFn: async () => api.get<StreamDetail>(`/streams/${id}`),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	if (detail.isPending) return <PageLoading />;
	if (detail.error) return <NotFound forbidden={detail.error instanceof ApiError && detail.error.status === 403} />;
	return (
		<Studio
			key={id}
			stream={detail.data}
			reload={async () => {
				const fresh = await detail.refetch();
				return fresh.data ?? null;
			}}
		/>
	);
}

function Studio({ stream: initial, reload }: { stream: StreamDetail; reload: () => Promise<StreamDetail | null> }) {
	const t = useT();
	const canDownload = useCan('streams.download');
	const prefs = usePrefs();
	const [stream, setStream] = useState(initial);
	const root = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const surface = useRef<HTMLDivElement>(null);
	const engine = useRef<Engine | null>(null);
	const [duration, setDuration] = useState(initial.duration_ms / 1000);
	const [time, setTime] = useState(0);
	const [state, setState] = useState<PlaybackState>({ playing: false, waiting: false, ended: false });
	const [opening, setOpening] = useState(true);
	const [error, setError] = useState<EngineError | null>(null);
	const [controls, setControls] = useState(true);
	const [scrub, setScrub] = useState<number | null>(null);
	const hideTimer = useRef(0);
	const lastTap = useRef(0);
	const fullscreen = useFullscreen(root);
	const recording = stream.status === 'recording';

	const reopen = useRef<
		(url: string, durationMs: number, at: number, autoplay: boolean, preferElement?: boolean) => void
	>(() => {});

	/** Opens the video in an engine, at a time; the engine falls back to the <video> element when needed. */
	const open = useCallback(
		(url: string, durationMs: number, at: number, autoplay: boolean, preferElement = false) => {
			engine.current?.dispose();
			const next = createEngine(url, durationMs / 1000, preferElement);
			engine.current = next;
			setOpening(true);
			setError(null);
			let last = 0;
			next.onTime = (value) => {
				// The clock reads ten times a second: enough for the bar, cheap for React.
				const now = performance.now();
				if (now - last > 100) {
					last = now;
					setTime(value);
				}
			};
			next.onState = setState;
			next.onError = (kind) => {
				if (engine.current !== next) return;
				if (kind === 'decode' && next.kind === 'mediabunny') {
					reopen.current(url, durationMs, at, autoplay, true);
					return;
				}
				setError(kind);
				setOpening(false);
			};
			if (surface.current) next.attach(surface.current);
			const { volume, muted, compressor } = usePrefs.getState();
			next.setVolume(volume, muted);
			next.setCompressor(compressor);
			next.ready
				.then((length) => {
					if (engine.current !== next) return;
					setDuration(length);
					setOpening(false);
					if (at > 0) next.seek(at);
					if (autoplay) void next.play();
				})
				.catch(() => undefined);
		},
		[],
	);

	useEffect(() => {
		reopen.current = open;
	}, [open]);

	useEffect(() => {
		open(initial.video_url, initial.duration_ms, 0, false);
		return () => {
			engine.current?.dispose();
			engine.current = null;
		};
	}, [initial, open]);

	useEffect(() => {
		engine.current?.setVolume(prefs.volume, prefs.muted);
	}, [prefs.volume, prefs.muted]);

	useEffect(() => {
		engine.current?.setCompressor(prefs.compressor);
	}, [prefs.compressor]);

	const togglePlay = useCallback(() => {
		const current = engine.current;
		if (!current) return;
		if (state.playing) current.pause();
		else void current.play();
	}, [state.playing]);

	const seekBy = useCallback(
		(delta: number) => {
			const current = engine.current;
			if (!current) return;
			current.seek(Math.max(0, Math.min(duration, current.time() + delta)));
		},
		[duration],
	);

	const seekTo = useCallback((seconds: number) => {
		engine.current?.seek(seconds);
	}, []);

	const refresh = async () => {
		const fresh = await reload();
		if (!fresh) return;
		const at = engine.current?.time() ?? 0;
		setStream(fresh);
		open(fresh.video_url, fresh.duration_ms, at, state.playing);
	};

	// Controls fade out while playing and the pointer rests.
	const poke = useCallback(() => {
		setControls(true);
		window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			setControls(false);
		}, 2600);
	}, []);

	useEffect(() => {
		if (!state.playing) {
			window.clearTimeout(hideTimer.current);
			setControls(true);
		} else {
			poke();
		}
	}, [state.playing, poke]);

	// Keyboard: the shortcuts of most players.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('input, textarea, select, [contenteditable], [role=menu], dialog')) return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const set = usePrefs.getState().set;
			const { volume, muted, chat } = usePrefs.getState();
			let handled = true;
			switch (event.key) {
				case ' ':
				case 'k':
					if (target?.tagName === 'BUTTON' && event.key === ' ') return;
					togglePlay();
					break;
				case 'ArrowLeft':
				case 'j':
					seekBy(event.key === 'j' ? -10 : -5);
					break;
				case 'ArrowRight':
				case 'l':
					seekBy(event.key === 'l' ? 10 : 5);
					break;
				case 'ArrowUp':
					set({ volume: Math.min(1, volume + 0.05), muted: false });
					break;
				case 'ArrowDown':
					set({ volume: Math.max(0, volume - 0.05) });
					break;
				case 'm':
					set({ muted: !muted });
					break;
				case 'f':
					fullscreen.toggle();
					break;
				case 'c':
					set({ chat: !chat });
					break;
				case 'Home':
					seekTo(0);
					break;
				case 'End':
					seekTo(Math.max(0, duration - 1));
					break;
				default:
					handled = false;
			}
			if (handled) {
				event.preventDefault();
				poke();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('keydown', onKey);
		};
	}, [togglePlay, seekBy, seekTo, fullscreen, duration, poke]);

	// Resizing the chat column by its edge.
	const startResize = (event: ReactPointerEvent) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = prefs.chatWidth;
		const move = (moved: PointerEvent) => {
			const width = Math.min(560, Math.max(260, startWidth - (moved.clientX - startX)));
			usePrefs.getState().set({ chatWidth: width });
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	const shown = scrub ?? time;
	const progress = duration > 0 ? (shown / duration) * 100 : 0;
	const downloads = {
		video: stream.download_url,
		json: `/api/streams/${stream.id}/chat.json`,
		ass: `/api/streams/${stream.id}/chat.ass`,
	};
	const VolumeIcon = prefs.muted || prefs.volume === 0 ? VolumeX : prefs.volume < 0.5 ? Volume1 : Volume2;
	const pseudoFullscreen = fullscreen.active && !fullscreen.native;
	const chatShown = prefs.chat;

	return (
		<div
			ref={root}
			className={`bg-bg flex flex-col lg:flex-row ${fullscreen.active ? 'h-dvh' : 'h-[calc(100dvh-3.5rem)]'} ${pseudoFullscreen ? 'fixed inset-0 z-[60]' : ''}`}
		>
			<section className="flex min-h-0 min-w-0 flex-col lg:flex-1">
				<div
					ref={stage}
					className={`relative bg-black select-none ${fullscreen.active ? 'min-h-0 flex-1' : 'aspect-video max-h-[50dvh] w-full flex-none lg:aspect-auto lg:max-h-none lg:min-h-0 lg:flex-1'} ${controls || !state.playing ? '' : 'cursor-none'}`}
					onPointerMove={poke}
					onPointerDown={poke}
				>
					<div
						ref={surface}
						className="absolute inset-0"
						onPointerUp={(event) => {
							if (event.pointerType === 'mouse') return;
							// Touch: a tap shows the controls; a double tap on a side jumps 5 s, in the middle goes full screen.
							const now = performance.now();
							const box = event.currentTarget.getBoundingClientRect();
							const third = (event.clientX - box.left) / box.width;
							if (now - lastTap.current < 320) {
								lastTap.current = 0;
								if (third < 1 / 3) seekBy(-5);
								else if (third > 2 / 3) seekBy(5);
								else fullscreen.toggle();
							} else {
								lastTap.current = now;
							}
						}}
						onClick={(event) => {
							if (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType !== 'mouse')
								return;
							togglePlay();
						}}
						onDoubleClick={(event) => {
							if (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType !== 'mouse')
								return;
							fullscreen.toggle();
						}}
					/>
					{opening || state.waiting ? (
						<div className="pointer-events-none absolute inset-0 grid place-items-center text-white/85">
							<Spinner size={36} />
						</div>
					) : null}
					{error ? (
						<div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-white">
							<div className="flex max-w-md flex-col items-center gap-4">
								<p className="text-ui">
									{error === 'decode'
										? t.player.cantDecode
										: error === 'expired'
											? t.player.expiredLink
											: t.player.cantOpen}
								</p>
								<div className="flex gap-2">
									{error === 'decode' && downloads.video ? (
										<a href={downloads.video}>
											<Button variant="accent" tabIndex={-1}>
												<Download size={16} />
												{t.player.downloadVideo}
											</Button>
										</a>
									) : (
										<Button variant="accent" onClick={() => void refresh()}>
											<RefreshCw size={16} />
											{t.player.reload}
										</Button>
									)}
								</div>
							</div>
						</div>
					) : null}

					{/* Controls */}
					<div
						className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pt-10 pb-1.5 text-white transition-opacity duration-300 sm:px-4 sm:pb-2.5 ${controls || !state.playing ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
					>
						<div className="relative mb-1 flex items-center">
							{stream.chapters.length > 1 && duration > 0
								? stream.chapters
										.slice(1)
										.map((chapter) => (
											<span
												key={chapter.at_ms}
												className="pointer-events-none absolute top-1/2 h-2 w-0.5 -translate-y-1/2 bg-white/80"
												style={{
													left: `${Math.min(100, (chapter.at_ms / 1000 / duration) * 100)}%`,
												}}
											/>
										))
								: null}
							<input
								type="range"
								className="seek-range"
								aria-label={t.player.chapters}
								min={0}
								max={Math.max(1, duration)}
								step={0.1}
								value={shown}
								style={{ '--progress': `${progress}%` } as React.CSSProperties}
								onChange={(event) => {
									setScrub(event.target.valueAsNumber);
								}}
								onPointerUp={() => {
									if (scrub !== null) seekTo(scrub);
									setScrub(null);
								}}
								onKeyUp={() => {
									if (scrub !== null) seekTo(scrub);
									setScrub(null);
								}}
							/>
						</div>
						<div className="flex items-center gap-0.5 sm:gap-1">
							<PlayerButton label={state.playing ? t.player.pause : t.player.play} onClick={togglePlay}>
								{state.playing ? (
									<Pause size={22} fill="currentColor" />
								) : (
									<Play size={22} fill="currentColor" />
								)}
							</PlayerButton>
							<PlayerButton
								label={t.player.back}
								className="max-[440px]:hidden"
								onClick={() => {
									seekBy(-5);
								}}
							>
								<RotateCcw size={19} />
							</PlayerButton>
							<PlayerButton
								label={t.player.forward}
								className="max-[440px]:hidden"
								onClick={() => {
									seekBy(5);
								}}
							>
								<RotateCw size={19} />
							</PlayerButton>
							<div className="group/volume flex items-center">
								<PlayerButton
									label={prefs.muted ? t.player.unmute : t.player.mute}
									onClick={() => {
										prefs.set({ muted: !prefs.muted });
									}}
								>
									<VolumeIcon size={20} />
								</PlayerButton>
								<input
									type="range"
									aria-label={t.player.volume}
									className="volume-range hidden w-0 opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 group-hover/volume:w-20 group-hover/volume:opacity-100 sm:block"
									min={0}
									max={1}
									step={0.01}
									value={prefs.muted ? 0 : prefs.volume}
									style={
										{
											'--level': `${(prefs.muted ? 0 : prefs.volume) * 100}%`,
										} as React.CSSProperties
									}
									onChange={(event) => {
										prefs.set({ volume: event.target.valueAsNumber, muted: false });
									}}
								/>
							</div>
							<span className="text-small tabular ml-1.5 font-mono whitespace-nowrap text-white/90">
								{formatClock(shown)}
								<span className="text-white/50 max-sm:hidden"> / {formatClock(duration)}</span>
							</span>
							<div className="flex-1" />
							{recording ? (
								<PlayerButton label={t.player.reload} onClick={() => void refresh()}>
									<RefreshCw size={18} />
								</PlayerButton>
							) : null}
							<PlayerButton
								label={prefs.compressor ? t.player.compressorOn : t.player.compressorOff}
								pressed={prefs.compressor}
								onClick={() => {
									prefs.set({ compressor: !prefs.compressor });
								}}
							>
								<Gauge size={19} />
							</PlayerButton>
							<PlayerButton
								label={chatShown ? t.player.hideChat : t.player.showChat}
								onClick={() => {
									prefs.set({ chat: !chatShown });
								}}
							>
								{chatShown ? <MessageSquare size={19} /> : <MessageSquareOff size={19} />}
							</PlayerButton>
							{canDownload && downloads.video ? (
								<Menu
									label={t.player.download}
									panelClassName="text-ink"
									trigger={() => (
										<PlayerButton label={t.player.download}>
											<Download size={19} />
										</PlayerButton>
									)}
								>
									<MenuItem icon={<FileVideo size={15} />} href={downloads.video}>
										{t.player.downloadVideo}
									</MenuItem>
									<MenuItem icon={<FileJson size={15} />} href={downloads.json}>
										{t.player.downloadChatJson}
									</MenuItem>
									<MenuItem icon={<FileText size={15} />} href={downloads.ass}>
										{t.player.downloadChatAss}
									</MenuItem>
									<MenuDivider />
									<MenuItem
										icon={<Download size={15} />}
										onSelect={() => {
											downloadAll([downloads.video ?? '', downloads.ass]);
										}}
									>
										{t.player.downloadBoth}
									</MenuItem>
								</Menu>
							) : null}
							<PlayerButton
								label={fullscreen.active ? t.player.exitFullscreen : t.player.fullscreen}
								onClick={fullscreen.toggle}
							>
								{fullscreen.active ? <Minimize size={19} /> : <Maximize size={19} />}
							</PlayerButton>
						</div>
					</div>
				</div>

				{fullscreen.active ? null : <StreamInfo stream={stream} onSeek={seekTo} recording={recording} />}
			</section>

			{chatShown ? (
				<aside
					className="border-line relative flex min-h-0 flex-1 flex-col border-t lg:flex-none lg:border-t-0 lg:border-l"
					style={{ '--chat-width': `${prefs.chatWidth}px` } as React.CSSProperties}
				>
					<div
						role="separator"
						aria-orientation="vertical"
						onPointerDown={startResize}
						className="hover:bg-accent/40 absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize transition-colors lg:block"
					/>
					<div className="border-line text-small text-muted hidden h-10 flex-none items-center justify-between border-b px-4 font-medium lg:flex">
						{t.player.chat}
						<span className="tabular">{formatNumber(stream.chat_messages)}</span>
					</div>
					<div className="flex min-h-0 flex-1 flex-col lg:w-(--chat-width)">
						<ChatPanel
							streamId={stream.id}
							timeMs={Math.floor(time * 1000)}
							recording={recording}
							hasChat={stream.chat_messages > 0 || recording}
							onSeek={(ms) => {
								seekTo(ms / 1000);
							}}
						/>
					</div>
				</aside>
			) : null}
		</div>
	);
}

function PlayerButton({
	label,
	onClick,
	children,
	pressed,
	className = '',
}: {
	label: string;
	onClick?: () => void;
	children: React.ReactNode;
	pressed?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={`touch-target relative grid size-9 flex-none place-items-center rounded-sm text-white/90 sm:size-10 transition-colors duration-150 hover:bg-white/15 hover:text-white aria-pressed:text-[color:var(--accent-text)] ${className}`}
		>
			{children}
			{pressed ? <span className="absolute bottom-1.5 size-1 rounded-full bg-current" /> : null}
		</button>
	);
}

function StreamInfo({
	stream,
	onSeek,
	recording,
}: {
	stream: StreamDetail;
	onSeek: (seconds: number) => void;
	recording: boolean;
}) {
	const t = useT();
	const facts = [
		formatDate(stream.started_at),
		formatDuration(stream.duration_ms),
		formatBytes(stream.size_bytes),
		formatQuality(stream.height, stream.fps, stream.video_codec),
		stream.chat_messages > 0 ? t.stream.messages(formatNumber(stream.chat_messages)) : null,
		stream.ads_skipped_ms > 0 ? t.stream.ads(formatDuration(stream.ads_skipped_ms)) : null,
		stream.gaps > 0 ? t.stream.gaps(stream.gaps) : null,
	].filter(Boolean);
	return (
		<div className="flex-none overflow-y-auto px-4 py-3 sm:px-5 lg:max-h-[38%] lg:py-4">
			<div className="flex items-start gap-3">
				<Link
					to="/streamers/$id"
					params={{ id: String(stream.streamer_id) }}
					className="flex-none rounded-full"
					aria-label={stream.streamer_name}
				>
					<Avatar src={stream.streamer_avatar} name={stream.streamer_name} size={40} live={recording} />
				</Link>
				<div className="min-w-0 flex-1">
					<h1 className="text-body sm:text-lead line-clamp-2 font-semibold" title={stream.title}>
						{stream.title || t.stream.untitled}
					</h1>
					<p className="text-small text-ink-2 mt-0.5 flex flex-wrap items-center gap-x-1.5">
						<Link
							to="/streamers/$id"
							params={{ id: String(stream.streamer_id) }}
							className="hover:text-accent-text inline-flex items-center gap-0.5 font-medium"
						>
							<ChevronLeft size={14} className="-ml-0.5" />
							{stream.streamer_name}
						</Link>
						{stream.game ? <span className="text-muted">· {stream.game}</span> : null}
					</p>
					<p className="text-caption text-muted tabular mt-1">{facts.join(' · ')}</p>
					{recording ? <p className="text-caption text-live mt-1 font-medium">{t.player.growing}</p> : null}
					{stream.error ? (
						<p className="text-caption text-danger mt-1">
							{t.stream.error}: {stream.error}
						</p>
					) : null}
				</div>
			</div>
			{stream.parts.length > 1 ? (
				<div className="mt-3 flex flex-wrap gap-1.5">
					{stream.parts.map(([id, part]) => (
						<Link
							key={id}
							to="/streams/$id"
							params={{ id: String(id) }}
							aria-current={id === stream.id ? 'page' : undefined}
							className="text-small bg-surface hover:bg-surface-2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text rounded-xs px-2.5 py-1 font-medium"
						>
							{t.stream.part(part)}
						</Link>
					))}
				</div>
			) : null}
			{stream.chapters.length > 1 ? (
				<div className="mt-4">
					<h2 className="text-caption text-muted mb-1.5 font-medium">{t.player.chapters}</h2>
					<ol className="flex flex-col">
						{stream.chapters.map((chapter) => (
							<li key={chapter.at_ms}>
								<button
									type="button"
									onClick={() => {
										onSeek(chapter.at_ms / 1000);
									}}
									className="text-small hover:bg-surface flex w-full items-baseline gap-3 rounded-xs px-2 py-1.5 text-left"
								>
									<span className="text-accent-text tabular w-16 flex-none font-mono">
										{formatClock(chapter.at_ms / 1000)}
									</span>
									<span className="min-w-0 truncate">
										{chapter.game ? <span className="font-medium">{chapter.game}</span> : null}
										{chapter.game && chapter.title ? <span className="text-muted"> · </span> : null}
										<span className="text-ink-2">{chapter.title}</span>
									</span>
								</button>
							</li>
						))}
					</ol>
				</div>
			) : null}
		</div>
	);
}
