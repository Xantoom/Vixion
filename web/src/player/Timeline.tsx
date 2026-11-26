import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useT } from '@/i18n';
import type { StreamDetail } from '@/lib/api';
import { formatClock, formatDuration } from '@/lib/format';
import { boxArt } from '@/lib/twitch';
import type { Preview } from './preview';

type Chapter = StreamDetail['chapters'][number];

interface Segment {
	start: number;
	end: number;
	chapter: Chapter | null;
}

/**
 * The player's timeline, cut where the broadcast changed category or title. A press seeks at once
 * (no waiting for the release), a drag moves the handle and seeks where it is let go; hovering
 * shows the time and the chapter under the pointer.
 */
export function Timeline({
	duration,
	time,
	chapters,
	cuts,
	preview,
	onSeek,
	onScrub,
}: {
	duration: number;
	time: number;
	chapters: Chapter[];
	/** Where the broadcast is missing: (video ms, ms missing). */
	cuts: [number, number][];
	/** Pictures under the pointer, when the browser can decode the video. */
	preview: Preview | null;
	onSeek: (seconds: number) => void;
	/** The time under a dragged handle, or null when the drag ends. */
	onScrub: (seconds: number | null) => void;
}) {
	const t = useT();
	const bar = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<{ x: number; at: number; width: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const dragAt = useRef(0);

	const segments = useMemo<Segment[]>(() => {
		if (duration <= 0) return [];
		const cuts = chapters.filter((chapter) => chapter.at_ms / 1000 < duration);
		if (cuts.length <= 1) return [{ start: 0, end: duration, chapter: cuts[0] ?? null }];
		return cuts.map((chapter, index) => ({
			start: index === 0 ? 0 : chapter.at_ms / 1000,
			end: Math.min(duration, (cuts[index + 1]?.at_ms ?? duration * 1000) / 1000),
			chapter,
		}));
	}, [chapters, duration]);

	const at = (clientX: number) => {
		const box = bar.current?.getBoundingClientRect();
		if (!box || box.width === 0) return 0;
		return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration;
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || duration <= 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const target = at(event.clientX);
		dragAt.current = target;
		setDragging(true);
		onScrub(target);
		onSeek(target);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const target = at(event.clientX);
		const box = bar.current?.getBoundingClientRect();
		if (box) setHover({ x: event.clientX - box.left, at: target, width: box.width });
		if (dragging) {
			dragAt.current = target;
			onScrub(target);
		}
	};

	const onPointerUp = () => {
		if (!dragging) return;
		setDragging(false);
		onSeek(dragAt.current);
		onScrub(null);
	};

	// A slider's keys: up and right go forward, as for any slider (not the volume, as elsewhere
	// on the player), Page keys a minute. Kept from the player's own shortcuts.
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (duration <= 0 || event.ctrlKey || event.metaKey || event.altKey) return;
		const steps: Record<string, number> = {
			ArrowRight: time + 5,
			ArrowUp: time + 5,
			ArrowLeft: time - 5,
			ArrowDown: time - 5,
			PageUp: time + 60,
			PageDown: time - 60,
			Home: 0,
			End: duration - 1,
		};
		const target = steps[event.key];
		if (target === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		onSeek(Math.max(0, Math.min(duration, target)));
	};

	// The picture under the pointer, drawn when it comes; the last one stays until then.
	const picture = useRef<HTMLCanvasElement>(null);
	const [pictured, setPictured] = useState(false);
	const hoverAt = hover?.at ?? null;
	useEffect(() => {
		if (hoverAt === null || !preview) return;
		preview.request(hoverAt, (found) => {
			const canvas = picture.current;
			if (!found || !canvas) return;
			canvas.width = found.width;
			canvas.height = found.height;
			canvas.getContext('2d')?.drawImage(found, 0, 0);
			setPictured(true);
		});
	}, [hoverAt, preview]);

	const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
	const marks = cuts.filter(([at]) => at / 1000 > 0 && at / 1000 < duration);
	// A cut under the pointer, within a few pixels.
	const nearCut =
		hover && duration > 0
			? marks.find(([at]) => Math.abs((at / 1000 / duration) * hover.width - hover.x) <= 6)
			: undefined;
	const hovered = hover ? segments.find((segment) => hover.at >= segment.start && hover.at < segment.end) : null;

	return (
		<div
			ref={bar}
			role="slider"
			tabIndex={0}
			aria-label={t.player.seek}
			aria-valuemin={0}
			aria-valuemax={Math.round(duration)}
			aria-valuenow={Math.round(time)}
			aria-valuetext={formatClock(time)}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onPointerLeave={() => {
				if (dragging) return;
				setHover(null);
				setPictured(false);
			}}
			className="group/timeline relative flex h-6 w-full cursor-pointer touch-none items-center outline-none"
		>
			<div className="flex h-1 w-full gap-[3px] transition-[height] duration-150 group-hover/timeline:h-2 group-focus-visible/timeline:h-2">
				{segments.map((segment) => {
					const span = segment.end - segment.start;
					const filled = Math.max(0, Math.min(1, (time - segment.start) / (span || 1))) * 100;
					const lit = hovered === segment;
					return (
						<div
							key={segment.start}
							className={`relative h-full overflow-hidden rounded-[1px] transition-colors ${lit ? 'bg-white/55' : 'bg-white/30'}`}
							style={{ flexGrow: span, flexBasis: 0 }}
						>
							{/* One gradient across the whole bar: each chapter shows its own stretch of it. */}
							<div
								className="bg-accent-fill absolute inset-0"
								style={{
									clipPath: `inset(0 ${100 - filled}% 0 0)`,
									backgroundSize: `${(duration / (span || 1)) * 100}% 100%`,
									backgroundPosition: `${duration > span ? (segment.start / (duration - span)) * 100 : 0}% 0`,
								}}
							/>
						</div>
					);
				})}
			</div>
			{marks.map(([at, lost]) => (
				<span
					key={at}
					aria-hidden
					data-lost={lost}
					className="pointer-events-none absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.55)] transition-[height] duration-150 group-hover/timeline:h-4"
					style={{ left: `${(at / 1000 / duration) * 100}%` }}
				/>
			))}
			<span
				className={`pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-transform duration-150 ${dragging ? 'scale-110' : 'scale-0 group-hover/timeline:scale-100 group-focus-visible/timeline:scale-100'}`}
				style={{ left: `${progress}%` }}
			/>
			{hover ? (
				<div
					className="tooltip-in pointer-events-none absolute bottom-full mb-3 flex w-max max-w-72 -translate-x-1/2 flex-col overflow-hidden rounded-sm bg-black/85 text-white shadow-lg backdrop-blur-sm"
					style={{ left: Math.max(84, Math.min(hover.width - 84, hover.x)) }}
				>
					<canvas
						ref={picture}
						aria-hidden
						className={`aspect-video w-40 bg-black object-cover ${preview && pictured ? 'block' : 'hidden'}`}
					/>
					<div className="flex items-center gap-2.5 px-2.5 py-2">
						{hovered?.chapter?.game && segments.length > 1 && !(preview && pictured) ? (
							<img
								src={boxArt(hovered.chapter.game)}
								alt=""
								referrerPolicy="no-referrer"
								className="h-12 w-9 flex-none rounded-[3px] object-cover"
							/>
						) : null}
						<span className="flex min-w-0 flex-col">
							{segments.length > 1 && hovered?.chapter ? (
								<span className="text-small max-w-36 truncate font-semibold">
									{hovered.chapter.game ?? hovered.chapter.title}
								</span>
							) : null}
							{nearCut ? (
								<span className="text-small font-semibold">
									{t.player.cut(formatDuration(nearCut[1]))}
								</span>
							) : null}
							<span className="text-small x-tabular text-white/80">{formatClock(hover.at)}</span>
						</span>
					</div>
				</div>
			) : null}
		</div>
	);
}
