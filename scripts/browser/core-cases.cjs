const fs = require('node:fs');
const path = require('node:path');
const PRESETS = Object.freeze({
  'hls-high': 'hls-high-rendition-outage', 'hls-low': 'hls-low-rendition-outage', 'dash-low': 'dash-low-rendition-outage',
  'hls-starvation': 'bandwidth-starvation', 'dash-starvation': 'bandwidth-starvation',
  'hls-oscillation': 'bandwidth-oscillation', 'dash-oscillation': 'bandwidth-oscillation'
});
function expectedCase(caseId) {
  if (!Object.hasOwn(PRESETS, caseId)) throw Error('Unknown expected core browser case');
  const preset = PRESETS[caseId];
  return { caseId, protocol: caseId.split('-')[0], preset, definition: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../examples/scenarios', preset + '.json'), 'utf8')) };
}
module.exports = { expectedCase, CASES: Object.freeze(Object.keys(PRESETS)) };
