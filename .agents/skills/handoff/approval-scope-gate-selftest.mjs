#!/usr/bin/env node
import assert from 'node:assert/strict';
import { validateApprovalScopeGate } from './approval-scope-gate.mjs';

const H='a'.repeat(64), HEAD='b'.repeat(40);
function manifest(decisions=[]){
  return {
    canonicalContract:{requiredValidation:['canonical-contract-gate','human-decision-sync','approval-scope-gate'],artifacts:[{id:'screen-v1',kind:'DESIGN'}]},
    humanDecisionSync:{decisions,currentState:'x',nextAction:'y'}
  };
}
function d(id,approval,status='CONFIRMED'){
  return {id,topic:id,status,summary:'Explicit human design decision.',decidedAt:'2026-10-04',source:'EXPLICIT_HUMAN',type:'DESIGN',replaces:null,artifactIds:[],designApproval:approval};
}
const component={artifactId:'screen-v1',scope:'COMPONENT',approvalType:'COMPONENT_APPROVAL',designState:'LOCKED_COMPONENTS',evidenceText:'この歯式カードを採用',approvedContentSha256:H,approvedHead:HEAD};
const c=validateApprovalScopeGate(manifest([d('component',component)]));
assert.equal(c.result,'PROCEED');
assert.equal(c.approvals[0].scope,'COMPONENT');

const screen={artifactId:'screen-v1',scope:'SCREEN',approvalType:'WHOLE_SCREEN_APPROVAL',designState:'HUMAN_APPROVED',evidenceText:'この画面全体を最終デザインとして承認',approvedContentSha256:H,approvedHead:HEAD};
assert.equal(validateApprovalScopeGate(manifest([d('screen',screen)])).result,'PROCEED');

const ambiguous={...screen,evidenceText:'OK 採用します'};
assert.equal(validateApprovalScopeGate(manifest([d('ambiguous',ambiguous)])).code,'APPROVAL_SCOPE_RECORD_INVALID');

const promotedFromComponent={...component,scope:'SCREEN',approvalType:'CANONICAL_PROMOTION_APPROVAL',designState:'CANONICAL',evidenceText:'採用します'};
assert.equal(validateApprovalScopeGate(manifest([d('bad-promotion',promotedFromComponent)])).code,'APPROVAL_SCOPE_RECORD_INVALID');

const ai={...d('ai',screen),source:'AI_PROPOSAL',status:'PROPOSED'};
assert.equal(validateApprovalScopeGate(manifest([ai])).code,'APPROVAL_SCOPE_SOURCE_INVALID');

console.log('APPROVAL_SCOPE_GATE_SELFTEST=PASS component_lock=PASS explicit_screen=PASS ambiguous=STOP auto_escalation=STOP ai_authority=STOP');
