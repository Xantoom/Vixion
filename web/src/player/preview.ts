import { CanvasSink, EncodedPacketSink, Input, MP4, UrlSource } from 'mediabunny';

/** Width of a preview picture, in pixels: sharp at twice the size it is shown. */
const WIDTH = 320;
/** Pictures kept, by keyframe: moving back over the bar shows them at once. About 230 kB each. */
const KEPT = 40;

type Picture = HTMLCanvasElement | OffscreenCanvas;

/**
 * Pictures of a recording at any time, for the timeline under the pointer. Only keyframes are
 * decoded (a few every minute, each read on its own from the file), so the picture shown is the
 * keyframe before the time asked: a second or two early at most. Opens nothing until first asked,
 * and asks one picture at a time: the latest wanted, never a queue of stale ones.
 */
export function createPreview(url: string) {
	let sinks: Promise<{ packets: EncodedPacketSink; frames: CanvasSink } | null> | null = null;
	let input: Input | null = null;
	const kept = new Map<number, Picture>();
	let wanted: { seconds: number; done: (picture: Picture | null) => void } | null = null;
	let running = false;

	const open = async () => {
		input = new Input({
			source: new UrlSource(url, { maxCacheSize: 8 * 1024 * 1024, parallelism: 1 }),
			formats: [MP4],
		});
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode())) return null;
		return { packets: new EncodedPacketSink(track), frames: new CanvasSink(track, { width: WIDTH }) };
	};

	const picture = async (seconds: number): Promise<Picture | null> => {
		sinks ??= open().catch(() => null);
		const ready = await sinks;
		if (!ready) return null;
		const key = await ready.packets.getKeyPacket(seconds, { metadataOnly: true });
		if (!key) return null;
		const found = kept.get(key.timestamp);
		if (found) return found;
		const frame = await ready.frames.getCanvas(key.timestamp);
		if (!frame) return null;
		kept.set(key.timestamp, frame.canvas);
		if (kept.size > KEPT) kept.delete(kept.keys().next().value ?? 0);
		return frame.canvas;
	};

	const run = () => {
		const next = wanted;
		wanted = null;
		running = next !== null;
		if (!next) return;
		void picture(next.seconds)
			.catch(() => null)
			.then((found) => {
				next.done(found);
				run();
			});
	};

	return {
		/** Asks for the picture at a time; `done` gets it, unless a later ask came first. */
		request(seconds: number, done: (picture: Picture | null) => void) {
			wanted = { seconds, done };
			if (!running) run();
		},
		/** Lets the file go; asked again, it opens again. */
		close() {
			wanted = null;
			kept.clear();
			input?.dispose();
			input = null;
			sinks = null;
		},
	};
}

export type Preview = ReturnType<typeof createPreview>;
