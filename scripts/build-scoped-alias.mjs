// Generates the @parkviewlab/jonobones alias package into alias-build/.
//
// The unscoped `jonobones` is the canonical package; the scoped name is a
// thin functional alias: it pins the same version of jonobones as its only
// dependency and re-exposes the same `jonobones` binary. Generated from the
// canonical package.json at release time so the two can never drift.
// (A functional alias — not an empty placeholder — is what npm's dispute
// policy permits for holding a name.)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const outDir = join(repoRoot, 'alias-build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'bin'), { recursive: true });

const aliasPackage = {
  name: '@parkviewlab/jonobones',
  version: canonical.version,
  description: `${canonical.description} (alias of the canonical "jonobones" package)`,
  license: canonical.license,
  repository: canonical.repository,
  homepage: canonical.homepage,
  bugs: canonical.bugs,
  keywords: canonical.keywords,
  bin: { jonobones: 'bin/jonobones.js' },
  files: ['bin/'],
  engines: canonical.engines,
  dependencies: { jonobones: canonical.version },
  publishConfig: { access: 'public' },
};

writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(aliasPackage, null, 2)}\n`);

writeFileSync(
  join(outDir, 'bin', 'jonobones.js'),
  `#!/usr/bin/env node
// Alias shim: @parkviewlab/jonobones delegates to the canonical package.
import 'jonobones/bin/jonobones.js';
`,
);

writeFileSync(
  join(outDir, 'README.md'),
  `# @parkviewlab/jonobones

Alias of [**jonobones**](https://www.npmjs.com/package/jonobones), the
canonical package — same version, same \`jonobones\` binary. Install
whichever name you prefer:

\`\`\`sh
npm install -g jonobones
npm install -g @parkviewlab/jonobones
\`\`\`

Source, documentation, and issues: https://github.com/ParkviewLab/jonobones
`,
);

console.log(`alias-build/ generated for @parkviewlab/jonobones@${canonical.version}`);
