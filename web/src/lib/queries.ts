import { type ChannelPage, type StreamDetail, type Streamer, api } from './api';

/**
 * The queries pages open with, kept out of the pages so the router can start them (on hover, or
 * before a page's code has arrived) without loading that code.
 */
export const streamersQuery = {
	queryKey: ['streamers'],
	queryFn: async () => api.get<Streamer[]>('/streamers'),
	refetchInterval: 15_000,
};

export function channelQuery(login: string) {
	return {
		queryKey: ['channel', login],
		queryFn: async () => api.get<ChannelPage>(`/channels/${login}`),
		// Often while the channel is live or recorded (progress moves), else now and then: a live
		// starting still shows within two minutes.
		refetchInterval: (query: { state: { data?: ChannelPage } }) => {
			const data = query.state.data;
			const active = data?.streamer?.recording || data?.streamer?.live || data?.profile?.live;
			return active ? 20_000 : 120_000;
		},
	};
}

/** The media link lasts 12 h: one older than this is fetched again before the player opens. */
const LINK_FRESH_MS = 6 * 3600_000;

/** The media link changes on every answer: the page keeps the one it opened with. */
export function streamQuery(id: string) {
	return {
		queryKey: ['stream', id],
		queryFn: async () => api.get<StreamDetail>(`/streams/${id}`),
		staleTime: LINK_FRESH_MS,
	};
}
