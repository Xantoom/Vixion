import { t } from '@/i18n';
/** The server's API: typed requests and the shapes it answers with. */

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Called when the session is gone, so the app shows the sign-in page. */
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(handler: () => void) {
	onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	// The header proves the request comes from this page's script: forms on other sites can't send it.
	const headers: Record<string, string> = { 'x-vixion': '1' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	let response: Response;
	try {
		response = await fetch(`/api${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: 'same-origin',
		});
	} catch {
		throw new ApiError(0, 'network', t().serverErrors.network ?? 'The server can’t be reached');
	}
	// Asking who is signed in may be refused: that is an answer (nobody), not a session that ended.
	const asksWho = method === 'GET' && path === '/me';
	if (response.status === 401 && path !== '/auth/login' && !asksWho) onUnauthorized();
	if (!response.ok) {
		const error = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
		const code = error?.error ?? 'error';
		// In the interface's language when the code is known; the server's words otherwise.
		throw new ApiError(response.status, code, t().serverErrors[code] ?? error?.message ?? response.statusText);
	}
	if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
	const type = response.headers.get('content-type') ?? '';
	return (type.includes('json') ? await response.json() : await response.text()) as T;
}

export const api = {
	get: async <T>(path: string) => request<T>('GET', path),
	post: async <T = void>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
	put: async <T = void>(path: string, body: unknown) => request<T>('PUT', path, body),
	patch: async <T = void>(path: string, body: unknown) => request<T>('PATCH', path, body),
	delete: async <T = void>(path: string) => request<T>('DELETE', path),
};

export type Permission =
	| 'streams.view'
	| 'streams.download'
	| 'streams.keep'
	| 'streams.delete'
	| 'streamers.manage'
	| 'stats.view'
	| 'logs.view'
	| 'users.manage'
	| 'settings.manage';

export interface Me {
	id: number;
	username: string;
	role_id: number;
	role: string;
	admin: boolean;
	locale: string | null;
	permissions: Permission[];
	version: string;
}

export interface LiveProgress {
	stream_id: number;
	duration_ms: number;
	bytes: number;
	ads_skipped_ms: number;
	chat_messages: number;
	codec: string;
	width: number;
	height: number;
	fps: number;
	state: 'waiting' | 'recording' | 'ad';
}

export interface Streamer {
	id: number;
	twitch_id: string;
	login: string;
	display_name: string;
	avatar_url: string | null;
	banner_url: string | null;
	/** The newest recording with a picture, for the cover. */
	cover_stream_id: number | null;
	monitored: boolean;
	retention_days: number | null;
	/** Days recordings stay when the streamer has no rule of its own; 0 keeps them. */
	default_retention_days: number;
	live: { title: string | null; game: string | null; viewers: number | null; since: number } | null;
	recording: LiveProgress | null;
	stream_count: number;
	total_bytes: number;
	total_duration_ms: number;
	last_stream_at: number | null;
	created_at: number;
}

/** A Twitch channel found by name. */
export interface SearchHit {
	login: string;
	display_name: string;
	avatar_url: string | null;
	followers: number;
	live: boolean;
	game: string | null;
}

export interface TwitchVideo {
	id: string;
	title: string;
	duration_s: number;
	created_at: number | null;
	views: number;
	thumbnail_url: string | null;
	game: string | null;
}

export interface Profile {
	id: string;
	login: string;
	display_name: string;
	avatar_url: string | null;
	banner_url: string | null;
	description: string | null;
	followers: number;
	partner: boolean;
	created_at: number | null;
	live: {
		title: string | null;
		game: string | null;
		viewers: number;
		since: number | null;
		preview_url: string | null;
	} | null;
	last_broadcast: number | null;
	videos: TwitchVideo[];
}

/** A channel's page: Twitch's side, and Vixion's when the channel is watched. */
export interface ChannelPage {
	profile: Profile | null;
	streamer: Streamer | null;
	streams: StreamSummary[];
}

/** Badge pictures by `set/version`, and third-party emotes by word, at 1x and 2x. */
export interface ChatAssets {
	badges: Record<string, string>;
	emotes: Record<string, [string, string]>;
}

export type StreamStatus = 'recording' | 'done' | 'failed';

export interface StreamSummary {
	id: number;
	streamer_id: number;
	part: number;
	title: string;
	game: string | null;
	status: StreamStatus;
	started_at: number;
	ended_at: number | null;
	duration_ms: number;
	size_bytes: number;
	video_codec: string | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	chat_messages: number;
	ads_skipped_ms: number;
	keep_forever: boolean;
	has_thumbnail: boolean;
	expires_at: number | null;
}

export interface StreamDetail extends StreamSummary {
	streamer_login: string;
	streamer_name: string;
	streamer_avatar: string | null;
	audio_codec: string | null;
	gaps: number;
	error: string | null;
	chapters: { at_ms: number; title: string; game: string | null }[];
	video_url: string;
	download_url: string | null;
	/** [stream id, part] of every part of the broadcast. */
	parts: [number, number][];
	/** Where the broadcast is missing from the video: (video ms, ms missing). */
	cuts: [number, number][];
}

/** A chat line, with its time in the video (o, milliseconds). Keys are short: there are millions. */
export interface ChatLine {
	o: number;
	t: number;
	/** m message, a action, n notice, d deletion, x clear. */
	k: 'm' | 'a' | 'n' | 'd' | 'x';
	u?: string;
	n?: string;
	c?: string;
	b?: string;
	e?: string;
	m?: string;
	i?: string;
	s?: string;
}

export interface Stats {
	streamers: {
		id: number;
		login: string;
		display_name: string;
		avatar_url: string | null;
		streams: number;
		bytes: number;
		duration_ms: number;
		kept: number;
	}[];
	streams: number;
	bytes: number;
	duration_ms: number;
	recording: number;
	disk: { total: number; free: number };
	/** Only for those who manage the server. */
	folders: { config: Folder; recordings: Folder } | null;
	uptime_ms: number;
	/** Bytes, as the kernel counts them; the cgroup's figures are null outside one. */
	memory: {
		process: number;
		mapped: number;
		cgroup: number | null;
		cache_active: number | null;
		cache_inactive: number | null;
	};
	version: string;
}

/** One of the server's folders, and where it comes from when Vixion runs in a container. */
export interface Folder {
	path: string;
	source: string | null;
	unmapped: boolean;
	disk: { total: number; free: number };
}

export interface Settings {
	retention_days: number;
	h264_only: boolean;
	record_chat: boolean;
	disk_warning_gb: number;
	disk_reserve_gb: number;
	webhook_url: string;
	webhook_kind: 'discord' | 'ntfy' | 'generic';
	/** Where the Twitch token comes from; it is set in the configuration, never from the interface. */
	twitch_token_source: 'config' | 'stored' | null;
}

export interface SettingsResponse {
	settings: Settings;
}

export interface User {
	id: number;
	username: string;
	role_id: number;
	disabled: boolean;
	created_at: number;
	last_login_at: number | null;
	overrides: Partial<Record<Permission, boolean>>;
	permissions: Permission[];
}

export interface Role {
	id: number;
	name: string;
	builtin: 'admin' | 'user' | null;
	permissions: Permission[];
	users: number;
}

export interface LogEntry {
	id: number;
	at: number;
	level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
	target: string;
	message: string;
	fields: string;
}

export interface Alert {
	id: number;
	level: 'info' | 'warning' | 'error';
	kind: string;
	message: string;
	created_at: number;
	resolved: boolean;
}
