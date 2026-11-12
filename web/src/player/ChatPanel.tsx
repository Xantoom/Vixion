import { useQuery } from '@tanstack/react-query';
import { ArrowDown, Gem, Megaphone, MessageSquare, Star, Sword, Video } from 'lucide-react';
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type ChatAssets, type ChatLine, api } from '@/lib/api';
import { formatClock, formatNumber } from '@/lib/format';
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
							title={name}
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
						title={badge.label}
						className={`mr-1 inline-grid size-[1.125rem] -translate-y-px place-items-center rounded-[4px] align-middle ${badge.className}`}
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
			title={name}
			loading="lazy"
			referrerPolicy="no-referrer"
			className="-my-1.5 inline-block h-8 w-auto align-middle"
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
			title={t.player.openOnTwitch(name)}
			className="chat-name font-bold hover:underline"
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

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
			title={`${t.player.seekHere} · ${clockFormat.format(line.t)}`}
			className="text-caption text-muted hover:text-accent-text tabular pt-px text-right hover:underline"
		>
			{formatClock(line.o / 1000)}
		</button>
	);
	if (line.k === 'n') {
		return (
			<li className="grid grid-cols-[3.75rem_1fr] gap-x-2 px-2 py-1">
				{stamp}
				<div className="border-accent bg-accent-soft rounded-r-xs border-l-2 px-2.5 py-1.5">
					<div className="text-small text-accent-text flex items-center gap-1.5 font-semibold">
						<Megaphone size={14} />
						{line.s || t.player.notice}
					</div>
					{line.m ? (
						<div className="text-ui mt-0.5 break-words">
							<Name line={line} />: <Message text={line.m} emotes={line.e} assets={assets} />
						</div>
					) : null}
				</div>
			</li>
		);
	}
	const action = line.k === 'a';
	return (
		<li
			className={`hover:bg-surface grid grid-cols-[3.75rem_1fr] gap-x-2 rounded-xs px-2 py-1 ${deleted ? 'opacity-45' : ''}`}
		>
			{stamp}
			<div className="text-ui leading-relaxed break-words">
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
			</div>
		</li>
	);
});

/**
 * The chat as it was at the playhead. It follows the newest line unless the reader scrolled up,
 * in which case a button brings them back down.
 */
export function ChatPanel({
	streamId,
	timeMs,
	recording,
	onSeek,
	hasChat,
	count,
}: {
	streamId: number;
	timeMs: number;
	recording: boolean;
	onSeek: (ms: number) => void;
	hasChat: boolean;
	count: number;
}) {
	const t = useT();
	const { data: assets } = useQuery({
		queryKey: ['chat-assets', streamId],
		queryFn: async () => api.get<ChatAssets>(`/streams/${streamId}/chat-assets`),
		staleTime: 60 * 60_000,
		enabled: hasChat,
	});
	const { lines, loading } = useChat(streamId, timeMs, recording);
	const scroller = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);

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

	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const onScroll = () => {
			setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
		};
		element.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			element.removeEventListener('scroll', onScroll);
		};
	}, []);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div className="border-line text-ui flex h-12 flex-none items-center justify-between border-b px-4 font-semibold">
				<span className="flex items-center gap-2">
					<MessageSquare size={18} className="text-muted" />
					{t.player.chat}
				</span>
				{count > 0 ? (
					<span className="text-small text-muted tabular font-medium">{formatNumber(count)}</span>
				) : null}
			</div>
			<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-2">
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
			{following ? null : (
				<button
					type="button"
					onClick={() => {
						setFollowing(true);
					}}
					className="menu-in bg-tip text-tip-ink text-small absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium shadow-lg"
				>
					<ArrowDown size={14} />
					{t.player.goLive}
				</button>
			)}
		</div>
	);
}
