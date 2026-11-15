import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, OctagonAlert, Pause, Play, Trash2, X } from 'lucide-react';
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type Alert, type LogEntry, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan } from '@/lib/session';
import { IconButton } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Segmented, TextInput } from '@/ui/Field';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

const MAX_LINES = 2000;
type Level = 'all' | 'warn' | 'error';

const LEVEL_STYLE: Record<string, string> = {
	error: 'text-danger',
	warn: 'text-warn',
	info: 'text-ink-2',
	debug: 'text-muted',
	trace: 'text-muted',
};

// Made once: a formatter costs far more to build than to use, and there are thousands of lines.
const CLOCK = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false,
});
const DAY = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit' });

/** The hour, and the day too when it isn't today. */
function time(at: number): string {
	const date = new Date(at);
	const clock = CLOCK.format(date);
	if (date.toDateString() === new Date().toDateString()) return clock;
	return `${DAY.format(date)} ${clock}`;
}

/** What the filter looks in, lowercased once per line rather than on every key typed. */
const haystacks = new WeakMap<LogEntry, string>();
function haystack(line: LogEntry): string {
	let text = haystacks.get(line);
	if (text === undefined) {
		text = `${line.message}\n${line.fields}\n${line.target}`.toLowerCase();
		haystacks.set(line, text);
	}
	return text;
}

/** One line of the console: drawn once, not again for each line that arrives after it. */
const LogRow = memo(function LogRow({ line }: { line: LogEntry }) {
	return (
		<div className="hover:bg-surface flex flex-wrap gap-x-3 rounded-[3px] px-1 whitespace-pre-wrap sm:flex-nowrap">
			<span className="text-muted flex-none tabular">{time(line.at)}</span>
			<span className={`w-11 flex-none uppercase ${LEVEL_STYLE[line.level] ?? ''}`}>{line.level}</span>
			<span className="min-w-0 break-words max-sm:basis-full max-sm:pb-1">
				<span className="text-ink">{line.message}</span>
				{line.fields ? <span className="text-muted"> {line.fields}</span> : null}
				{/* Vixion's own lines don't repeat its name; a library's say which. */}
				{line.target.startsWith('vixion') ? null : <span className="text-muted/60"> {line.target}</span>}
			</span>
		</div>
	);
});

export function LogsPage() {
	const can = useCan('logs.view');
	if (!can) return <NotFound forbidden />;
	return (
		<div className="panel-in flex flex-col gap-8">
			<Alerts />
			<Console />
		</div>
	);
}

function Alerts() {
	const t = useT();
	const client = useQueryClient();
	const { data, isPending } = useQuery({
		queryKey: ['alerts'],
		queryFn: async () => api.get<Alert[]>('/alerts'),
		refetchInterval: 20_000,
	});
	const open = (data ?? []).filter((alert) => !alert.resolved);

	const dismiss = async (id: number) => {
		try {
			await api.post(`/alerts/${id}/dismiss`);
			await client.invalidateQueries({ queryKey: ['alerts'] });
		} catch (error) {
			toast.error(error);
		}
	};

	// Nothing wrong: one quiet line rather than an empty card.
	if (isPending) return null;
	if (open.length === 0) {
		return (
			<p className="reveal text-small text-muted -mt-2 flex items-center gap-2.5">
				<CircleCheck size={16} className="text-ok" />
				{t.logs.noAlerts}
			</p>
		);
	}
	return (
		<Card title={t.logs.alerts} count={open.length} flush className="reveal">
			{
				<ul className="divide-line divide-y">
					{open.map((alert) => (
						<li key={alert.id} className="flex items-start gap-3.5 px-6 py-4">
							{alert.level === 'error' ? (
								<OctagonAlert size={18} className="text-danger mt-0.5 flex-none" />
							) : alert.level === 'warning' ? (
								<CircleAlert size={18} className="text-warn mt-0.5 flex-none" />
							) : (
								<Info size={18} className="text-muted mt-0.5 flex-none" />
							)}
							<div className="min-w-0 flex-1">
								<p className="text-ui break-words">{alert.message}</p>
								<p className="text-caption text-muted mt-0.5">{formatRelative(alert.created_at)}</p>
							</div>
							<IconButton size="sm" label={t.logs.dismiss} onClick={() => void dismiss(alert.id)}>
								<X size={16} />
							</IconButton>
						</li>
					))}
				</ul>
			}
		</Card>
	);
}

function Console() {
	const t = useT();
	const [lines, setLines] = useState<LogEntry[]>([]);
	const [paused, setPaused] = useState(false);
	const [level, setLevel] = useState<Level>('all');
	const [filter, setFilter] = useState('');
	const [connected, setConnected] = useState(false);
	const [waiting, setWaiting] = useState(0);
	const pausedRef = useRef(paused);
	const held = useRef<LogEntry[]>([]);
	const scroller = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	useEffect(() => {
		pausedRef.current = paused;
	}, [paused]);

	useEffect(() => {
		let source: EventSource | null = null;
		let cancelled = false;
		// Lines arriving together (a burst of logs) are added together, once per frame.
		let queued: LogEntry[] = [];
		let frame = 0;
		const flush = () => {
			frame = 0;
			const entries = queued;
			queued = [];
			if (pausedRef.current) {
				held.current = [...held.current, ...entries].slice(-MAX_LINES);
				setWaiting(held.current.length);
				return;
			}
			setLines((current) => [...current, ...entries].slice(-MAX_LINES));
		};
		const push = (entry: LogEntry) => {
			queued.push(entry);
			// A hidden tab draws no frames: what waits is kept to what the console would show.
			if (queued.length > MAX_LINES) queued = queued.slice(-MAX_LINES);
			if (frame === 0) frame = requestAnimationFrame(flush);
		};
		api.get<LogEntry[]>('/logs')
			.then((recent) => {
				if (cancelled) return;
				setLines(recent.slice(-MAX_LINES));
				source = new EventSource('/api/logs/live', { withCredentials: true });
				source.onopen = () => {
					setConnected(true);
				};
				source.onerror = () => {
					setConnected(false);
				};
				source.onmessage = (event: MessageEvent<string>) => {
					try {
						push(JSON.parse(event.data) as LogEntry);
					} catch {
						// A line that isn't JSON is skipped.
					}
				};
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			source?.close();
		};
	}, []);

	useEffect(() => {
		if (!paused && held.current.length > 0) {
			const entries = held.current;
			held.current = [];
			setWaiting(0);
			setLines((current) => [...current, ...entries].slice(-MAX_LINES));
		}
	}, [paused]);

	// The field answers each key at once; the lines follow when there is time.
	const needle = useDeferredValue(filter.trim().toLowerCase());
	const shown = useMemo(
		() =>
			lines.filter(
				(line) =>
					(level === 'all' || line.level === 'error' || (level === 'warn' && line.level === 'warn')) &&
					(!needle || haystack(line).includes(needle)),
			),
		[lines, level, needle],
	);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && following.current) element.scrollTop = element.scrollHeight;
	}, [shown]);

	return (
		<Card
			title={
				<>
					{t.logs.console}
					<span className="text-caption text-muted inline-flex items-center gap-1.5 font-medium">
						<span
							aria-hidden
							className={`size-2 rounded-full ${connected && !paused ? 'bg-ok live-dot' : 'bg-line-2'}`}
						/>
						{paused
							? waiting > 0
								? t.logs.pausedWaiting(waiting)
								: t.logs.paused
							: connected
								? t.logs.live
								: t.logs.disconnected}
					</span>
				</>
			}
			actions={
				<>
					<IconButton
						size="sm"
						label={paused ? t.logs.resume : t.logs.pause}
						aria-pressed={paused}
						onClick={() => {
							setPaused((value) => !value);
						}}
					>
						{paused ? <Play size={16} /> : <Pause size={16} />}
					</IconButton>
					<IconButton
						size="sm"
						label={t.logs.clear}
						onClick={() => {
							setLines([]);
						}}
					>
						<Trash2 size={16} />
					</IconButton>
				</>
			}
			flush
		>
			<div className="border-line flex flex-wrap items-center gap-3 border-b px-6 py-3.5">
				<Segmented
					label={t.logs.filter}
					value={level}
					onChange={setLevel}
					options={[
						{ value: 'all', label: t.logs.all },
						{ value: 'warn', label: t.logs.levels.warn ?? 'Warn' },
						{ value: 'error', label: t.logs.levels.error ?? 'Error' },
					]}
				/>
				<TextInput
					type="search"
					aria-label={t.logs.filter}
					placeholder={t.logs.filter}
					value={filter}
					onChange={(event) => {
						setFilter(event.target.value);
					}}
					className="h-9 min-w-40 flex-[1_1_12rem] sm:ml-auto sm:max-w-xs"
				/>
			</div>
			<div
				ref={scroller}
				onScroll={(event) => {
					const element = event.currentTarget;
					following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
				}}
				className="bg-canvas max-h-[min(65dvh,44rem)] min-h-40 overflow-auto px-5 py-4 font-mono text-caption leading-relaxed"
			>
				{shown.length === 0 ? (
					<p className="text-muted py-6 text-center font-sans text-sm">{t.logs.empty}</p>
				) : (
					shown.map((line) => <LogRow key={`${line.id}-${line.at}`} line={line} />)
				)}
			</div>
		</Card>
	);
}
