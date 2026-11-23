/** Box art of a Twitch category, from its name; `width` in pixels, the height follows at 3:4. */
export function boxArt(game: string, width = 72): string {
	return `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(game)}-${width}x${Math.round((width * 4) / 3)}.jpg`;
}
