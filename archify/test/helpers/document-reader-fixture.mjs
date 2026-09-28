import assert from 'node:assert/strict';
import fs from 'node:fs';

// Exercise the supported document reader on a pre-canvas template shell.
// Only the shell hook changes: the delivered compact runtime, SVG, and payloads
// remain intact. Current fixed-canvas behavior has dedicated browser suites.
export function useDocumentReader(file) {
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(html.split('id="diagram-notes"').length, 2, 'expected one canvas shell hook');
  fs.writeFileSync(file, html.replace('id="diagram-notes"', 'id="reader-rail"')
    .replaceAll('aria-controls="diagram-notes"', 'aria-controls="reader-rail"'));
}
