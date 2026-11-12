#!/usr/bin/env bun
/**
 * Cuts a release: `bun scripts/release.ts <patch|minor|major|x.y.z[-pre]>`.
 *
 * Moves the changelog's Unreleased section under the new version, sets that version in
 * server/Cargo.toml, Cargo.lock and web/package.json, commits, and tags `vX.Y.Z` with the
 * section as the tag message. Nothing is pushed: the command to do it is printed at the end.
 * Pushing the tag starts the release workflow (binaries, images, GitHub release).
 */
import { $ } from 'bun';

const root = new URL('..', import.meta.url).pathname;
const paths = {
	cargo: `${root}server/Cargo.toml`,
	lock: `${root}Cargo.lock`,
	pkg: `${root}web/package.json`,
	changelog: `${root}CHANGELOG.md`,
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
	console.error(`release: ${message}`);
	process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail('usage: bun scripts/release.ts <patch|minor|major|x.y.z[-pre]>');

const cargo = await Bun.file(paths.cargo).text();
const current = /^version = "([^"]+)"/m.exec(cargo)?.[1];
if (!current) fail('no version in server/Cargo.toml');
const [, major, minor, patch] = (SEMVER.exec(current) ?? fail(`bad version ${current}`)).map(Number);

const next =
	arg === 'major'
		? `${major + 1}.0.0`
		: arg === 'minor'
			? `${major}.${minor + 1}.0`
			: arg === 'patch'
				? `${major}.${minor}.${patch + 1}`
				: arg;
if (!SEMVER.test(next)) fail(`not a version: ${next}`);
const tag = `v${next}`;

if ((await $`git status --porcelain`.cwd(root).text()).trim()) fail('commit or stash your changes first');
if ((await $`git tag --list ${tag}`.cwd(root).text()).trim()) fail(`${tag} already exists`);

// The changelog: what is under Unreleased becomes the release.
const changelog = await Bun.file(paths.changelog).text();
const start = changelog.indexOf('## [Unreleased]');
if (start < 0) fail('CHANGELOG.md has no “## [Unreleased]” section');
const bodyStart = changelog.indexOf('\n', start) + 1;
const nextSection = changelog.indexOf('\n## [', bodyStart);
const linksStart = changelog.search(/\n\[[^\]]+\]: /);
const bodyEnd = nextSection >= 0 ? nextSection + 1 : linksStart >= 0 ? linksStart + 1 : changelog.length;
const notes = changelog.slice(bodyStart, bodyEnd).trim();
if (!notes) fail('nothing under Unreleased: write down what changed first');

const date = new Date().toISOString().slice(0, 10);
const repo = /^repository = "([^"]+)"/m.exec(cargo)?.[1] ?? '';
const previous = /^## \[(\d[^\]]*)\]/m.exec(changelog.slice(bodyEnd))?.[1];
let updated = `${changelog.slice(0, start)}## [Unreleased]\n\n## [${next}] - ${date}\n\n${notes}\n\n${changelog.slice(bodyEnd).replace(/^\n+/, '')}`;
// Comparison links at the bottom, Keep a Changelog style.
updated = updated.replace(/^\[Unreleased\]: .*$\n?/m, '').trimEnd();
const links = [
	`[Unreleased]: ${repo}/compare/${tag}...HEAD`,
	`[${next}]: ${previous ? `${repo}/compare/v${previous}...${tag}` : `${repo}/releases/tag/${tag}`}`,
];
updated = updated.replace(/\n(\[[^\]]+\]: )/, `\n${links.join('\n')}\n$1`);
if (!updated.includes(links[1] ?? '')) updated += `\n\n${links.join('\n')}`;
await Bun.write(paths.changelog, `${updated}\n`);

await Bun.write(paths.cargo, cargo.replace(/^version = "[^"]+"/m, `version = "${next}"`));
const lock = await Bun.file(paths.lock).text();
await Bun.write(paths.lock, lock.replace(/(name = "vixion"\nversion = )"[^"]+"/, `$1"${next}"`));
const pkg = await Bun.file(paths.pkg).text();
await Bun.write(paths.pkg, pkg.replace(/"version": "[^"]+"/, `"version": "${next}"`));

await $`git add ${paths.cargo} ${paths.lock} ${paths.pkg} ${paths.changelog}`.cwd(root);
await $`git commit -q -m ${`Release ${tag}`}`.cwd(root);
await $`git tag -a --cleanup=verbatim ${tag} -m ${`Vixion ${next}\n\n${notes}`}`.cwd(root);

console.log(`${current} → ${next}: committed and tagged ${tag}.`);
console.log('Publish it with:');
console.log(`  git push origin HEAD ${tag}`);
