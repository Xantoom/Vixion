/**
 * A broadcast-style compressor for stream audio: quiet talk comes up, shouting and loud game
 * moments come down, and nothing clips.
 *
 * - Stereo-linked RMS detection (5 ms), so the image doesn't wander and transients don't pump.
 * - Soft-knee gain curve: threshold −28 dBFS, ratio 5:1, 12 dB knee.
 * - Program-dependent release: fast after a short peak, slower under sustained loudness.
 * - Makeup gain chosen so that speech around −20 dBFS comes out near −15 dBFS.
 * - 5 ms lookahead feeding a true-peak-ish limiter at −1 dBFS, then a soft clip as a last guard.
 *
 * Switching it off crossfades to the (equally delayed) dry signal, so toggling never clicks.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}

const THRESHOLD = -28;
const RATIO = 5;
const KNEE = 12;
const CEILING_DB = -1;
const LOOKAHEAD_S = 0.005;

function linear(decibels: number): number {
	return 10 ** (decibels / 20);
}

/** Output level for an input level, with a soft knee: dB in, dB out. */
function curve(input: number): number {
	const over = input - THRESHOLD;
	if (2 * over < -KNEE) return input;
	if (2 * Math.abs(over) <= KNEE) return input + ((1 / RATIO - 1) * (over + KNEE / 2) ** 2) / (2 * KNEE);
	return THRESHOLD + over / RATIO;
}

const MAKEUP_DB = -15 - curve(-20);
const CEILING = linear(CEILING_DB);

function coefficient(seconds: number): number {
	return Math.exp(-1 / (seconds * sampleRate));
}

class Compressor extends AudioWorkletProcessor {
	private enabled = false;
	/** 0 = dry, 1 = compressed; moves toward `enabled` over ~20 ms. */
	private mix = 0;
	private readonly mixStep = 1 / (0.02 * sampleRate);
	private readonly lookahead = Math.max(1, Math.round(LOOKAHEAD_S * sampleRate));
	private delay: Float32Array[] = [];
	private write = 0;
	/** Mean square of the input, smoothed. */
	private power = 0;
	private readonly powerCoef = coefficient(0.005);
	/** Gain reduction in dB (≤ 0), smoothed. */
	private reduction = 0;
	private readonly attack = coefficient(0.004);
	private readonly releaseFast = coefficient(0.08);
	private readonly releaseSlow = coefficient(0.6);
	/** How long the compressor has been working hard: slows the release. */
	private sustained = 0;
	private readonly sustainCoef = coefficient(0.4);
	/** Limiter gain (≤ 1), smoothed: falls within the lookahead, recovers over 60 ms. */
	private limit = 1;
	private readonly limitAttack = coefficient(LOOKAHEAD_S / 3);
	private readonly limitRelease = coefficient(0.06);

	constructor() {
		super();
		this.port.onmessage = (event: MessageEvent<{ enabled: boolean }>) => {
			this.enabled = event.data.enabled;
		};
	}

	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const input = inputs[0];
		const output = outputs[0];
		if (!input || !output || input.length === 0) return true;
		const channels = Math.min(input.length, output.length);
		const frames = input[0]?.length ?? 0;
		while (this.delay.length < channels) this.delay.push(new Float32Array(this.lookahead));

		for (let i = 0; i < frames; i++) {
			// Detection on the incoming sample; gain applied to the one leaving the delay line.
			let sum = 0;
			let peak = 0;
			for (let c = 0; c < channels; c++) {
				const x = input[c]?.[i] ?? 0;
				sum += x * x;
				peak = Math.max(peak, Math.abs(x));
			}
			this.power = this.powerCoef * this.power + (1 - this.powerCoef) * (sum / channels);
			const level = 10 * Math.log10(Math.max(this.power, 1e-12));
			const target = curve(level) - level;

			if (target < this.reduction) {
				this.reduction = this.attack * this.reduction + (1 - this.attack) * target;
			} else {
				const release = this.releaseFast + (this.releaseSlow - this.releaseFast) * this.sustained;
				this.reduction = release * this.reduction + (1 - release) * target;
			}
			const working = this.reduction < -6 ? 1 : 0;
			this.sustained = this.sustainCoef * this.sustained + (1 - this.sustainCoef) * working;

			const gain = linear(this.reduction + MAKEUP_DB);
			// What the peak will be once compressed: the limiter brings it under the ceiling in time.
			const projected = peak * gain;
			const needed = projected > CEILING ? CEILING / projected : 1;
			const coef = needed < this.limit ? this.limitAttack : this.limitRelease;
			this.limit = coef * this.limit + (1 - coef) * needed;

			if (this.enabled) this.mix = Math.min(1, this.mix + this.mixStep);
			else this.mix = Math.max(0, this.mix - this.mixStep);
			const wet = gain * this.limit;

			for (let c = 0; c < channels; c++) {
				const line = this.delay[c];
				const out = output[c];
				if (!line || !out) continue;
				const delayed = line[this.write] ?? 0;
				line[this.write] = input[c]?.[i] ?? 0;
				let y = delayed * (1 - this.mix + this.mix * wet);
				// Last guard: a gentle clip above the ceiling, never a hard one.
				if (this.mix > 0 && Math.abs(y) > CEILING)
					y = Math.sign(y) * (CEILING + (1 - CEILING) * Math.tanh((Math.abs(y) - CEILING) / (1 - CEILING)));
				out[i] = y;
			}
			this.write = (this.write + 1) % this.lookahead;
		}
		// Mono input on a stereo output: copy the channel across.
		for (let c = channels; c < output.length; c++) output[c]?.set(output[0] ?? new Float32Array(frames));
		return true;
	}
}

registerProcessor('vixion-compressor', Compressor);

export {};
