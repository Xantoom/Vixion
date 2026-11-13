import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { StreamDetail } from '@/lib/api';
import { formatClock } from '@/lib/format';

type Chapter = StreamDetail['chapters'][number];

interface Segment {
	start: number;
	end: number;
	chapter: Chapter | null;
}

/** Box art of a Twitch category, from its name. */
export function boxArt(game: string): string {
	return `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(game)}-72x96.jpg`;
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
	onSeek,
	onScrub,
}: {
	duration: number;
	time: number;
	chapters: Chapter[];
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

	const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
	const hovered = hover ? segments.find((segment) => hover.at >= segment.start && hover.at < segment.end) : null;

	return (
		<div
			ref={bar}
			role="slider"
			tabIndex={0}
			aria-label={t.player.chapters}
			aria-valuemin={0}
			aria-valuemax={Math.round(duration)}
			aria-valuenow={Math.round(time)}
			aria-valuetext={formatClock(time)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onPointerLeave={() => {
				if (!dragging) setHover(null);
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
							<div
								className="absolute inset-y-0 left-0 bg-[var(--accent)]"
								style={{ width: `${filled}%` }}
							/>
						</div>
					);
				})}
			</div>
			<span
				className={`pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-transform duration-150 ${dragging ? 'scale-110' : 'scale-0 group-hover/timeline:scale-100 group-focus-visible/timeline:scale-100'}`}
				style={{ left: `${progress}%` }}
			/>
			{hover ? (
				<div
					className="tooltip-in pointer-events-none absolute bottom-full mb-3 flex max-w-72 -translate-x-1/2 items-center gap-2.5 rounded-sm bg-black/85 px-2.5 py-2 text-white shadow-lg backdrop-blur-sm"
					style={{ left: Math.max(80, Math.min(hover.width - 80, hover.x)) }}
				>
					{hovered?.chapter?.game && segments.length > 1 ? (
						<img
							src={boxArt(hovered.chapter.game)}
							alt=""
							referrerPolicy="no-referrer"
							className="h-12 w-9 flex-none rounded-[3px] object-cover"
						/>
					) : null}
					<span className="flex min-w-0 flex-col">
						{segments.length > 1 && hovered?.chapter ? (
							<span className="text-small truncate font-semibold">
								{hovered.chapter.game ?? hovered.chapter.title}
							</span>
						) : null}
						<span className="text-small tabular text-white/80">{formatClock(hover.at)}</span>
					</span>
				</div>
			) : null}
		</div>
	);
}
