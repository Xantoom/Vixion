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
		throw new ApiError(0, 'network', 'The server can’t be reached.');
	}
	if (response.status === 401 && path !== '/auth/login') onUnauthorized();
	if (!response.ok) {
		const error = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
		throw new ApiError(response.status, error?.error ?? 'error', error?.message ?? response.statusText);
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
	media_same_origin: boolean;
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
	monitored: boolean;
	retention_days: number | null;
	live: { title: string | null; game: string | null; since: number } | null;
	recording: LiveProgress | null;
	stream_count: number;
	total_bytes: number;
	total_duration_ms: number;
	last_stream_at: number | null;
	created_at: number;
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
	memory: number | null;
	uptime_ms: number;
	version: string;
}

export interface Settings {
	retention_days: number;
	h264_only: boolean;
	poll_interval: number;
	record_chat: boolean;
	disk_warning_gb: number;
	disk_reserve_gb: number;
	webhook_url: string;
	webhook_kind: 'discord' | 'ntfy' | 'generic';
	has_twitch_token: boolean;
}

export interface SettingsResponse {
	settings: Settings;
	system: { media_mode: string; media_url: string; data_dir: string };
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
