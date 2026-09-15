import { join } from 'node:path';
import { runScale, writeScaleResults } from '../eval/scale.js';

const rep = runScale({
  grid: [1000, 10000, 30000],
  seeds: [0, 1, 2, 3, 4],
  outRoot: join(process.cwd(), 'runs'),
  runId: `scale-${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}-soften-full`,
  includeKCoverage: true,
  coverageN: 1000,
});
writeScaleResults(join(rep.runDir, 'results.json'), join(rep.runDir, 'results.csv'), rep);
console.log(`SOFTEN_FULL_DONE ${rep.runDir}`);
