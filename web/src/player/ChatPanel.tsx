import { useQuery } from '@tanstack/react-query';
import { ArrowDown, Gem, Megaphone, Star, Sword, Video } from 'lucide-react';
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type ChatAssets, type ChatLine, api } from '@/lib/api';
import { formatClock } from '@/lib/format';
import { Spinner } from '@/ui/Spinner';
import { fragments, nameColor, useChat } from './chat';

const BADGES: Record<string, { icon: ReactNode; className: string; label: string }> = {
	broadcaster: { icon: <Video size={12} strokeWidth={2.6} />, className: 'bg-live text-white', label: 'Broadcaster' },
	moderator: {
		icon: <Sword size={12} strokeWidth={2.6} />,
		className: 'bg-[#00ad03] text-white',
		label: 'Moderator',
	},
	vip: { icon: <Gem size={12} strokeWidth={2.6} />, className: 'bg-[#e005b9] text-white', label: 'VIP' },
	subscriber: {
		icon: <Star size={12} strokeWidth={2.6} />,
		className: 'bg-accent text-accent-ink',
		label: 'Subscriber',
	},
};

type Assets = ChatAssets | undefined;

function Badges({ badges, assets }: { badges: string | undefined; assets: Assets }) {
	if (!badges) return null;
	return (
		<>
			{badges.split(',').map((entry) => {
				const url = assets?.badges[entry];
				const name = entry.split('/')[0] ?? '';
				if (url) {
					return (
						<img
							key={entry}
							src={url}
							alt=""
							data-tip={name}
							loading="lazy"
							referrerPolicy="no-referrer"
							className="mr-1 inline-block size-[1.125rem] -translate-y-px align-middle"
						/>
					);
				}
				const badge = BADGES[name];
				return badge ? (
					<span
						key={entry}
						data-tip={badge.label}
						className={`mr-1 inline-grid size-[1.125rem] -translate-y-px place-items-center rounded-xs align-middle ${badge.className}`}
					>
						{badge.icon}
					</span>
				) : null;
			})}
		</>
	);
}

function Emote({ name, src, srcSet }: { name: string; src: string; srcSet: string }) {
	return (
		<img
			src={src}
			srcSet={srcSet}
			alt={name}
			data-tip={name}
			loading="lazy"
			referrerPolicy="no-referrer"
			className="-my-1.5 inline-block h-8 w-auto max-w-full align-middle"
		/>
	);
}

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
						src={`https://static-cdn.jtvnw.net/emoticons/v2/${part.emote}/default/dark/1.0`}
						srcSet={`https://static-cdn.jtvnw.net/emoticons/v2/${part.emote}/default/dark/2.0 2x`}
					/>
				) : words ? (
					// oxlint-disable-next-line no-array-index-key
					<span key={index}>
						{part.text.split(/(\s+)/).map((word, at) => {
							const emote = words[word];
							return emote ? (
								// oxlint-disable-next-line no-array-index-key
								<Emote key={at} name={word} src={emote[0]} srcSet={`${emote[1]} 2x`} />
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
	const style = { '--name': nameColor(line) } as React.CSSProperties;
	return line.u ? (
		<a
			href={`https://www.twitch.tv/${line.u}`}
			target="_blank"
			rel="noreferrer"
			data-tip={t.player.openOnTwitch(name)}
			className="chat-name font-bold"
			style={style}
		>
			{name}
		</a>
	) : (
		<span className="chat-name font-bold" style={style}>
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
	const stamp = (
		<button
			type="button"
			tabIndex={-1}
			onClick={() => {
				onSeek(line.o);
			}}
			data-tip={t.player.seekHere}
			className="text-caption text-muted hover:text-accent-text tabular mr-2 align-baseline transition-colors"
		>
			{formatClock(line.o / 1000)}
		</button>
	);
	if (line.k === 'n') {
		return (
			<li className="px-3 py-1">
				<div className="border-accent bg-accent-soft text-small rounded-r-xs border-l-2 px-2.5 py-1.5 leading-relaxed">
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
	return (
		<li className={`hover:bg-surface text-small px-3 py-0.5 leading-relaxed ${deleted ? 'opacity-45' : ''}`}>
			{stamp}
			<Badges badges={line.b} assets={assets} />
			<Name line={line} />
			{action ? ' ' : <span className="text-muted">: </span>}
			{deleted ? (
				<span className="text-muted italic">&lt;{t.player.deletedMessage}&gt;</span>
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

	// Read on scroll without re-subscribing on every line.
	const latest = useRef({ lines, following, pin, showOlder });
	useEffect(() => {
		latest.current = { lines, following, pin, showOlder };
	});

	// Emotes and badges load after their lines and make them taller: the panel stays at the bottom.
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = scroller.current;
		const inner = content.current;
		if (!element || !inner) return;
		const observer = new ResizeObserver(() => {
			if (latest.current.following) element.scrollTop = element.scrollHeight;
		});
		observer.observe(inner);
		return () => {
			observer.disconnect();
		};
	}, []);

	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const onScroll = () => {
			const current = latest.current;
			const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
			if (bottom !== current.following) {
				setFollowing(bottom);
				// Reading back: the lines stay put while new ones arrive below.
				current.pin(bottom ? null : (current.lines[0] ?? null));
			}
			if (!bottom && element.scrollTop < 300) current.showOlder();
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
