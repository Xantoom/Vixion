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
		refetchInterval: 20_000,
	};
}

/** The media link changes on every answer: the page keeps the one it opened with (it lasts 12 h). */
export function streamQuery(id: string) {
	return {
		queryKey: ['stream', id],
		queryFn: async () => api.get<StreamDetail>(`/streams/${id}`),
		staleTime: Number.POSITIVE_INFINITY,
	};
}
