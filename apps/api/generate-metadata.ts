import * as fs from 'fs';
import * as path from 'path';
import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
import { ReadonlyVisitor } from '@nestjs/swagger/dist/plugin';

const metadataPath = path.join(__dirname, 'src', 'metadata.ts');

// Bootstrap stub for fresh checkouts: main.ts's `import('./metadata')` fails under tsc
// on a fresh clone before the generator runs — write a valid no-op so tsc can type-check.
if (!fs.existsSync(metadataPath)) {
  fs.writeFileSync(metadataPath, '/* eslint-disable */\nexport default async () => ({});\n', 'utf8');
}

const readonlyVisitor = new ReadonlyVisitor({
  introspectComments: true,
  pathToSource: path.join(__dirname, 'src'),
  dtoFileNameSuffix: ['.dto.ts'],
});

// Use the static factory — NOT tsBinary.parseJsonConfigFileContent + createProgram.
// The factory follows the tsconfig extends chain and resolves workspace-package source
// files via collectProjectReferenceSourceFiles, which is required for correct type
// resolution across @packages/* aliases. Manual program construction silently produces
// empty {} class metadata (G21 in typescript-runtime-gotchas.jsonl).
const program = ReadonlyVisitor.createTsProgram(path.join(__dirname, 'tsconfig.metadata.json'));

new PluginMetadataGenerator().generate({
  visitors: [readonlyVisitor],
  outputDir: path.join(__dirname, 'src'),
  tsProgramRef: program,
});

// Post-process: PluginMetadataGenerator emits extension-less relative imports
// (e.g. await import("./v1/foo.dto")). Under moduleResolution: NodeNext, tsc requires
// explicit .js extensions on relative paths. Append .js to every relative path that
// appears as either an object key (`["./v1/foo.dto"]:`) or an import argument
// (`import("./v1/foo.dto")`). Both must stay in lockstep — keys are used as lookups
// in the generated `t[...]` table.
const generated = fs.readFileSync(metadataPath, 'utf8');
// Three quoted-relative-path sites in the generated metadata, all of which need .js:
//   1. Object key declaration:   `["./v1/foo.dto"]: await import(...)`
//   2. Dynamic import argument:  `import("./v1/foo.dto")`
//   3. Table read (lookup):      `t["./v1/foo.dto"].SomeClass`
// Matching specific syntactic contexts (not bare `"./..."`) prevents touching
// any DTO `.describe()` strings that happen to start with `./`.
const withExtensions = generated
  .replace(/\["(\.\/[^"]+?)"\]/g, (match, relPath: string) => {
    if (relPath.endsWith('.js')) {
      return match;
    }
    return `["${relPath}.js"]`;
  })
  .replace(/import\("(\.\/[^"]+?)"\)/g, (match, relPath: string) => {
    if (relPath.endsWith('.js')) {
      return match;
    }
    return `import("${relPath}.js")`;
  });
fs.writeFileSync(metadataPath, withExtensions, 'utf8');
