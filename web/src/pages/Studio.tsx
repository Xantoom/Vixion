import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	MessageSquareOff,
	MessageSquareText,
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
import { type ReactNode, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { ApiError, type StreamDetail } from '@/lib/api';
import { formatClock, formatDate, formatDuration, formatQuality } from '@/lib/format';
import { resumeAt, saveProgress } from '@/lib/progress';
import { streamQuery } from '@/lib/queries';
import { useCan, useRouteParams } from '@/lib/session';
import { ChatPanel } from '@/player/ChatPanel';
import { type Clock, createClock, useClock } from '@/player/clock';
import { type Engine, type EngineError, type PlaybackState, createEngine } from '@/player/engine';
import { createPreview } from '@/player/preview';
import { Timeline, boxArt } from '@/player/Timeline';
import { usePrefs } from '@/stores/prefs';
import { Avatar } from '@/ui/Avatar';
import { Button, buttonClass } from '@/ui/Button';
import { Menu, MenuDivider, MenuItem, type MenuTriggerProps } from '@/ui/Menu';
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

/** Fingers rather than a mouse: phones and tablets. */
function touch() {
	return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/** `screen.orientation` with `lock`, which TypeScript's DOM types leave out. */
function screenOrientation() {
	return (typeof screen === 'undefined' ? undefined : screen.orientation) as
		| (ScreenOrientation & { lock?: (orientation: string) => Promise<void> })
		| undefined;
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
		if (document.fullscreenElement) {
			screenOrientation()?.unlock?.();
			void document.exitFullscreen();
			return;
		}
		void target.current
			?.requestFullscreen({ navigationUI: 'hide' })
			// A phone or tablet turns to landscape, where the browser allows it (Android does).
			.then(async () => {
				if (touch()) await screenOrientation()?.lock?.('landscape');
			})
			.catch(() => undefined);
	}, [native, target]);
	return { active, toggle, native };
}

/**
 * The system's media controls (lock screen, notification, keyboard media keys, headset): what is
 * playing, its position, and play, pause and seeking from there.
 */
function useMediaSession({
	stream,
	playing,
	clock,
	duration,
	togglePlay,
	seekBy,
	seekTo,
}: {
	stream: StreamDetail;
	playing: boolean;
	clock: Clock;
	duration: number;
	togglePlay: () => void;
	seekBy: (delta: number) => void;
	seekTo: (seconds: number) => void;
}) {
	const t = useT();
	const title = stream.title || t.stream.untitled;
	useEffect(() => {
		if (!('mediaSession' in navigator)) return;
		const artwork = stream.has_thumbnail
			? [{ src: `/api/streams/${stream.id}/thumbnail`, type: 'image/jpeg' }]
			: stream.streamer_avatar
				? [{ src: stream.streamer_avatar }]
				: [];
		navigator.mediaSession.metadata = new MediaMetadata({
			title,
			artist: stream.streamer_name,
			album: stream.game ?? undefined,
			artwork,
		});
		return () => {
			navigator.mediaSession.metadata = null;
		};
	}, [stream.id, stream.has_thumbnail, stream.streamer_avatar, stream.streamer_name, stream.game, title]);

	// Set once: each action reads the player as it is when it comes.
	const onAction = useEffectEvent((action: MediaSessionAction, details: MediaSessionActionDetails) => {
		if (action === 'play' && !playing) togglePlay();
		else if (action === 'pause' && playing) togglePlay();
		else if (action === 'seekbackward') seekBy(-(details.seekOffset ?? 10));
		else if (action === 'seekforward') seekBy(details.seekOffset ?? 10);
		else if (action === 'seekto' && details.seekTime !== undefined) seekTo(details.seekTime);
	});
	useEffect(() => {
		if (!('mediaSession' in navigator)) return;
		const session = navigator.mediaSession;
		const actions: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'];
		for (const action of actions) {
			try {
				session.setActionHandler(action, (details) => {
					onAction(action, details);
				});
			} catch {
				// An action this browser doesn't know.
			}
		}
		return () => {
			for (const action of actions) {
				try {
					session.setActionHandler(action, null);
				} catch {
					// Same as above.
				}
			}
		};
	}, []);

	useEffect(() => {
		if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
	}, [playing]);

	// The position, for the system's own bar: once a second is plenty, read from the clock without
	// drawing anything again.
	useEffect(() => {
		if (!('mediaSession' in navigator) || !(duration > 0)) return;
		let last = -1;
		const update = () => {
			const second = Math.floor(clock.get());
			if (second === last) return;
			last = second;
			try {
				navigator.mediaSession.setPositionState({
					duration,
					position: Math.min(second, duration),
					playbackRate: 1,
				});
			} catch {
				// A position past the end, while the duration settles.
			}
		};
		update();
		return clock.subscribe(update);
	}, [clock, duration]);
}

export function StudioPage() {
	const { login, id } = useRouteParams();
	const navigate = useNavigate();
	const detail = useQuery({
		...streamQuery(id),
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
	// A link kept too long may have expired: the page opens with a fresh one.
	if (detail.isPending || (detail.isStale && detail.isFetching)) return <PageLoading />;
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

/** The part that should start playing on its own: the next one, once the previous ended. */
let playNext: number | null = null;

function Studio({ stream: initial, reload }: { stream: StreamDetail; reload: () => Promise<StreamDetail | null> }) {
	const t = useT();
	const canDownload = useCan('streams.download');
	// Only what the player uses: the theme or the language changing don't draw it again.
	const volume = usePrefs((state) => state.volume);
	const muted = usePrefs((state) => state.muted);
	const compressor = usePrefs((state) => state.compressor);
	const setPrefs = usePrefs((state) => state.set);
	const [stream, setStream] = useState(initial);
	const root = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const surface = useRef<HTMLDivElement>(null);
	const engine = useRef<Engine | null>(null);
	const [duration, setDuration] = useState(initial.duration_ms / 1000);
	const [clock] = useState(createClock);
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
	// The chat shows beside or under the video, except in full screen on a phone or tablet, where
	// the video takes it all. A choice made with the chat button holds until full screen changes.
	const [chatChoice, setChatChoice] = useState<{ fullscreen: boolean; hidden: boolean } | null>(null);
	const chatHidden = chatChoice?.fullscreen === fullscreen.active ? chatChoice.hidden : fullscreen.active && touch();
	const toggleChat = useCallback(() => {
		setChatChoice({ fullscreen: fullscreen.active, hidden: !chatHidden });
	}, [fullscreen.active, chatHidden]);

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
					clock.set(value);
				}
			};
			let playing = false;
			next.onState = (value) => {
				playing = value.playing;
				setState(value);
			};
			next.onError = (kind) => {
				if (engine.current !== next) return;
				if (kind === 'decode' && next.kind === 'mediabunny') {
					// The browser's own player takes over where this one stopped, not where it opened.
					const now = next.time();
					reopen.current(url, durationMs, now > 0 ? now : at, autoplay || playing, true);
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
		[clock],
	);

	useEffect(() => {
		reopen.current = open;
	}, [open]);

	// Opened once per recording (the page is keyed by it): a fresher answer for the same one, such
	// as the refresh button's, must not open the player again over the one playing.
	const first = useRef(initial);
	useEffect(() => {
		const start = first.current;
		const carryOn = playNext === start.id;
		playNext = null;
		open(start.video_url, start.duration_ms, carryOn ? 0 : resumeAt(start.id), carryOn);
		return () => {
			engine.current?.dispose();
			engine.current = null;
		};
	}, [open]);

	useEffect(() => {
		engine.current?.setVolume(volume, muted);
	}, [volume, muted]);

	useEffect(() => {
		engine.current?.setCompressor(compressor);
	}, [compressor]);

	// Pictures for the timeline, from the same file, opened the first time the bar is hovered.
	const preview = useMemo(() => createPreview(stream.video_url), [stream.video_url]);
	useEffect(
		() => () => {
			preview.close();
		},
		[preview],
	);

	// A broadcast cut in parts (the picture changed) plays on into the next one.
	const navigate = useNavigate();
	useEffect(() => {
		if (!state.ended) return;
		const index = stream.parts.findIndex(([id]) => id === stream.id);
		const next = index >= 0 ? stream.parts[index + 1] : undefined;
		if (!next) return;
		playNext = next[0];
		void navigate({ to: '/$login/$id', params: { login: stream.streamer_login, id: String(next[0]) } });
	}, [state.ended, stream, navigate]);

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
	useEffect(() => {
		let saved = clock.get();
		return clock.subscribe(() => {
			const time = clock.get();
			if (Math.abs(time - saved) < 5) return;
			saved = time;
			saveProgress(initial.id, time, duration);
		});
	}, [clock, duration, initial.id]);
	const durationNow = useRef(duration);
	useEffect(() => {
		durationNow.current = duration;
	}, [duration]);
	useEffect(() => {
		const save = () => {
			const at = clock.get();
			if (at > 0) saveProgress(initial.id, at, durationNow.current);
		};
		window.addEventListener('pagehide', save);
		return () => {
			window.removeEventListener('pagehide', save);
			save();
		};
	}, [clock, initial.id]);

	const seekTo = useCallback(
		(seconds: number) => {
			engine.current?.seek(seconds);
			// The bar moves at once, without waiting for the engine's next report.
			clock.set(seconds);
		},
		[clock],
	);
	// For the chat's time stamps: the same function on every draw, so its lines don't draw again.
	const seekToMs = useCallback(
		(ms: number) => {
			seekTo(ms / 1000);
		},
		[seekTo],
	);

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

	// Keyboard: the shortcuts of most players. Listened to once; each key reads the player as it is.
	const onKey = useEffectEvent((event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable], [role=menu], [role=dialog], dialog')) return;
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
			case 'c':
				toggleChat();
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
	});
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			onKey(event);
		};
		window.addEventListener('keydown', listener);
		return () => {
			window.removeEventListener('keydown', listener);
		};
	}, []);

	useMediaSession({ stream, playing: state.playing, clock, duration, togglePlay, seekBy, seekTo });

	const downloads = {
		video: stream.download_url,
		json: `/api/streams/${stream.id}/chat.json`,
		ass: `/api/streams/${stream.id}/chat.ass`,
	};
	const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
	const pseudoFullscreen = fullscreen.active && !fullscreen.native;
	// What lies on the picture shows while the pointer is over it, and while paused.
	const overlay = (hovering && controls) || !state.playing || chaptersOpen;

	return (
		<div
			ref={root}
			// Side by side on wide screens and on any screen held sideways: the video takes the full
			// height and the chat what is left of the width, within bounds. Stacked when held upright.
			style={
				{
					'--chat-width': 'clamp(min(20rem, 32vw), calc(100vw - 100dvh * 16 / 9), 36rem)',
				} as React.CSSProperties
			}
			className={`bg-bg flex h-dvh flex-col ${chatHidden ? '' : 'landscape:grid landscape:grid-cols-[minmax(0,1fr)_var(--chat-width)] lg:grid lg:grid-cols-[minmax(0,1fr)_var(--chat-width)]'} ${pseudoFullscreen ? 'fixed inset-0 z-[60]' : ''}`}
		>
			<section
				ref={stage}
				aria-label={stream.title || t.stream.untitled}
				className={`@container relative bg-black select-none ${chatHidden ? 'min-h-0 flex-1' : 'flex-none landscape:h-full landscape:min-h-0 lg:h-full lg:min-h-0 max-lg:portrait:aspect-video max-lg:portrait:max-h-[60dvh]'} ${overlay ? '' : 'cursor-none'}`}
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
				{/* On a small player the bar's own button is enough: this one would cover the picture. */}
				{!opening && !state.playing && !error ? (
					<button
						type="button"
						aria-label={t.player.play}
						onClick={togglePlay}
						className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 @max-md:hidden -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md transition-transform duration-150 hover:scale-105 @md:size-20"
					>
						<Play fill="currentColor" className="ml-1 size-6 @md:size-[34px]" />
					</button>
				) : null}
				{error ? (
					// On a small player it shrinks, so it stays clear of the title above and the controls below.
					<div className="absolute inset-0 grid place-items-center bg-black/80 px-4 pt-6 pb-12 text-center text-white @md:p-6">
						<div className="flex max-w-md flex-col items-center gap-2.5 @md:gap-4">
							<p className="text-small @md:text-body">
								{error === 'decode'
									? t.player.cantDecode
									: error === 'expired'
										? t.player.expiredLink
										: t.player.cantOpen}
							</p>
							{error === 'decode' && downloads.video ? (
								<a
									href={downloads.video}
									className={`${buttonClass('accent')} @max-md:text-small @max-md:h-8 @max-md:px-3`}
								>
									<Download size={16} />
									{t.player.downloadVideo}
								</a>
							) : (
								<Button
									variant="accent"
									className="@max-md:text-small @max-md:h-8 @max-md:px-3"
									onClick={() => void refresh()}
								>
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
					className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2 pt-8 pb-1 text-white transition-opacity duration-300 @md:px-3 @md:pt-14 @md:pb-2 @2xl:px-5 @2xl:pb-3 ${overlay ? 'opacity-100' : 'pointer-events-none opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100'}`}
				>
					<PlayheadTimeline
						clock={clock}
						scrub={scrub}
						duration={duration}
						chapters={stream.chapters}
						cuts={stream.cuts}
						preview={preview}
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
							className="@max-md:hidden"
							onClick={() => {
								seekBy(-5);
							}}
						>
							<RotateCcw size={21} />
						</PlayerButton>
						<PlayerButton
							label={t.player.forward}
							className="@max-md:hidden"
							onClick={() => {
								seekBy(5);
							}}
						>
							<RotateCw size={21} />
						</PlayerButton>
						<div className="group/volume flex items-center">
							<PlayerButton
								label={muted ? t.player.unmute : t.player.mute}
								onClick={() => {
									setPrefs({ muted: !muted });
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
								value={muted ? 0 : volume}
								style={{ '--level': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
								onChange={(event) => {
									setPrefs({ volume: event.target.valueAsNumber, muted: false });
								}}
							/>
						</div>
						<PlayerButton
							label={compressor ? t.player.compressorOn : t.player.compressorOff}
							pressed={compressor}
							className="@max-sm:hidden"
							onClick={() => {
								setPrefs({ compressor: !compressor });
							}}
						>
							<AudioLines size={21} />
						</PlayerButton>
						<span className="text-ui tabular ml-2 whitespace-nowrap text-white">
							<PlayheadTime clock={clock} scrub={scrub} />
							<span className="text-white/55 @max-md:hidden"> / {formatClock(duration)}</span>
						</span>
						<div className="flex-1" />
						{stream.chapters.length > 1 ? (
							<Chapters
								chapters={stream.chapters}
								duration={duration}
								clock={clock}
								scrub={scrub}
								open={chaptersOpen}
								setOpen={setChaptersOpen}
								onSeek={seekTo}
							/>
						) : null}
						{canDownload && downloads.video ? (
							<Menu
								label={t.player.download}
								panelClassName="text-ink"
								trigger={(_open, props) => (
									<PlayerButton label={t.player.download} {...props}>
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
							label={chatHidden ? t.player.showChat : t.player.hideChat}
							pressed={!chatHidden}
							onClick={toggleChat}
						>
							{chatHidden ? <MessageSquareOff size={21} /> : <MessageSquareText size={21} />}
						</PlayerButton>
						<PlayerButton
							label={fullscreen.active ? t.player.exitFullscreen : t.player.fullscreen}
							onClick={fullscreen.toggle}
						>
							{fullscreen.active ? <Minimize size={21} /> : <Maximize size={21} />}
						</PlayerButton>
					</div>
				</div>
			</section>

			<aside
				className={`border-line relative min-h-0 flex-1 flex-col border-t landscape:border-t-0 landscape:border-l lg:border-t-0 lg:border-l ${chatHidden ? 'hidden' : 'flex'}`}
			>
				<ChatAtPlayhead
					clock={clock}
					streamId={stream.id}
					hasChat={stream.chat_messages > 0}
					onSeek={seekToMs}
				/>
			</aside>
		</div>
	);
}

/** The timeline at the playhead, or where its handle is dragged: the only part of the controls that moves. */
function PlayheadTimeline({
	clock,
	scrub,
	...props
}: { clock: Clock; scrub: number | null } & Omit<Parameters<typeof Timeline>[0], 'time'>) {
	const time = useClock(clock);
	return <Timeline {...props} time={scrub ?? time} />;
}

/** The time played, drawn again when its second changes. */
function PlayheadTime({ clock, scrub }: { clock: Clock; scrub: number | null }) {
	const seconds = useClock(clock, Math.floor);
	return formatClock(scrub ?? seconds);
}

/** The chat at the playhead, in milliseconds. */
function ChatAtPlayhead({ clock, ...props }: { clock: Clock } & Omit<Parameters<typeof ChatPanel>[0], 'timeMs'>) {
	const timeMs = useClock(clock, (seconds) => Math.floor(seconds * 1000));
	return <ChatPanel {...props} timeMs={timeMs} />;
}

function PlayerButton({
	label,
	onClick,
	children,
	pressed,
	className = '',
	...props
}: {
	label: string;
	onClick?: () => void;
	children: ReactNode;
	pressed?: boolean;
	className?: string;
} & Partial<MenuTriggerProps>) {
	return (
		<button
			type="button"
			{...props}
			aria-label={label}
			data-tip={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={`touch-target relative grid size-10 flex-none place-items-center rounded-full text-white/90 transition-colors duration-150 hover:bg-white/15 hover:text-white aria-pressed:text-on-dark-accent sm:size-11 ${className}`}
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
			className={`absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-2.5 pt-2 pb-8 text-white transition-opacity duration-300 @md:px-3 @md:pt-3 @md:pb-16 @2xl:px-5 @2xl:pt-4 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
		>
			{/* On a small player: the title and who; the rest waits for room. */}
			<div className="flex items-center gap-3.5">
				<Link
					to="/$login"
					params={{ login }}
					aria-label={stream.streamer_name}
					className="flex-none rounded-full transition-opacity hover:opacity-85 @max-md:hidden"
				>
					<Avatar src={stream.streamer_avatar} name={stream.streamer_name} size={48} />
				</Link>
				<div className="min-w-0 flex-1">
					<h1 className="text-ui @md:text-body @2xl:text-lead truncate font-semibold [text-shadow:0_1px_3px_rgb(0_0_0/0.5)]">
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
						{stream.game ? (
							<Fact icon={<Gamepad2 size={15} />} className="@max-md:hidden">
								{stream.game}
							</Fact>
						) : null}
						<Fact icon={<CalendarDays size={15} />} className="@max-md:hidden">
							{formatDate(stream.started_at)}
						</Fact>
						{quality ? (
							<Fact icon={<MonitorPlay size={15} />} className="@max-2xl:hidden">
								{quality}
							</Fact>
						) : null}
					</div>
					{stream.error ? (
						<p className="text-small text-on-dark-danger mt-1">
							{t.stream.error}: {stream.error}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}

/** The chapter playing at a time (ms), or -1 before the first and past the end. */
function chapterAt(chapters: StreamDetail['chapters'], ms: number, endMs: number): number {
	for (let index = chapters.length - 1; index >= 0; index--) {
		const chapter = chapters[index];
		if (chapter && ms >= chapter.at_ms) return ms < (chapters[index + 1]?.at_ms ?? endMs) ? index : -1;
	}
	return -1;
}

/** The broadcast's categories, each with its start and length; picking one jumps there. */
function Chapters({
	chapters,
	duration,
	clock,
	scrub,
	open,
	setOpen,
	onSeek,
}: {
	chapters: StreamDetail['chapters'];
	duration: number;
	clock: Clock;
	scrub: number | null;
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

	// The chapter playing, only while the list is open: closed, the button draws nothing new.
	const playing = useClock(clock, (seconds) =>
		open ? chapterAt(chapters, (scrub ?? seconds) * 1000, duration * 1000) : -1,
	);
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
							const current = index === playing;
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
					<a
						href={`https://www.twitch.tv/${login}`}
						target="_blank"
						rel="noreferrer"
						className={buttonClass('accent')}
					>
						{t.channel.watchOnTwitch}
					</a>
					<Link to="/$login" params={{ login }} className={buttonClass()}>
						{stream.streamer_name}
					</Link>
				</div>
			</div>
		</div>
	);
}
