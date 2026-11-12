import { ArrowDown, Gem, Megaphone, Star, Sword, Video } from 'lucide-react';
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { ChatLine } from '@/lib/api';
import { formatClock } from '@/lib/format';
import { Spinner } from '@/ui/Spinner';
import { fragments, nameColor, useChat } from './chat';

const BADGES: Record<string, { icon: ReactNode; className: string; label: string }> = {
	broadcaster: { icon: <Video size={11} strokeWidth={2.6} />, className: 'bg-live text-white', label: 'Broadcaster' },
	moderator: {
		icon: <Sword size={11} strokeWidth={2.6} />,
		className: 'bg-[#00ad03] text-white',
		label: 'Moderator',
	},
	vip: { icon: <Gem size={11} strokeWidth={2.6} />, className: 'bg-[#e005b9] text-white', label: 'VIP' },
	subscriber: {
		icon: <Star size={11} strokeWidth={2.6} />,
		className: 'bg-accent text-accent-ink',
		label: 'Subscriber',
	},
};

function Badges({ badges }: { badges: string | undefined }) {
	if (!badges) return null;
	const known = badges
		.split(',')
		.map((badge) => badge.split('/')[0] ?? '')
		.filter((name) => name in BADGES);
	return (
		<>
			{known.map((name) => {
				const badge = BADGES[name];
				return badge ? (
					<span
						key={name}
						title={badge.label}
						className={`mr-1 inline-grid size-4 translate-y-[2px] place-items-center rounded-[4px] ${badge.className}`}
					>
						{badge.icon}
					</span>
				) : null;
			})}
		</>
	);
}

function Message({ text, emotes }: { text: string; emotes: string | undefined }) {
	return (
		<>
			{fragments(text, emotes).map((part, index) =>
				'emote' in part ? (
					<img
						// oxlint-disable-next-line no-array-index-key
						key={index}
						src={`https://static-cdn.jtvnw.net/emoticons/v2/${part.emote}/default/dark/1.0`}
						srcSet={`https://static-cdn.jtvnw.net/emoticons/v2/${part.emote}/default/dark/2.0 2x`}
						alt={part.name}
						title={part.name}
						loading="lazy"
						referrerPolicy="no-referrer"
						className="-my-1 inline-block h-7 w-auto align-middle"
					/>
				) : (
					// oxlint-disable-next-line no-array-index-key
					<span key={index}>{part.text}</span>
				),
			)}
		</>
	);
}

const Line = memo(function Line({
	line,
	deleted,
	onSeek,
}: {
	line: ChatLine;
	deleted: boolean;
	onSeek: (ms: number) => void;
}) {
	const t = useT();
	if (line.k === 'n') {
		return (
			<li className="border-accent bg-accent-soft my-1 rounded-r-xs border-l-2 px-2.5 py-1.5">
				<div className="text-caption text-accent-text flex items-center gap-1.5 font-semibold">
					<Megaphone size={13} />
					{line.s || t.player.notice}
				</div>
				{line.m ? (
					<div className="text-small mt-0.5 break-words">
						<span
							className="chat-name font-semibold"
							style={{ '--name': nameColor(line) } as React.CSSProperties}
						>
							{line.n || line.u}
						</span>
						: <Message text={line.m} emotes={line.e} />
					</div>
				) : null}
			</li>
		);
	}
	const action = line.k === 'a';
	return (
		<li
			className={`group text-small rounded-xs px-2 py-[3px] break-words hover:bg-surface ${deleted ? 'opacity-45' : ''}`}
		>
			<button
				type="button"
				tabIndex={-1}
				onClick={() => {
					onSeek(line.o);
				}}
				className="text-muted mr-1.5 hidden font-mono text-[0.75rem] group-hover:inline hover:underline"
			>
				{formatClock(line.o / 1000)}
			</button>
			<Badges badges={line.b} />
			<span className="chat-name font-semibold" style={{ '--name': nameColor(line) } as React.CSSProperties}>
				{line.n || line.u}
			</span>
			{action ? ' ' : <span className="text-muted">: </span>}
			{deleted ? (
				<span className="text-muted italic">&lt;{t.player.deletedMessage}&gt;</span>
			) : (
				<span className={action ? 'italic' : ''} style={action ? { color: nameColor(line) } : undefined}>
					<Message text={line.m ?? ''} emotes={line.e} />
				</span>
			)}
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
}: {
	streamId: number;
	timeMs: number;
	recording: boolean;
	onSeek: (ms: number) => void;
	hasChat: boolean;
}) {
	const t = useT();
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
