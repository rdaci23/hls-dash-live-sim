const { test } = require('node:test'), assert = require('node:assert/strict');
const { kinds, definition, correlate } = require('../scripts/browser/scenario-observations.cjs'), { parseScenario } = require('../dist/support-tools/scenario.js');
test('browser observations only define supported bounded scenario actions', () => { for (const p of ['hls', 'dash'])
    for (const k of kinds) {
        const v = definition(p, k);
        assert.doesNotThrow(() => parseScenario(v));
        assert.equal(v.version, 1);
    } assert.throws(() => definition('hls', 'unknown')); });
test('browser evidence cannot qualify without request and fault identity correlation', () => { const e = { event: 'fault.applied', requestId: 'req1', faultId: 'fault1', fault: 'scenario.payload' }; assert.throws(() => correlate([], [e])); assert.throws(() => correlate([{ requestId: 'req2', faultIds: 'fault1' }], [e])); assert.throws(() => correlate([{ requestId: 'req1', faultIds: 'fault2' }], [e])); assert.equal(correlate([{ requestId: 'req1', faultIds: 'fault1' }], [e]).length, 1); });

test("late manifest corruption binds the next refresh rather than absolute attempt one",()=>{for(const p of ["hls","dash"])assert.equal(definition(p,"malformed-manifest").rules[0].target.segment,"next");});
