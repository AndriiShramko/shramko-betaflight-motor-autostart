// After `vite build`: write dist/release.json with a content hash of the build, so the page,
// error reports and the deploy script all name the same release.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const dist = resolve(process.env.SMA_OUT || 'dist');
const files = [];
const walk = (d) => {
    for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!p.endsWith('.map') && !p.endsWith('release.json')) files.push(p);
    }
};
walk(dist);
files.sort();
const h = createHash('sha256');
for (const f of files) {
    h.update(relative(dist, f).split('\\').join('/'));
    h.update(readFileSync(f));
}
const sha = h.digest('hex').substring(0, 12);

// Guard: the GA4 id committed in web/.env.production must be in the built bundle, exactly. An empty or
// overridden VITE_GA_ID builds a site without the consent banner and without analytics, silently
// (Drony Bydgoszcz lost GA for 8 days that way). deploy/deploy.sh checks the artifact once more.
const envFile = readFileSync(resolve('web/.env.production'), 'utf8');
const gaId = (/^VITE_GA_ID=(.*)$/m.exec(envFile)?.[1] ?? '').trim();
if (!/^G-[A-Z0-9]{6,16}$/.test(gaId)) {
    console.error(`post-build: REFUSED — web/.env.production has no GA4 id (VITE_GA_ID="${gaId}")`);
    process.exit(1);
}
const bundles = files.filter((f) => /[\\/]assets[\\/][^\\/]+\.js$/.test(f));
const idsIn = (f) => new Set([...readFileSync(f, 'utf8').matchAll(/(?<![A-Za-z0-9])G-[A-Z0-9]{6,16}(?![A-Za-z0-9])/g)].map((m) => m[0]));
const withId = bundles.filter((f) => idsIn(f).has(gaId));
if (!withId.length) {
    const env = process.env.VITE_GA_ID !== undefined ? ` (the environment sets VITE_GA_ID="${process.env.VITE_GA_ID}", which wins over the file)` : '';
    console.error(`post-build: REFUSED — no JS bundle in dist/assets contains the GA4 id ${gaId}${env}`);
    process.exit(1);
}
const otherIds = new Set(bundles.flatMap((f) => [...idsIn(f)]).filter((id) => id !== gaId));
if (otherIds.size) {
    console.error(`post-build: REFUSED — the bundle carries another GA4 id too: ${[...otherIds].join(', ')}`);
    process.exit(1);
}
console.log(`GA4 ${gaId} in ${withId.map((f) => relative(dist, f).split('\\').join('/')).join(', ')}`);
writeFileSync(join(dist, 'release.json'), `${JSON.stringify({ sha, built: new Date().toISOString() })}\n`);
console.log(`release ${sha} (${files.length} files)`);
