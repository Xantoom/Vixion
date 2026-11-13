import {
	MP4,
	AudioBufferSink,
	Input,
	type InputVideoTrack,
	UrlSource,
	type VideoSample,
	VideoSampleSink,
} from 'mediabunny';
import { AudioOutput } from './audio-output';

export interface PlaybackState {
	playing: boolean;
	/** Playing, but waiting for data. */
	waiting: boolean;
	ended: boolean;
}

export type EngineError = 'decode' | 'open' | 'expired';

/** What both engines offer the player's interface. */
export interface Engine {
	onTime: (time: number) => void;
	onState: (state: PlaybackState) => void;
	onError: (error: EngineError) => void;
	/** Resolves with the duration in seconds once the video can play. */
	readonly ready: Promise<number>;
	readonly kind: 'mediabunny' | 'element';
	attach(container: HTMLElement): void;
	time(): number;
	play(): Promise<void>;
	pause(): void;
	seek(time: number): void;
	setVolume(level: number, muted: boolean): void;
	setCompressor(enabled: boolean): void;
	dispose(): void;
}

/** Mediabunny needs WebCodecs, which browsers only give secure pages (HTTPS or localhost). */
export function webCodecsAvailable(): boolean {
	return typeof VideoDecoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
}

/** Audio decoded ahead of the playhead: enough to ride out the network, small enough to seek fast. */
const LOOKAHEAD = 1.5;
/** Ahead before playing on after a stall. */
const REFILL = 0.6;
/** How far pictures may lag before decoding jumps to the playhead. */
const CATCH_UP = 0.5;

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextFrame() {
	await new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Plays an MP4 with Mediabunny: the file is read in ranges over HTTP, pictures are decoded with
 * WebCodecs and drawn on a canvas, sound is decoded about a second ahead and scheduled on the Web
 * Audio clock, which is also the clock the pictures follow. When the network falls behind, the
 * audio clock is suspended: pictures and sound stop together and pick up together.
 */
export class MediabunnyEngine implements Engine {
	onTime: (time: number) => void = () => {};
	onState: (state: PlaybackState) => void = () => {};
	onError: (error: EngineError) => void = () => {};
	readonly kind = 'mediabunny';
	readonly ready: Promise<number>;

	private readonly input: Input;
	private videoTrack: InputVideoTrack | null = null;
	private videoSink: VideoSampleSink | null = null;
	private audioSink: AudioBufferSink | null = null;
	private software = false;
	private firstPicture = 0;
	private duration = 0;
	private readonly context: AudioContext;
	private output: AudioOutput | null = null;
	private readonly canvas: HTMLCanvasElement;
	private nodes = new Set<AudioBufferSourceNode>();
	/** Media time (seconds) at a time of the audio clock; null until the first sound is scheduled. */
	private anchor: { context: number; media: number } | null = null;
	/** Media time up to which sound is scheduled. */
	private scheduledTo = 0;
	private audioDone = false;
	/** Without sound, the page clock: page time at which a media time played. */
	private pageAnchor = { page: 0, media: 0 };
	private position = 0;
	private playing = false;
	private waiting = false;
	private run = 0;
	private frame = 0;
	private stillRequest: number | null = null;
	private stillBusy = false;
	private disposed = false;

	constructor(url: string, durationHint: number) {
		this.input = new Input({
			source: new UrlSource(url, {
				maxCacheSize: 48 * 1024 * 1024,
				parallelism: 2,
				// A link refused for its signature won't be accepted by asking again.
				getRetryDelay: (attempts, error) => {
					if (String(error).includes('403')) return null;
					return attempts < 6 ? Math.min(8, 0.5 * 2 ** attempts) : null;
				},
			}),
			formats: [MP4],
		});
		this.context = new AudioContext({ latencyHint: 'playback' });
		this.canvas = document.createElement('canvas');
		this.canvas.className = 'block size-full object-contain';
		this.ready = this.open(durationHint);
	}

	private async open(durationHint: number): Promise<number> {
		try {
			const [video, audio, output] = await Promise.all([
				this.input.getPrimaryVideoTrack(),
				this.input.getPrimaryAudioTrack(),
				AudioOutput.create(this.context),
			]);
			this.output = output;
			if (video) {
				if (!(await video.canDecode())) {
					this.onError('decode');
					throw new Error('video codec not supported');
				}
				this.videoTrack = video;
				this.videoSink = new VideoSampleSink(video);
				const [width, height, first] = await Promise.all([
					video.getDisplayWidth(),
					video.getDisplayHeight(),
					video.getFirstTimestampOrNull(),
				]);
				this.canvas.width = width;
				this.canvas.height = height;
				this.firstPicture = Math.max(0, first ?? 0);
			}
			if (audio && (await audio.canDecode())) this.audioSink = new AudioBufferSink(audio);
			// The index at the end of the file gives the duration at once; the server's figure is the fallback,
			// also for a recording that has only just started and holds no frames yet.
			this.duration = await Promise.race([
				this.input
					.computeDuration()
					.then((duration) => duration || durationHint)
					.catch(() => durationHint),
				sleep(5000).then(() => durationHint),
			]);
			this.showStill(this.position);
			return this.duration;
		} catch (error) {
			if (!this.disposed) {
				console.error('[player] could not open the video', error);
				if (String(error).includes('403')) this.onError('expired');
				else if (!String(error).includes('codec')) this.onError('open');
			}
			throw error;
		}
	}

	attach(container: HTMLElement) {
		container.replaceChildren(this.canvas);
	}

	time(): number {
		if (!this.playing) return this.position;
		if (this.audioSink) {
			if (!this.anchor) return this.position;
			return Math.min(
				this.duration,
				this.anchor.media + Math.max(0, this.context.currentTime - this.anchor.context),
			);
		}
		return Math.min(this.duration, this.pageAnchor.media + (performance.now() - this.pageAnchor.page) / 1000);
	}

	async play() {
		await this.ready.catch(() => undefined);
		if (this.disposed || this.playing) return;
		// Called from a click or a key: the moment browsers allow sound to start.
		void this.context.resume();
		const from = this.position >= this.duration - 0.1 ? 0 : this.position;
		this.start(from);
	}

	pause() {
		if (!this.playing) return;
		this.position = this.time();
		this.stop();
		this.playing = false;
		this.emit();
		this.showStill(this.position);
	}

	seek(time: number) {
		const target = Math.max(0, Math.min(this.duration || time, time));
		this.position = target;
		if (this.playing) this.start(target);
		else this.showStill(target);
		this.onTime(target);
	}

	setVolume(level: number, muted: boolean) {
		void this.ready.then(() => this.output?.setVolume(level, muted)).catch(() => undefined);
	}

	setCompressor(enabled: boolean) {
		void this.ready.then(() => this.output?.setCompressor(enabled)).catch(() => undefined);
	}

	dispose() {
		this.disposed = true;
		this.stop();
		void this.context.close();
		this.input.dispose();
	}

	private emit() {
		this.onState({
			playing: this.playing,
			waiting: this.playing && this.waiting,
			ended: !this.playing && this.position >= this.duration - 0.1,
		});
	}

	private stop() {
		this.run += 1;
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		for (const node of this.nodes) {
			node.onended = null;
			try {
				node.stop();
			} catch {
				// Never started.
			}
			node.disconnect();
		}
		this.nodes.clear();
		this.anchor = null;
	}

	private start(from: number) {
		this.stop();
		const run = this.run;
		this.position = from;
		this.playing = true;
		this.waiting = true;
		this.audioDone = false;
		this.scheduledTo = from;
		this.emit();
		if (this.audioSink) {
			void this.pumpAudio(run, from);
		} else {
			this.pageAnchor = { page: performance.now(), media: from };
			this.waiting = false;
			this.emit();
		}
		void this.pumpPictures(run, from);
		this.frame = requestAnimationFrame(this.tick);
	}

	/** Every frame: report the time, notice a stall or the end. */
	private tick = () => {
		if (!this.playing) return;
		const time = this.time();
		this.onTime(time);
		if (time >= this.duration - 0.02 || (this.audioDone && this.anchor && time >= this.scheduledTo)) {
			this.position = Math.min(time, this.duration);
			this.stop();
			this.playing = false;
			this.emit();
			return;
		}
		// Sound is about to run out and more isn't decoded yet: hold the clock.
		if (this.audioSink && this.anchor && !this.waiting && !this.audioDone && time > this.scheduledTo - 0.03) {
			this.waiting = true;
			void this.context.suspend();
			this.emit();
		}
		this.frame = requestAnimationFrame(this.tick);
	};

	private async pumpAudio(run: number, from: number) {
		const sink = this.audioSink;
		const inlet = this.output?.inlet;
		if (!sink || !inlet) return;
		const buffers = sink.buffers(from);
		try {
			while (run === this.run) {
				// oxlint-disable-next-line no-await-in-loop
				while (run === this.run && this.anchor && this.scheduledTo - this.time() > LOOKAHEAD) await sleep(60);
				if (run !== this.run) break;
				// oxlint-disable-next-line no-await-in-loop
				const next = await buffers.next();
				if (run !== this.run) break;
				if (next.done) {
					this.audioDone = true;
					this.resumeIfReady(run);
					break;
				}
				const { buffer, timestamp, duration } = next.value;
				if (timestamp + duration <= from) continue;
				// The clock starts with the first sound, so a slow first answer doesn't cut it.
				this.anchor ??= { context: this.context.currentTime + 0.06, media: Math.max(from, timestamp) };
				const when = this.anchor.context + (timestamp - this.anchor.media);
				const late = Math.max(0, this.context.currentTime - when, from - timestamp);
				if (late < duration) {
					const node = this.context.createBufferSource();
					node.buffer = buffer;
					node.connect(inlet);
					node.onended = () => {
						node.disconnect();
						this.nodes.delete(node);
					};
					node.start(when + late, late);
					this.nodes.add(node);
				}
				this.scheduledTo = timestamp + duration;
				this.resumeIfReady(run);
			}
		} catch (error) {
			if (run === this.run && !this.disposed) {
				console.error('[player] audio decoding failed', error);
				// Pictures go on in silence on the page clock.
				this.audioSink = null;
				this.pageAnchor = { page: performance.now(), media: this.time() };
				this.waiting = false;
				this.emit();
			}
		} finally {
			await buffers.return().catch(() => undefined);
		}
	}

	private resumeIfReady(run: number) {
		if (run !== this.run || !this.waiting || !this.anchor) return;
		if (this.audioDone || this.scheduledTo - this.time() >= REFILL) {
			this.waiting = false;
			void this.context.resume();
			this.emit();
		}
	}

	/** Some drivers fail on files the browser says it can decode: the CPU decoder takes over. */
	private fallBack(error: unknown): boolean {
		console.error('[player] picture decoding failed', this.software ? '(software)' : '(hardware)', error);
		if (this.software || !this.videoTrack || this.disposed) {
			if (!this.disposed) this.onError('decode');
			return false;
		}
		this.software = true;
		this.videoSink = new VideoSampleSink(this.videoTrack, { hardwareAcceleration: 'prefer-software' });
		return true;
	}

	private draw(sample: VideoSample) {
		const context = this.canvas.getContext('2d');
		if (!context) return;
		sample.draw(context, 0, 0, this.canvas.width, this.canvas.height);
	}

	private async pumpPictures(run: number, from: number) {
		const sink = this.videoSink;
		if (!sink) return;
		const samples = sink.samples(Math.max(from, this.firstPicture));
		let next: VideoSample | null = null;
		let behind = false;
		try {
			// oxlint-disable-next-line no-await-in-loop
			while (run === this.run && (next = (await samples.next()).value ?? null)) {
				if (next.timestamp + next.duration < this.time() - CATCH_UP) {
					behind = true;
					break;
				}
				// oxlint-disable-next-line no-await-in-loop
				while (run === this.run && next.timestamp > this.time() + 0.004) await nextFrame();
				if (run !== this.run) break;
				if (next.timestamp + next.duration >= this.time()) this.draw(next);
				next.close();
				next = null;
			}
		} catch (error) {
			if (this.fallBack(error) && run === this.run) void this.pumpPictures(run, this.time());
		} finally {
			next?.close();
			await samples.return().catch(() => undefined);
		}
		if (behind && run === this.run) void this.pumpPictures(run, this.time());
	}

	/** The picture at a time while paused; requests made while one decodes collapse into the last. */
	private showStill(time: number) {
		this.stillRequest = time;
		if (this.stillBusy) return;
		void (async () => {
			this.stillBusy = true;
			try {
				await this.ready;
				while (this.stillRequest !== null && !this.disposed) {
					const at = Math.max(this.stillRequest, this.firstPicture);
					this.stillRequest = null;
					try {
						// oxlint-disable-next-line no-await-in-loop
						const sample = await this.videoSink?.getSample(at);
						if (sample) {
							if (!this.playing) this.draw(sample);
							sample.close();
						}
					} catch (error) {
						if (this.fallBack(error)) this.stillRequest ??= at;
					}
				}
			} catch {
				// Not opened: nothing to show.
			} finally {
				this.stillBusy = false;
			}
		})();
	}
}

/**
 * The browser's own <video>, for pages without WebCodecs (plain HTTP on a local network) or
 * formats WebCodecs refuses. Sound still goes through the compressor, by Web Audio.
 */
export class ElementEngine implements Engine {
	onTime: (time: number) => void = () => {};
	onState: (state: PlaybackState) => void = () => {};
	onError: (error: EngineError) => void = () => {};
	readonly kind = 'element';
	readonly ready: Promise<number>;

	private readonly video: HTMLVideoElement;
	private context: AudioContext | null = null;
	private output: AudioOutput | null = null;
	private compressor = false;
	private level = { volume: 1, muted: false };
	private frame = 0;

	constructor(url: string, durationHint: number) {
		const video = document.createElement('video');
		video.className = 'block size-full object-contain';
		video.crossOrigin = 'anonymous';
		video.preload = 'metadata';
		video.playsInline = true;
		video.src = url;
		this.video = video;
		const emit = () => {
			this.onState({
				playing: !video.paused,
				waiting: !video.paused && video.readyState < 3,
				ended: video.ended,
			});
		};
		for (const event of ['play', 'pause', 'waiting', 'playing', 'ended', 'canplay'])
			video.addEventListener(event, emit);
		video.addEventListener('seeked', () => {
			this.onTime(video.currentTime);
		});
		this.ready = new Promise((resolve, reject) => {
			video.addEventListener(
				'loadedmetadata',
				() => {
					resolve(Number.isFinite(video.duration) ? video.duration : durationHint);
				},
				{ once: true },
			);
			video.addEventListener(
				'error',
				() => {
					const code = video.error?.code;
					this.onError(
						code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
							? 'decode'
							: 'open',
					);
					reject(new Error(video.error?.message ?? 'video error'));
				},
				{ once: true },
			);
		});
		const tick = () => {
			if (!video.paused) this.onTime(video.currentTime);
			this.frame = requestAnimationFrame(tick);
		};
		this.frame = requestAnimationFrame(tick);
	}

	attach(container: HTMLElement) {
		container.replaceChildren(this.video);
	}

	time(): number {
		return this.video.currentTime;
	}

	async play() {
		// Web Audio takes the element's sound on the first play, from a user gesture.
		if (!this.context) {
			try {
				this.context = new AudioContext({ latencyHint: 'playback' });
				const source = this.context.createMediaElementSource(this.video);
				const output = await AudioOutput.create(this.context);
				source.connect(output.inlet);
				this.output = output;
				output.setCompressor(this.compressor);
				output.setVolume(this.level.volume, this.level.muted);
				this.video.volume = 1;
				this.video.muted = false;
			} catch (error) {
				console.warn('[player] Web Audio unavailable, plain volume only', error);
			}
		}
		void this.context?.resume();
		await this.video.play().catch(() => undefined);
	}

	pause() {
		this.video.pause();
	}

	seek(time: number) {
		this.video.currentTime = Math.max(0, time);
		this.onTime(this.video.currentTime);
	}

	setVolume(volume: number, muted: boolean) {
		this.level = { volume, muted };
		if (this.output) {
			this.output.setVolume(volume, muted);
		} else {
			this.video.volume = volume ** 2;
			this.video.muted = muted;
		}
	}

	setCompressor(enabled: boolean) {
		this.compressor = enabled;
		this.output?.setCompressor(enabled);
	}

	dispose() {
		cancelAnimationFrame(this.frame);
		this.video.pause();
		this.video.removeAttribute('src');
		this.video.load();
		void this.context?.close();
	}
}

export function createEngine(url: string, durationHint: number, preferElement = false): Engine {
	return webCodecsAvailable() && !preferElement
		? new MediabunnyEngine(url, durationHint)
		: new ElementEngine(url, durationHint);
}
