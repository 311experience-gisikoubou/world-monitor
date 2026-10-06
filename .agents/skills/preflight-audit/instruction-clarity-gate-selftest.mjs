#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gatePath = path.resolve(gateArg);
const { evaluateInstructionClarity, validateInstructionClarityInput } = await import(pathToFileURL(gatePath).href);

function base(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    instructions: [
      { id: 'human-1', kind: 'INSTRUCTION', summary: 'Implement the requested change without altering approved unrelated behavior.' },
    ],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
    ...overrides,
  };
}
function ambiguity(overrides = {}) {
  return {
    id: 'amb-1',
    summary: 'A decision remains to be classified.',
    category: 'ai-resolvable-technical-detail',
    materiality: 'NON_MATERIAL',
    classificationReason: 'Technical implementation detail that does not change approved intent.',
    decisionOwner: 'AI',
    resolution: 'UNRESOLVED',
    ...overrides,
  };
}

{
  const result = evaluateInstructionClarity(base());
  assert.equal(result.result, 'PROCEED');
  assert.equal(result.code, 'INSTRUCTION_CLARITY_CONFIRMED');
  assert.equal(result.instructionCount, 1);
  assert.equal(result.ambiguityCount, 0);
}

// Material user-visible ambiguity -> STOP before implementation.
{
  const result = evaluateInstructionClarity(base({
    ambiguities: [ambiguity({
      id: 'visual-choice',
      summary: 'Two interpretations change the visible design.',
      category: 'user-visible-design-behavior',
      materiality: 'MATERIAL',
      classificationReason: 'Different choices visibly change the human-approved result.',
      decisionOwner: 'HUMAN',
      resolution: 'UNRESOLVED',
    })],
  }));
  assert.equal(result.result, 'STOP');
  assert.equal(result.code, 'MATERIAL_AMBIGUITY_UNRESOLVED');
  assert.deepEqual(result.ambiguityIds, ['visual-choice']);
}

// Hidden/unlisted assumption -> STOP.
{
  const result = evaluateInstructionClarity(base({ unlistedAssumptionsPresent: true }));
  assert.equal(result.code, 'UNLISTED_ASSUMPTION_PRESENT');
}

// Explicit harmless reversible non-material assumption -> PROCEED.
{
  const result = evaluateInstructionClarity(base({
    ambiguities: [ambiguity({
      id: 'reversible-default',
      summary: 'Use the existing sibling naming convention for an internal helper.',
      category: 'harmless-reversible-non-material',
      materiality: 'NON_MATERIAL',
      classificationReason: 'Internal naming is reversible and does not affect user-visible or business behavior.',
      decisionOwner: 'AI',
      resolution: 'EXPLICIT_ASSUMPTION',
      assumptionJustification: 'Reuse the local naming convention to minimize change.',
    })],
  }));
  assert.equal(result.result, 'PROCEED');
  assert.equal(result.assumptionCount, 1);
}

// AI-resolvable technical detail -> PROCEED without human question.
{
  const result = evaluateInstructionClarity(base({ ambiguities: [ambiguity()] }));
  assert.equal(result.result, 'PROCEED');
  assert.equal(result.nonMaterialCount, 1);
}

// Human clarification recorded -> PROCEED and preserve reference.
{
  const result = evaluateInstructionClarity(base({
    ambiguities: [ambiguity({
      id: 'cost-choice',
      summary: 'Whether a recurring-cost route may be used.',
      category: 'recurring-cost',
      materiality: 'MATERIAL',
      classificationReason: 'Recurring cost changes a human ownership/value decision.',
      decisionOwner: 'HUMAN',
      resolution: 'HUMAN_CLARIFICATION_RECORDED',
      humanClarificationRef: 'decision-42',
    })],
  }));
  assert.equal(result.result, 'PROCEED');
  assert.equal(result.materialResolvedCount, 1);
  assert.equal(result.humanClarificationCount, 1);
  assert.equal(result.evidence.ambiguities[0].humanClarificationRef, 'decision-42');
}

// A material item cannot be converted into an AI assumption.
{
  const result = evaluateInstructionClarity(base({
    ambiguities: [ambiguity({
      id: 'destructive',
      summary: 'Whether existing records may be deleted.',
      category: 'destructive-action',
      materiality: 'MATERIAL',
      classificationReason: 'Deletion is destructive and requires human authority.',
      decisionOwner: 'HUMAN',
      resolution: 'EXPLICIT_ASSUMPTION',
      assumptionJustification: 'Assume deletion is fine.',
    })],
  }));
  assert.equal(result.code, 'SCHEMA_INVALID');
  assert(result.errors.includes('ambiguity_assumption_not_allowed'));
}

// Malformed / unknown schema/value -> STOP.
assert.equal(evaluateInstructionClarity(null).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity({ ...base(), schemaVersion: 2 }).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity({ ...base(), extraField: 1 }).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity({ ...base(), instructions: [] }).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity({
  ...base(),
  instructions: [{ id: 'x', kind: 'UNKNOWN', summary: 'x' }],
}).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity(base({
  ambiguities: [ambiguity({ category: 'unknown-category' })],
})).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity(base({
  ambiguities: [ambiguity({ materiality: 'MATERIAL' })],
})).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity(base({
  ambiguities: [ambiguity({ decisionOwner: 'HUMAN' })],
})).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity(base({
  ambiguities: [ambiguity({
    resolution: 'EXPLICIT_ASSUMPTION',
    assumptionJustification: undefined,
  })],
})).code, 'SCHEMA_INVALID');
assert.equal(evaluateInstructionClarity(base({
  ambiguities: [ambiguity({
    category: 'recurring-cost',
    materiality: 'MATERIAL',
    decisionOwner: 'HUMAN',
    resolution: 'HUMAN_CLARIFICATION_RECORDED',
    humanClarificationRef: undefined,
  })],
})).code, 'SCHEMA_INVALID');
assert.equal(validateInstructionClarityInput(base()).length, 0);

// CLI smoke.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-clarity-gate-'));
  try {
    const okFile = path.join(tmp, 'ok.json');
    fs.writeFileSync(okFile, JSON.stringify(base()), 'utf8');
    const ok = spawnSync(process.execPath, [gatePath, '--input', okFile], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `CLI PROCEED path should exit 0: ${ok.stdout} ${ok.stderr}`);
    assert(ok.stdout.includes('"INSTRUCTION_CLARITY_CONFIRMED"'));

    const badFile = path.join(tmp, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify(base({ unlistedAssumptionsPresent: true })), 'utf8');
    const bad = spawnSync(process.execPath, [gatePath, '--input', badFile], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert(bad.stdout.includes('"UNLISTED_ASSUMPTION_PRESENT"'));

    const missingArg = spawnSync(process.execPath, [gatePath], { encoding: 'utf8' });
    assert.equal(missingArg.status, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('instruction-clarity-gate selftest: PASS');
