import workletUrl from './compressor.worklet.ts?worker&url';

/**
 * The end of the sound path, shared by both engines: sources → compressor → volume → speakers.
 * The compressor is the AudioWorklet one where the page may load worklets (a secure context);
 * elsewhere the browser's own DynamicsCompressor, tuned the same way, stands in for it.
 */
export class AudioOutput {
	readonly inlet: AudioNode;
	private readonly volume: GainNode;
	private readonly setEnabled: (enabled: boolean) => void;

	private constructor(
		readonly context: AudioContext,
		inlet: AudioNode,
		volume: GainNode,
		setEnabled: (enabled: boolean) => void,
	) {
		this.inlet = inlet;
		this.volume = volume;
		this.setEnabled = setEnabled;
	}

	static async create(context: AudioContext): Promise<AudioOutput> {
		const volume = context.createGain();
		volume.connect(context.destination);
		if (context.audioWorklet) {
			try {
				await context.audioWorklet.addModule(workletUrl);
				const node = new AudioWorkletNode(context, 'vixion-compressor', {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [2],
				});
				node.connect(volume);
				return new AudioOutput(context, node, volume, (enabled) => {
					node.port.postMessage({ enabled });
				});
			} catch (error) {
				console.warn('[player] compressor worklet unavailable, using the built-in one', error);
			}
		}
		// Dry and compressed paths side by side, crossfaded so switching never clicks.
		const inlet = context.createGain();
		const dry = context.createGain();
		const wet = context.createGain();
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = -28;
		compressor.knee.value = 12;
		compressor.ratio.value = 5;
		compressor.attack.value = 0.004;
		compressor.release.value = 0.2;
		inlet.connect(dry).connect(volume);
		inlet.connect(compressor).connect(wet).connect(volume);
		wet.gain.value = 0;
		return new AudioOutput(context, inlet, volume, (enabled) => {
			const now = context.currentTime;
			dry.gain.setTargetAtTime(enabled ? 0 : 1, now, 0.01);
			wet.gain.setTargetAtTime(enabled ? 1 : 0, now, 0.01);
		});
	}

	setCompressor(enabled: boolean) {
		this.setEnabled(enabled);
	}

	/** Volume from 0 to 1, heard on a curve: half-way sounds half as loud. */
	setVolume(level: number, muted: boolean) {
		const gain = muted ? 0 : Math.max(0, Math.min(1, level)) ** 2;
		this.volume.gain.setTargetAtTime(gain, this.context.currentTime, 0.015);
	}
}
