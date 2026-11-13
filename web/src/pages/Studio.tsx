import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	AudioLines,
	CalendarDays,
	Download,
	FileJson,
	FileText,
	FileVideo,
	Gamepad2,
	ListVideo,
	Maximize,
	Minimize,
	MonitorPlay,
	Pause,
	Play,
	RefreshCw,
	RotateCcw,
	RotateCw,
	Volume1,
	Volume2,
	VolumeX,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { ApiError, type StreamDetail, api } from '@/lib/api';
import { formatClock, formatDate, formatDuration, formatQuality } from '@/lib/format';
import { resumeAt, saveProgress } from '@/lib/progress';
import { useCan, useRouteParams } from '@/lib/session';
import { ChatPanel } from '@/player/ChatPanel';
import { type Engine, type EngineError, type PlaybackState, createEngine } from '@/player/engine';
import { Timeline, boxArt } from '@/player/Timeline';
import { usePrefs } from '@/stores/prefs';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Menu, MenuDivider, MenuItem } from '@/ui/Menu';
import { PageLoading, Spinner } from '@/ui/Spinner';
import { NotFound } from './NotFound';
import { LiveDot } from './Streamers';

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
	const { login, id } = useRouteParams();
	const navigate = useNavigate();
	// The media link changes on every answer: the page keeps the one it opened with.
	const detail = useQuery({
		queryKey: ['stream', id],
		queryFn: async () => api.get<StreamDetail>(`/streams/${id}`),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		// A broadcast still being recorded opens once it ends.
		refetchInterval: (query) => (query.state.data?.status === 'recording' ? 15_000 : false),
	});
	// An old link with the channel's former name lands on the current one.
	const actual = detail.data?.streamer_login;
	useEffect(() => {
		if (actual && actual !== login)
			void navigate({ to: '/$login/$id', params: { login: actual, id }, replace: true });
	}, [actual, login, id, navigate]);
	if (detail.isPending) return <PageLoading />;
	if (detail.error) return <NotFound forbidden={detail.error instanceof ApiError && detail.error.status === 403} />;
	if (detail.data.status === 'recording') return <StillRecording stream={detail.data} />;
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
	const [hovering, setHovering] = useState(false);
	const hideTimer = useRef(0);
	const lastTap = useRef(0);
	const fullscreen = useFullscreen(root);
	const [chaptersOpen, setChaptersOpen] = useState(false);

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
		open(initial.video_url, initial.duration_ms, resumeAt(initial.id), false);
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

	// The position is remembered every few seconds and on leaving, to start there next time.
	const saved = useRef(0);
	const position = useRef({ time: 0, duration: 0 });
	useEffect(() => {
		position.current = { time, duration };
		if (Math.abs(time - saved.current) < 5) return;
		saved.current = time;
		saveProgress(initial.id, time, duration);
	}, [time, duration, initial.id]);
	useEffect(() => {
		const save = () => {
			const { time: at, duration: of } = position.current;
			if (at > 0) saveProgress(initial.id, at, of);
		};
		window.addEventListener('pagehide', save);
		return () => {
			window.removeEventListener('pagehide', save);
			save();
		};
	}, [initial.id]);

	const seekTo = useCallback((seconds: number) => {
		engine.current?.seek(seconds);
		// The bar moves at once, without waiting for the engine's next report.
		setTime(seconds);
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
			if (target?.closest('input, textarea, select, [contenteditable], [role=menu], [role=dialog], dialog'))
				return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const set = usePrefs.getState().set;
			const { volume, muted } = usePrefs.getState();
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

	const shown = scrub ?? time;
	const downloads = {
		video: stream.download_url,
		json: `/api/streams/${stream.id}/chat.json`,
		ass: `/api/streams/${stream.id}/chat.ass`,
	};
	const VolumeIcon = prefs.muted || prefs.volume === 0 ? VolumeX : prefs.volume < 0.5 ? Volume1 : Volume2;
	const pseudoFullscreen = fullscreen.active && !fullscreen.native;
	// What lies on the picture shows while the pointer is over it, and while paused.
	const overlay = (hovering && controls) || !state.playing || chaptersOpen;

	return (
		<div
			ref={root}
			// The video takes the full height and the chat what is left of the width, within bounds.
			style={{ '--chat-width': 'clamp(20rem, calc(100vw - 100dvh * 16 / 9), 36rem)' } as React.CSSProperties}
			className={`bg-bg flex h-dvh flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_var(--chat-width)] ${pseudoFullscreen ? 'fixed inset-0 z-[60]' : ''}`}
		>
			<section
				ref={stage}
				aria-label={stream.title || t.stream.untitled}
				className={`relative flex-none bg-black select-none max-lg:aspect-video max-lg:max-h-[60dvh] lg:h-full lg:min-h-0 ${overlay ? '' : 'cursor-none'}`}
				onPointerMove={() => {
					setHovering(true);
					poke();
				}}
				onPointerDown={poke}
				onPointerLeave={(event) => {
					if (event.pointerType === 'mouse') setHovering(false);
				}}
			>
				<div
					ref={surface}
					className="absolute inset-0"
					onPointerUp={(event) => {
						if (event.pointerType === 'mouse') return;
						setHovering(true);
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
						<Spinner size={40} />
					</div>
				) : null}
				{!opening && !state.playing && !error ? (
					<button
						type="button"
						aria-label={t.player.play}
						onClick={togglePlay}
						className="absolute top-1/2 left-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md transition-transform duration-150 hover:scale-105"
					>
						<Play size={34} fill="currentColor" className="ml-1" />
					</button>
				) : null}
				{error ? (
					<div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-white">
						<div className="flex max-w-md flex-col items-center gap-4">
							<p className="text-body">
								{error === 'decode'
									? t.player.cantDecode
									: error === 'expired'
										? t.player.expiredLink
										: t.player.cantOpen}
							</p>
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
				) : null}

				<StreamOverlay stream={stream} visible={overlay} />

				{/* Controls */}
				<div
					className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-14 pb-2 text-white transition-opacity duration-300 sm:px-5 sm:pb-3 ${overlay ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
				>
					<Timeline
						duration={duration}
						time={shown}
						chapters={stream.chapters}
						onSeek={seekTo}
						onScrub={setScrub}
					/>
					<div className="mt-1 flex items-center gap-0.5 sm:gap-1">
						<PlayerButton label={state.playing ? t.player.pause : t.player.play} onClick={togglePlay}>
							{state.playing ? (
								<Pause size={24} fill="currentColor" />
							) : (
								<Play size={24} fill="currentColor" />
							)}
						</PlayerButton>
						<PlayerButton
							label={t.player.back}
							className="max-[440px]:hidden"
							onClick={() => {
								seekBy(-5);
							}}
						>
							<RotateCcw size={21} />
						</PlayerButton>
						<PlayerButton
							label={t.player.forward}
							className="max-[440px]:hidden"
							onClick={() => {
								seekBy(5);
							}}
						>
							<RotateCw size={21} />
						</PlayerButton>
						<div className="group/volume flex items-center">
							<PlayerButton
								label={prefs.muted ? t.player.unmute : t.player.mute}
								onClick={() => {
									prefs.set({ muted: !prefs.muted });
								}}
							>
								<VolumeIcon size={22} />
							</PlayerButton>
							<input
								type="range"
								aria-label={t.player.volume}
								className="volume-range hidden w-0 opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-24 group-focus-within/volume:opacity-100 group-hover/volume:w-24 group-hover/volume:opacity-100 sm:block"
								min={0}
								max={1}
								step={0.01}
								value={prefs.muted ? 0 : prefs.volume}
								style={
									{ '--level': `${(prefs.muted ? 0 : prefs.volume) * 100}%` } as React.CSSProperties
								}
								onChange={(event) => {
									prefs.set({ volume: event.target.valueAsNumber, muted: false });
								}}
							/>
						</div>
						<PlayerButton
							label={prefs.compressor ? t.player.compressorOn : t.player.compressorOff}
							pressed={prefs.compressor}
							onClick={() => {
								prefs.set({ compressor: !prefs.compressor });
							}}
						>
							<AudioLines size={21} />
						</PlayerButton>
						<span className="text-ui tabular ml-2 whitespace-nowrap text-white">
							{formatClock(shown)}
							<span className="text-white/55 max-sm:hidden"> / {formatClock(duration)}</span>
						</span>
						<div className="flex-1" />
						{stream.chapters.length > 1 ? (
							<Chapters
								chapters={stream.chapters}
								duration={duration}
								time={shown}
								open={chaptersOpen}
								setOpen={setChaptersOpen}
								onSeek={seekTo}
							/>
						) : null}
						{canDownload && downloads.video ? (
							<Menu
								label={t.player.download}
								panelClassName="text-ink"
								trigger={() => (
									<PlayerButton label={t.player.download}>
										<Download size={21} />
									</PlayerButton>
								)}
							>
								<MenuItem icon={<FileVideo size={16} />} href={downloads.video}>
									{t.player.downloadVideo}
								</MenuItem>
								<MenuItem icon={<FileJson size={16} />} href={downloads.json}>
									{t.player.downloadChatJson}
								</MenuItem>
								<MenuItem icon={<FileText size={16} />} href={downloads.ass}>
									{t.player.downloadChatAss}
								</MenuItem>
								<MenuDivider />
								<MenuItem
									icon={<Download size={16} />}
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
							{fullscreen.active ? <Minimize size={21} /> : <Maximize size={21} />}
						</PlayerButton>
					</div>
				</div>
			</section>

			<aside className="border-line relative flex min-h-0 flex-1 flex-col border-t lg:border-t-0 lg:border-l">
				<ChatPanel
					streamId={stream.id}
					timeMs={Math.floor(time * 1000)}
					hasChat={stream.chat_messages > 0}
					onSeek={(ms) => {
						seekTo(ms / 1000);
					}}
				/>
			</aside>
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
	children: ReactNode;
	pressed?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			data-tip={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={`touch-target relative grid size-10 flex-none place-items-center rounded-full text-white/90 transition-colors duration-150 hover:bg-white/15 hover:text-white aria-pressed:text-[color:var(--accent-text)] sm:size-11 ${className}`}
		>
			{children}
			{pressed ? <span className="absolute bottom-1 size-1 rounded-full bg-current" /> : null}
		</button>
	);
}

function Fact({ icon, children, className = '' }: { icon: ReactNode; children: ReactNode; className?: string }) {
	return (
		<span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`}>
			<span className="opacity-75">{icon}</span>
			{children}
		</span>
	);
}

/** Who and what, laid over the top of the picture. */
function StreamOverlay({ stream, visible }: { stream: StreamDetail; visible: boolean }) {
	const t = useT();
	const login = stream.streamer_login;
	const quality = formatQuality(stream.height, stream.fps, stream.video_codec);
	return (
		<div
			className={`absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-3 pt-3 pb-16 text-white transition-opacity duration-300 sm:px-5 sm:pt-4 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
		>
			<div className="flex items-center gap-3.5">
				<Link
					to="/$login"
					params={{ login }}
					aria-label={stream.streamer_name}
					className="flex-none rounded-full transition-opacity hover:opacity-85"
				>
					<Avatar src={stream.streamer_avatar} name={stream.streamer_name} size={48} />
				</Link>
				<div className="min-w-0 flex-1">
					<h1 className="text-body sm:text-lead truncate font-semibold [text-shadow:0_1px_3px_rgb(0_0_0/0.5)]">
						{stream.title || t.stream.untitled}
					</h1>
					<div className="text-small mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-white/75">
						<Link
							to="/$login"
							params={{ login }}
							className="font-semibold text-white transition-opacity hover:opacity-80"
						>
							{stream.streamer_name}
						</Link>
						{stream.game ? <Fact icon={<Gamepad2 size={15} />}>{stream.game}</Fact> : null}
						<Fact icon={<CalendarDays size={15} />}>{formatDate(stream.started_at)}</Fact>
						{quality ? (
							<Fact icon={<MonitorPlay size={15} />} className="max-md:hidden">
								{quality}
							</Fact>
						) : null}
					</div>
					{stream.error ? (
						<p className="text-small mt-1 text-red-300">
							{t.stream.error}: {stream.error}
						</p>
					) : null}
				</div>
				{stream.parts.length > 1 ? (
					<div className="flex flex-none flex-wrap justify-end gap-1.5">
						{stream.parts.map(([id, part]) => (
							<Link
								key={id}
								to="/$login/$id"
								params={{ login, id: String(id) }}
								aria-current={id === stream.id ? 'page' : undefined}
								className="text-small rounded-sm bg-white/15 px-2.5 py-1 font-semibold backdrop-blur-sm transition-colors hover:bg-white/25 aria-[current=page]:bg-white aria-[current=page]:text-black"
							>
								{t.stream.part(part)}
							</Link>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** The broadcast's categories, each with its start and length; picking one jumps there. */
function Chapters({
	chapters,
	duration,
	time,
	open,
	setOpen,
	onSeek,
}: {
	chapters: StreamDetail['chapters'];
	duration: number;
	time: number;
	open: boolean;
	setOpen: (open: boolean) => void;
	onSeek: (seconds: number) => void;
}) {
	const t = useT();
	const wrap = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLOListElement>(null);

	useEffect(() => {
		if (!open) return;
		list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
		const onDown = (event: PointerEvent) => {
			if (!wrap.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false);
		};
		document.addEventListener('pointerdown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [open, setOpen]);

	const now = time * 1000;
	return (
		<div ref={wrap} className="relative">
			<PlayerButton
				label={t.player.chapters}
				pressed={open}
				onClick={() => {
					setOpen(!open);
				}}
			>
				<ListVideo size={21} />
			</PlayerButton>
			{open ? (
				<div
					role="dialog"
					aria-label={t.player.chapters}
					className="menu-in absolute right-0 bottom-full mb-3 flex max-h-[min(34rem,60dvh)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md bg-neutral-950/90 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-md"
				>
					<div className="text-small flex flex-none items-center justify-between px-4 pt-3 pb-2 font-semibold text-white/60">
						{t.player.chapters}
						<span className="tabular">{chapters.length}</span>
					</div>
					<ol ref={list} className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
						{chapters.map((chapter, index) => {
							const end = chapters[index + 1]?.at_ms ?? duration * 1000;
							const current = now >= chapter.at_ms && now < end;
							return (
								<li key={chapter.at_ms}>
									<button
										type="button"
										aria-current={current ? 'true' : undefined}
										onClick={() => {
											onSeek(chapter.at_ms / 1000);
											setOpen(false);
										}}
										className="group/chapter relative flex w-full items-center gap-3 rounded-sm p-2 text-left transition-colors hover:bg-white/10 aria-[current=true]:bg-white/12"
									>
										{current ? (
											<span className="absolute inset-y-2 left-0 w-0.5 rounded-xs bg-[var(--accent)]" />
										) : null}
										{chapter.game ? (
											<img
												src={boxArt(chapter.game)}
												alt=""
												loading="lazy"
												referrerPolicy="no-referrer"
												className="h-14 w-[2.625rem] flex-none rounded-xs bg-white/10 object-cover"
											/>
										) : (
											<span className="grid h-14 w-[2.625rem] flex-none place-items-center rounded-xs bg-white/10">
												<MonitorPlay size={18} className="opacity-70" />
											</span>
										)}
										<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="text-ui truncate font-semibold">
												{chapter.game ?? chapter.title}
											</span>
											{chapter.game && chapter.title ? (
												<span className="text-small truncate text-white/60">
													{chapter.title}
												</span>
											) : null}
										</span>
										<span className="text-small tabular flex flex-none flex-col items-end gap-0.5">
											<span className="font-semibold">{formatClock(chapter.at_ms / 1000)}</span>
											<span className="text-white/60">
												{formatDuration(Math.max(0, end - chapter.at_ms))}
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				</div>
			) : null}
		</div>
	);
}

/** A broadcast still being recorded can't be watched yet: it opens once it ends. */
function StillRecording({ stream }: { stream: StreamDetail }) {
	const t = useT();
	const login = stream.streamer_login;
	return (
		<div className="grid min-h-dvh place-items-center px-4 py-20">
			<div className="panel-in flex max-w-md flex-col items-center gap-4 text-center">
				<Avatar src={stream.streamer_avatar} name={stream.streamer_name} size={72} live />
				<p className="text-small text-live flex items-center gap-2 font-semibold">
					<LiveDot size={8} />
					{t.stream.recordingNow}
				</p>
				<h1 className="text-title font-semibold tracking-tight">{stream.title || t.stream.untitled}</h1>
				<p className="text-body text-muted">{t.stream.recordingLead}</p>
				<div className="mt-2 flex flex-wrap justify-center gap-2">
					<a href={`https://www.twitch.tv/${login}`} target="_blank" rel="noreferrer">
						<Button variant="accent" tabIndex={-1}>
							{t.channel.watchOnTwitch}
						</Button>
					</a>
					<Link to="/$login" params={{ login }}>
						<Button tabIndex={-1}>{stream.streamer_name}</Button>
					</Link>
				</div>
			</div>
		</div>
	);
}
