import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, OctagonAlert, Pause, Play, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type Alert, type LogEntry, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan } from '@/lib/session';
import { IconButton } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Segmented, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';
import { NotFound } from './NotFound';

const MAX_LINES = 2000;
type Level = 'all' | 'warn' | 'error';

const LEVEL_STYLE: Record<string, string> = {
	error: 'text-danger',
	warn: 'text-warn',
	info: 'text-ok',
	debug: 'text-muted',
	trace: 'text-muted',
};

function time(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export function LogsPage() {
	const can = useCan('logs.view');
	if (!can) return <NotFound forbidden />;
	return (
		<div className="panel-in flex flex-col gap-6">
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

	return (
		<Card title={t.logs.alerts} count={open.length} flush>
			{isPending ? (
				<PageLoading />
			) : open.length === 0 ? (
				<p className="text-small text-muted flex items-center gap-2 px-5 py-4">
					<CircleCheck size={16} className="text-ok" />
					{t.logs.noAlerts}
				</p>
			) : (
				<ul className="divide-line divide-y">
					{open.map((alert) => (
						<li key={alert.id} className="flex items-start gap-3 px-5 py-3">
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
			)}
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
		const push = (entries: LogEntry[]) => {
			if (pausedRef.current) {
				held.current.push(...entries);
				return;
			}
			setLines((current) => [...current, ...entries].slice(-MAX_LINES));
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
						push([JSON.parse(event.data) as LogEntry]);
					} catch {
						// A line that isn't JSON is skipped.
					}
				};
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			source?.close();
		};
	}, []);

	useEffect(() => {
		if (!paused && held.current.length > 0) {
			const entries = held.current;
			held.current = [];
			setLines((current) => [...current, ...entries].slice(-MAX_LINES));
		}
	}, [paused]);

	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return lines.filter(
			(line) =>
				(level === 'all' || line.level === 'error' || (level === 'warn' && line.level === 'warn')) &&
				(!needle ||
					line.message.toLowerCase().includes(needle) ||
					line.fields.toLowerCase().includes(needle) ||
					line.target.includes(needle)),
		);
	}, [lines, level, filter]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && following.current) element.scrollTop = element.scrollHeight;
	}, [shown]);

	return (
		<Card
			title={
				<>
					{t.logs.console}
					<span
						className={`size-2 rounded-full ${connected && !paused ? 'bg-ok live-dot' : 'bg-line-2'}`}
						data-tip={connected && !paused ? t.logs.live : t.logs.pause}
					/>
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
			<div className="border-line flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
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
					className="h-9 max-w-xs flex-1"
				/>
			</div>
			<div
				ref={scroller}
				onScroll={(event) => {
					const element = event.currentTarget;
					following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
				}}
				className="bg-canvas h-[min(65dvh,44rem)] overflow-auto px-4 py-2.5 font-mono text-[0.78rem] leading-relaxed"
			>
				{shown.length === 0 ? (
					<p className="text-muted py-6 text-center font-sans text-sm">{t.logs.empty}</p>
				) : (
					shown.map((line) => (
						<div
							key={`${line.id}-${line.at}`}
							className="hover:bg-surface flex gap-3 rounded-[3px] px-1 whitespace-pre-wrap"
						>
							<span className="text-muted flex-none tabular">{time(line.at)}</span>
							<span className={`w-11 flex-none uppercase ${LEVEL_STYLE[line.level] ?? ''}`}>
								{line.level}
							</span>
							<span className="min-w-0 break-words">
								<span className="text-ink">{line.message}</span>
								{line.fields ? <span className="text-muted"> {line.fields}</span> : null}
								<span className="text-muted/60"> {line.target}</span>
							</span>
						</div>
					))
				)}
			</div>
		</Card>
	);
}
