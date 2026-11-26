import { useQuery } from '@tanstack/react-query';
import { ArrowDown, Gem, Megaphone, Star, Sword, Video } from 'lucide-react';
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type ChatAssets, type ChatLine, api } from '@/lib/api';
import { formatClock, formatDate } from '@/lib/format';
import { Spinner } from '@/ui/Spinner';
import { badgeInfo, badgeLabel } from './badges';
import { fragments, nameColor, useChat } from './chat';

/** Drawn while the channel's badge pictures load, or when Twitch has none. */
const FALLBACK: Record<string, { icon: ReactNode; className: string }> = {
	broadcaster: { icon: <Video size={12} strokeWidth={2.6} />, className: 'bg-live text-white' },
	moderator: { icon: <Sword size={12} strokeWidth={2.6} />, className: 'bg-[#00ad03] text-white' },
	vip: { icon: <Gem size={12} strokeWidth={2.6} />, className: 'bg-[#e005b9] text-white' },
	subscriber: { icon: <Star size={12} strokeWidth={2.6} />, className: 'bg-accent text-accent-ink' },
};

type Assets = ChatAssets | undefined;

function Badges({ line, assets }: { line: ChatLine; assets: Assets }) {
	const t = useT();
	if (!line.b) return null;
	const info = badgeInfo(line.bi);
	return (
		<>
			{line.b.split(',').map((entry) => {
				const slash = entry.indexOf('/');
				const set = slash > 0 ? entry.slice(0, slash) : entry;
				const version = slash > 0 ? entry.slice(slash + 1) : '';
				const [url, title] = assets?.badges[entry] ?? [];
				const label = badgeLabel(set, version, info, title, t.player.badges);
				if (url) {
					return (
						<img
							key={entry}
							src={url}
							alt={label}
							data-tip={label}
							data-tip-img={url}
							loading="lazy"
							referrerPolicy="no-referrer"
							className="mr-1 inline-block size-[1.125rem] -translate-y-px align-middle"
						/>
					);
				}
				const fallback = FALLBACK[set];
				return fallback ? (
					<span
						key={entry}
						role="img"
						aria-label={label}
						data-tip={label}
						className={`mr-1 inline-grid size-[1.125rem] -translate-y-px place-items-center rounded-xs align-middle ${fallback.className}`}
					>
						{fallback.icon}
					</span>
				) : null;
			})}
		</>
	);
}

function Emote({
	name,
	src,
	srcSet,
	big,
	from,
	square = false,
}: {
	name: string;
	src: string;
	srcSet?: string;
	big: string;
	from: string;
	/** Twitch's emotes are all square: their room is kept before they load, so lines don't move. */
	square?: boolean;
}) {
	return (
		<img
			src={src}
			srcSet={srcSet}
			alt={name}
			data-tip={name}
			data-tip-sub={from}
			data-tip-img={big}
			// Not lazy: only the lines at the playhead are drawn, and an emote showing up a frame
			// after its line pushes the lines around on every jump.
			referrerPolicy="no-referrer"
			// Sized by the text around it and overflowing the line a little, as on Twitch: the lines
			// keep their spacing whether or not they hold an emote. Never stretched, whatever room
			// it is given.
			className={`-my-[0.3em] inline-block h-[1.75em] max-w-full object-contain align-middle ${square ? 'w-[1.75em]' : 'w-auto'}`}
		/>
	);
}

const TWITCH_EMOTES = 'https://static-cdn.jtvnw.net/emoticons/v2';

/** Text with Twitch's emotes (from the message's tags) and the channel's 7TV, BTTV and FFZ ones (by word). */
function Message({ text, emotes, assets }: { text: string; emotes: string | undefined; assets: Assets }) {
	const words = assets?.emotes;
	return (
		<>
			{fragments(text, emotes).map((part, index) =>
				'emote' in part ? (
					<Emote
						// oxlint-disable-next-line no-array-index-key
						key={index}
						name={part.name}
						// Drawn smaller than its larger files, never larger than its smallest: the 1x file
						// blown up on a screen scaled 125 % (most Windows laptops) is what looked blurry.
						src={`${TWITCH_EMOTES}/${part.emote}/default/dark/2.0`}
						srcSet={`${TWITCH_EMOTES}/${part.emote}/default/dark/2.0 1x, ${TWITCH_EMOTES}/${part.emote}/default/dark/3.0 2x`}
						big={`${TWITCH_EMOTES}/${part.emote}/default/dark/3.0`}
						square
						from="Twitch"
					/>
				) : words ? (
					// oxlint-disable-next-line no-array-index-key
					<span key={index}>
						{part.text.split(/(\s+)/).map((word, at) => {
							const emote = words[word];
							return emote ? (
								<Emote
									// oxlint-disable-next-line no-array-index-key
									key={at}
									name={word}
									src={emote[1]}
									big={emote[1]}
									from={emote[2]}
								/>
							) : (
								word
							);
						})}
					</span>
				) : (
					// oxlint-disable-next-line no-array-index-key
					<span key={index}>{part.text}</span>
				),
			)}
		</>
	);
}

function Name({ line }: { line: ChatLine }) {
	const t = useT();
	const name = line.n || line.u || '';
	// Names in another script (日本語) or spelled differently: the login is what Twitch's URL uses.
	const shown = line.n && line.u && line.n.toLowerCase() !== line.u ? `${line.n} (${line.u})` : name;
	const style = { '--x-color': nameColor(line) } as React.CSSProperties;
	return line.u ? (
		<a
			href={`https://www.twitch.tv/${line.u}`}
			target="_blank"
			rel="noreferrer"
			data-tip={t.player.openOnTwitch(shown)}
			className="x-readable font-bold"
			style={style}
		>
			{name}
		</a>
	) : (
		<span className="x-readable font-bold" style={style}>
			{name}
		</span>
	);
}

const Line = memo(function Line({
	line,
	deleted,
	assets,
	onSeek,
}: {
	line: ChatLine;
	deleted: boolean;
	assets: Assets;
	onSeek: (ms: number) => void;
}) {
	const t = useT();
	const [revealed, setRevealed] = useState(false);
	const stamp = (
		<button
			type="button"
			tabIndex={-1}
			onClick={() => {
				onSeek(line.o);
			}}
			data-tip={t.player.seekHere}
			data-tip-sub={formatDate(line.t)}
			className="text-caption text-muted hover:text-accent-text x-tabular mr-2 rounded-xs align-baseline transition-colors pointer-coarse:-mx-1 pointer-coarse:px-1 pointer-coarse:py-1.5"
		>
			{formatClock(line.o / 1000)}
		</button>
	);
	if (line.k === 'n') {
		return (
			<li className="px-3 py-1">
				<div className="border-accent bg-accent-soft text-caption rounded-r-xs border-l-2 px-2.5 py-1.5 leading-relaxed">
					{stamp}
					<span className="text-accent-text font-semibold">
						<Megaphone size={14} className="mr-1.5 inline -translate-y-px" />
						{line.s || t.player.notice}
					</span>
					{line.m ? (
						<div className="mt-0.5">
							<Name line={line} />: <Message text={line.m} emotes={line.e} assets={assets} />
						</div>
					) : null}
				</div>
			</li>
		);
	}
	const action = line.k === 'a';
	const hidden = deleted && !revealed;
	return (
		<li className={`hover:bg-surface text-caption px-3 py-0.5 leading-relaxed ${hidden ? 'opacity-45' : ''}`}>
			{stamp}
			<Badges line={line} assets={assets} />
			<Name line={line} />
			{action ? ' ' : <span className="text-muted">: </span>}
			{deleted ? (
				// Kept by the recording: one click shows what was said, quietly.
				<button
					type="button"
					onClick={() => {
						setRevealed(!revealed);
					}}
					aria-expanded={revealed}
					data-tip={revealed ? t.player.hideDeleted : t.player.showDeleted}
					className={`text-muted inline rounded-xs text-left ${revealed ? '' : 'italic hover:text-ink'}`}
				>
					{revealed && line.m ? (
						<Message text={line.m} emotes={line.e} assets={assets} />
					) : (
						<>&lt;{t.player.deletedMessage}&gt;</>
					)}
				</button>
			) : (
				<span className={action ? 'italic' : ''} style={action ? { color: nameColor(line) } : undefined}>
					<Message text={line.m ?? ''} emotes={line.e} assets={assets} />
				</span>
			)}
		</li>
	);
});

/**
 * The chat as it was at the playhead: the last hundred lines, following the newest. Scrolling up
 * stops following and reveals older lines; a button brings the reader back down.
 */
export function ChatPanel({
	streamId,
	timeMs,
	onSeek,
	hasChat,
}: {
	streamId: number;
	timeMs: number;
	onSeek: (ms: number) => void;
	hasChat: boolean;
}) {
	const t = useT();
	const { data: assets } = useQuery({
		queryKey: ['chat-assets', streamId],
		queryFn: async () => api.get<ChatAssets>(`/streams/${streamId}/chat-assets`),
		staleTime: 60 * 60_000,
		enabled: hasChat,
	});
	const { lines, loading, epoch, pin, showOlder } = useChat(streamId, timeMs);
	const scroller = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const [lastEpoch, setLastEpoch] = useState(epoch);
	// A jump brings the panel back to the playhead.
	if (epoch !== lastEpoch) {
		setLastEpoch(epoch);
		setFollowing(true);
	}

	// Deletions and clears apply to lines already shown.
	const { visible, deleted } = useMemo(() => {
		const removed = new Set<string>();
		const cleared = new Map<string, number>();
		let clearedAll = -1;
		for (const line of lines) {
			if (line.k === 'd' && line.i) removed.add(line.i);
			if (line.k === 'x') {
				if (line.u) cleared.set(line.u, line.o);
				else clearedAll = line.o;
			}
		}
		const isDeleted = (line: ChatLine) =>
			(line.i !== undefined && removed.has(line.i)) ||
			line.o <= clearedAll ||
			(line.u !== undefined && (cleared.get(line.u) ?? -1) >= line.o);
		return {
			visible: lines.filter((line) => line.k === 'm' || line.k === 'a' || line.k === 'n'),
			deleted: isDeleted,
		};
	}, [lines]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && following) element.scrollTop = element.scrollHeight;
	}, [visible, following]);

	// Read on scroll and resize without re-subscribing on every line; kept before paint, so that a
	// resize in the same frame as a jump already knows the panel follows again.
	const latest = useRef({ lines, following, pin, showOlder });
	useLayoutEffect(() => {
		latest.current = { lines, following, pin, showOlder };
	});

	// Emotes and badges load after their lines and make them taller, and the panel itself changes
	// height (full screen, a phone turned, the window resized): it stays at the bottom.
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = scroller.current;
		const inner = content.current;
		if (!element || !inner) return;
		const observer = new ResizeObserver(() => {
			if (latest.current.following) element.scrollTop = element.scrollHeight;
		});
		observer.observe(inner);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, []);

	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		let lastTop = element.scrollTop;
		const onScroll = () => {
			const current = latest.current;
			const top = element.scrollTop;
			const bottom = element.scrollHeight - top - element.clientHeight < 40;
			// Only the reader going up stops following. Lines and emotes that load at once (a jump,
			// resuming a recording) make the panel taller before it catches up: that is no reason.
			const wentUp = top < lastTop - 2;
			lastTop = top;
			const follow = current.following ? bottom || !wentUp : bottom;
			if (follow !== current.following) {
				setFollowing(follow);
				// Reading back: the lines stay put while new ones arrive below.
				current.pin(follow ? null : (current.lines[0] ?? null));
			}
			if (!follow && top < 300) current.showOlder();
		};
		element.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			element.removeEventListener('scroll', onScroll);
		};
	}, []);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div
				ref={scroller}
				className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-wrap:anywhere] ${following ? '[overflow-anchor:none]' : '[overflow-anchor:auto]'}`}
			>
				<div ref={content} className="py-2">
					{!hasChat ? (
						<p className="text-small text-muted px-3 py-6 text-center">{t.player.noChat}</p>
					) : visible.length === 0 ? (
						<div className="text-small text-muted grid place-items-center px-3 py-6 text-center">
							{loading ? <Spinner /> : t.player.chatEmpty}
						</div>
					) : (
						<ul className="flex flex-col">
							{visible.map((line) => (
								<Line
									key={`${line.o}-${line.i ?? line.t}`}
									line={line}
									deleted={deleted(line)}
									assets={assets}
									onSeek={onSeek}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
			{following ? null : (
				<button
					type="button"
					onClick={() => {
						setFollowing(true);
						pin(null);
					}}
					className="menu-in bg-tip text-tip-ink text-small absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-sm px-3.5 py-1.5 font-medium whitespace-nowrap shadow-lg"
				>
					<ArrowDown size={14} />
					{t.player.goLive}
				</button>
			)}
		</div>
	);
}
