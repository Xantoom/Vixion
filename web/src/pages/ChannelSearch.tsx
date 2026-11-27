import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { type SearchHit, api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { streamersQuery } from '@/lib/queries';
import { Avatar } from '@/ui/Avatar';
import { Spinner } from '@/ui/Spinner';

interface Suggestion {
	login: string;
	name: string;
	avatar: string | null;
	live: boolean;
	detail: string | null;
	watched: boolean;
}

/** A login typed or pasted as a twitch.tv link. */
function loginOf(text: string): string | null {
	const login = text.trim().replace(/\/+$/, '').split('/').pop()?.replace(/^@/, '').toLowerCase() ?? '';
	return /^\w{1,25}$/.test(login) ? login : null;
}

/** Focuses the search from anywhere with “/” or Ctrl+K. */
export function focusChannelSearch() {
	document.querySelector<HTMLInputElement>('#channel-search')?.focus();
}

/**
 * The search box of the top bar: channels recorded here first, as soon as a letter is typed, then
 * Twitch's channels. Picking one opens its page, where it can be added.
 */
export function ChannelSearch({ onDone }: { onDone?: () => void }) {
	const t = useT();
	const navigate = useNavigate();
	const listId = useId();
	const input = useRef<HTMLInputElement>(null);
	const [text, setText] = useState('');
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const needle = useDeferredValue(text.trim().toLowerCase());
	// Twitch is asked once typing pauses.
	const [remoteNeedle, setRemoteNeedle] = useState('');
	useEffect(() => {
		const timer = setTimeout(() => {
			setRemoteNeedle(needle.length >= 2 ? needle : '');
		}, 220);
		return () => {
			clearTimeout(timer);
		};
	}, [needle]);

	const local = useQuery({ ...streamersQuery, enabled: open });
	const remote = useQuery({
		queryKey: ['twitch-search', remoteNeedle],
		queryFn: async () => api.get<SearchHit[]>(`/twitch/search?q=${encodeURIComponent(remoteNeedle)}`),
		enabled: open && remoteNeedle !== '',
		staleTime: 5 * 60_000,
		placeholderData: (previous) => previous,
	});

	const suggestions = useMemo<Suggestion[]>(() => {
		if (!needle) return [];
		const watched = (local.data ?? [])
			.filter((s) => s.login.includes(needle) || s.display_name.toLowerCase().includes(needle))
			.slice(0, 5)
			.map((s) => ({
				login: s.login,
				name: s.display_name,
				avatar: s.avatar_url,
				live: s.live !== null,
				detail: s.live?.game ?? null,
				watched: true,
			}));
		const known = new Set((local.data ?? []).map((s) => s.login));
		const found = (remote.data ?? [])
			.filter((hit) => !known.has(hit.login))
			.map((hit) => ({
				login: hit.login,
				name: hit.display_name,
				avatar: hit.avatar_url,
				live: hit.live,
				detail: hit.live && hit.game ? hit.game : t.search.followers(formatNumber(hit.followers)),
				watched: false,
			}));
		return [...watched, ...found];
	}, [needle, local.data, remote.data, t]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('input, textarea, select, [contenteditable]')) return;
			if (event.key === '/' || (event.key === 'k' && (event.ctrlKey || event.metaKey))) {
				event.preventDefault();
				input.current?.focus();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('keydown', onKey);
		};
	}, []);

	const go = (login: string) => {
		setText('');
		setOpen(false);
		input.current?.blur();
		onDone?.();
		void navigate({ to: '/$login', params: { login } });
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setOpen(true);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setActive((index) => (suggestions.length ? (index + step + suggestions.length) % suggestions.length : 0));
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const picked = suggestions[active]?.login ?? loginOf(text);
			if (picked) go(picked);
		} else if (event.key === 'Escape') {
			if (text) setText('');
			else input.current?.blur();
			setOpen(false);
			onDone?.();
		}
	};

	const showList = open && needle !== '';
	const searching = needle.length >= 2 && (remoteNeedle !== needle || remote.isFetching);

	return (
		<div className="relative w-full">
			<Search
				size={18}
				className="text-fg-faint pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
			/>
			<input
				ref={input}
				id="channel-search"
				type="search"
				role="combobox"
				aria-label={t.search.label}
				aria-expanded={showList}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={showList && suggestions[active] ? `${listId}-${active}` : undefined}
				autoComplete="off"
				autoCapitalize="none"
				spellCheck={false}
				placeholder={t.search.placeholder}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					setActive(0);
					setOpen(true);
				}}
				onFocus={() => {
					setOpen(true);
				}}
				onBlur={() => {
					// After a click on a suggestion has landed.
					setTimeout(() => {
						setOpen(false);
					}, 120);
				}}
				onKeyDown={onKeyDown}
				className="bg-raised text-ui placeholder:text-fg-faint focus:bg-bg focus:shadow-[inset_0_0_0_1px_var(--x-control-border)] h-11 w-full rounded-sm pr-16 pl-11 transition-[background-color,box-shadow] duration-150 outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{text ? (
				<button
					type="button"
					aria-label={t.common.close}
					onClick={() => {
						setText('');
						input.current?.focus();
					}}
					className="text-fg-faint hover:text-fg absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-xs"
				>
					<X size={16} />
				</button>
			) : (
				<kbd className="text-caption text-fg-faint border-line-strong pointer-events-none absolute top-1/2 right-3.5 hidden -translate-y-1/2 rounded-xs border px-1.5 font-sans leading-5 lg:block">
					/
				</kbd>
			)}
			{showList ? (
				<div
					className="menu-in bg-bg border-line absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-md border shadow-md"
					onPointerDown={(event) => {
						// Keeps the focus in the field, so the list stays open.
						event.preventDefault();
					}}
				>
					<ul
						id={listId}
						role="listbox"
						aria-label={t.search.label}
						className="max-h-[70dvh] overflow-y-auto p-1.5"
					>
						{suggestions.map((suggestion, index) => (
							<li
								key={suggestion.login}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === active}
								onPointerMove={() => {
									setActive(index);
								}}
								onClick={() => {
									go(suggestion.login);
								}}
								className="aria-selected:bg-raised flex cursor-pointer items-center gap-3 rounded-sm px-2.5 py-2"
							>
								<Avatar
									src={suggestion.avatar}
									name={suggestion.name}
									size={36}
									live={suggestion.live}
								/>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="text-ui truncate font-semibold">{suggestion.name}</span>
									{suggestion.detail ? (
										<span className="text-caption text-fg-faint truncate">{suggestion.detail}</span>
									) : null}
								</span>
								{suggestion.watched ? (
									<span className="text-caption bg-accent-soft text-accent flex-none rounded-xs px-1.5 py-0.5 font-medium">
										{t.channel.watched}
									</span>
								) : null}
							</li>
						))}
					</ul>
					{suggestions.length === 0 ? (
						<p className="text-small text-fg-faint flex items-center justify-center gap-2 px-4 py-5">
							{searching ? <Spinner /> : remote.isError ? t.search.failed : t.search.none}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
