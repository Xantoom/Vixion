/**
 * The page's default Trusted Types policy. The server asks for Trusted Types, so a string reaching
 * an HTML, script or script-URL sink goes through here first. Nothing in the app writes HTML or
 * runs strings as code: only script URLs are let through, the page's own and the blob: URLs the
 * video library builds its workers from. Anything else is refused.
 */
interface Policy {
	createScriptURL: (url: string) => string;
}

type Factory = { createPolicy: (name: string, rules: Policy) => unknown };

export function installTrustedTypes() {
	const factory = (globalThis as { trustedTypes?: Factory }).trustedTypes;
	if (!factory) return;
	try {
		factory.createPolicy('default', {
			createScriptURL: (url) => {
				const parsed = new URL(url, document.baseURI);
				if (parsed.protocol === 'blob:' || parsed.origin === window.location.origin) return url;
				throw new TypeError(`Script URL refused: ${parsed.origin}`);
			},
		});
	} catch (error) {
		// Created already (a hot reload), or forbidden by the policy's name list.
		console.warn('[trusted-types]', error);
	}
}
