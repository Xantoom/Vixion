import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { type Streamer, api } from '@/lib/api';
import { formatBytes, formatDuration, formatRelative } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, TextInput } from '@/ui/Field';
import { PageLoading } from '@/ui/Spinner';
import { toast } from '@/ui/Toasts';

export const streamersQuery = {
	queryKey: ['streamers'],
	queryFn: async () => api.get<Streamer[]>('/streamers'),
	refetchInterval: 15_000,
};

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 pt-6 pb-5 sm:pt-8">
			<h1 className="text-heading font-semibold tracking-tight">{title}</h1>
			{children ? <div className="flex items-center gap-2">{children}</div> : null}
		</div>
	);
}

export function StreamersPage() {
	const t = useT();
	const canManage = useCan('streamers.manage');
	const { data, isPending, error } = useQuery(streamersQuery);
	const [adding, setAdding] = useState(false);
	const [filter, setFilter] = useState('');

	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const list = (data ?? []).filter(
			(streamer) =>
				!needle || streamer.login.includes(needle) || streamer.display_name.toLowerCase().includes(needle),
		);
		return list.toSorted((a, b) =>
			a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }),
		);
	}, [data, filter]);

	return (
		<div className="mx-auto max-w-[110rem] px-4 sm:px-6">
			<PageHeader title={t.streamers.title}>
				{(data?.length ?? 0) > 8 ? (
					<div className="relative">
						<Search size={16} className="text-muted pointer-events-none absolute top-3 left-3" />
						<TextInput
							type="search"
							aria-label={t.streamers.search}
							placeholder={t.streamers.search}
							value={filter}
							onChange={(event) => {
								setFilter(event.target.value);
							}}
							className="w-44 pl-9 sm:w-60"
						/>
					</div>
				) : null}
				{canManage ? (
					<Button
						variant="accent"
						onClick={() => {
							setAdding(true);
						}}
					>
						<Plus size={17} strokeWidth={2.4} />
						<span className="hidden sm:inline">{t.streamers.add}</span>
					</Button>
				) : null}
			</PageHeader>

			{isPending ? (
				<PageLoading />
			) : error ? (
				<p className="text-ui text-danger py-10">{error.message}</p>
			) : data.length === 0 ? (
				<div className="panel-in border-line-2 flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-16 text-center">
					<h2 className="text-title font-semibold">{t.streamers.emptyTitle}</h2>
					<p className="text-ui text-muted max-w-sm">
						{canManage ? t.streamers.emptyLead : t.streamers.emptyLeadViewer}
					</p>
					{canManage ? (
						<Button
							variant="accent"
							className="mt-3"
							onClick={() => {
								setAdding(true);
							}}
						>
							<Plus size={17} strokeWidth={2.4} />
							{t.streamers.add}
						</Button>
					) : null}
				</div>
			) : (
				<ul className="stagger grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3 pb-10">
					{shown.map((streamer, index) => (
						<li key={streamer.id} style={{ '--i': index } as React.CSSProperties}>
							<StreamerCard streamer={streamer} />
						</li>
					))}
				</ul>
			)}
			<AddStreamerDialog
				open={adding}
				onClose={() => {
					setAdding(false);
				}}
			/>
		</div>
	);
}

/** What a streamer is doing right now, as one short status. */
export function StreamerStatus({ streamer }: { streamer: Streamer }) {
	const t = useT();
	if (streamer.recording) {
		const label =
			streamer.recording.state === 'ad'
				? t.streamers.ad
				: streamer.recording.state === 'waiting'
					? t.streamers.waiting
					: t.streamers.recording;
		return (
			<span className="text-caption text-live inline-flex items-center gap-1.5 font-semibold">
				<span className="live-dot bg-live size-2 rounded-full" />
				{label}
				<span className="text-muted tabular font-normal">{formatDuration(streamer.recording.duration_ms)}</span>
			</span>
		);
	}
	if (streamer.live) {
		return (
			<span className="text-caption text-live inline-flex items-center gap-1.5 font-semibold">
				<span className="bg-live size-2 rounded-full" />
				{t.streamers.live}
			</span>
		);
	}
	if (!streamer.monitored) return <span className="text-caption text-muted">{t.streamers.paused}</span>;
	return (
		<span className="text-caption text-muted">
			{streamer.last_stream_at
				? t.streamers.lastStream(formatRelative(streamer.last_stream_at))
				: t.streamers.noStreams}
		</span>
	);
}

function StreamerCard({ streamer }: { streamer: Streamer }) {
	const t = useT();
	const live = streamer.live !== null || streamer.recording !== null;
	return (
		<Link
			to="/streamers/$id"
			params={{ id: String(streamer.id) }}
			className={`group bg-bg hover:bg-surface border-line flex h-full items-center gap-3.5 rounded-md border p-3.5 transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px ${live ? 'border-live/35' : ''} ${streamer.monitored ? '' : 'opacity-70'}`}
		>
			<Avatar src={streamer.avatar_url} name={streamer.display_name} size={52} live={live} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-body truncate font-semibold">{streamer.display_name}</span>
				<StreamerStatus streamer={streamer} />
				{streamer.live?.title ? (
					<span className="text-caption text-ink-2 truncate" title={streamer.live.title}>
						{streamer.live.game ? <span className="text-muted">{streamer.live.game} · </span> : null}
						{streamer.live.title}
					</span>
				) : (
					<span className="text-caption text-muted tabular truncate">
						{t.streamers.streams(streamer.stream_count)}
						{streamer.total_bytes > 0 ? ` · ${formatBytes(streamer.total_bytes)}` : ''}
					</span>
				)}
			</div>
		</Link>
	);
}

function AddStreamerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const client = useQueryClient();
	const [login, setLogin] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const close = () => {
		setLogin('');
		setError(null);
		onClose();
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const added = await api.post<Streamer>('/streamers', { login: login.trim() });
			await client.invalidateQueries({ queryKey: streamersQuery.queryKey });
			toast.ok(t.streamers.added(added.display_name));
			close();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t.common.error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onClose={close} title={t.streamers.add}>
			<form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
				<Field label={t.streamers.addLabel} hint={t.streamers.addHint} error={error}>
					{(id, describedBy) => (
						<TextInput
							id={id}
							required
							autoFocus
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							placeholder={t.streamers.addPlaceholder}
							aria-describedby={describedBy}
							value={login}
							onChange={(event) => {
								setLogin(event.target.value);
							}}
						/>
					)}
				</Field>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={close}>
						{t.common.cancel}
					</Button>
					<Button type="submit" variant="accent" busy={busy}>
						{t.common.add}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
