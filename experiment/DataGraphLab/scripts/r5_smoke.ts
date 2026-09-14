import { join } from 'node:path';
import { runScale, writeScaleResults } from '../eval/scale.js';

const rep = runScale({
  grid: [1000, 10000],
  seeds: [0, 1, 2],
  outRoot: join(process.cwd(), 'runs'),
  runId: `scale-20260914T23-r7-smoke`,
  includeKCoverage: false,
});
writeScaleResults(join(rep.runDir, 'results.json'), join(rep.runDir, 'results.csv'), rep);
console.log(`SMOKE_DONE ${rep.runDir}`);
