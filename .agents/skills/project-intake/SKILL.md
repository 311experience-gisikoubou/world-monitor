---
name: project-intake
description: Use when a user starts a new project or meaningful feature from a short request such as これがしたい, wants a one-page project brief before implementation, or needs a LIGHT/FULL intake decision before entering the existing Foundation workflow.
---

# Project Intake

## Purpose

Turn a short human request into a bounded repository artifact before implementation starts.
This skill is only the intake layer. It does not replace preflight-audit, AI task routing, staged reality checks, test-gate, final-pr-audit, Human Decision Sync, or merge authorization.

## Standard flow

```text
short user intent
-> AI organizes the brief
-> human resolves at most 3 value/specification questions
-> explicit human approval is recorded in Human Decision Sync
-> project-intake emits a task packet
-> existing Foundation implementation/test/audit workflow continues
```

## Profiles

- `LIGHT`: no escalation signal is true. Existing minimum security, targeted verification, diff checks, and final audit still apply.
- `FULL`: automatically selected when any of these are true: protected/patient data, external communication, added cost/paid usage, authentication/identity, production impact, or real-data impact.
- Profiles do not create two code starter projects. Technology scaffolding remains repository-local.

## Brief rules

- Use the closed schema in `templates/project-brief.json`.
- `assumptions` is always present. Use `[]` when none are needed; never hide an AI assumption outside the field.
- `humanQuestions` contains only unresolved human value/specification questions and is limited to 3.
- `APPROVED` requires zero unresolved human questions plus a matching `CONFIRMED` / `EXPLICIT_HUMAN` Human Decision Sync record.
- The approval topic is deterministic: `project-intake:<intakeId>`.
- Patient, clinic, billing, sales, credential, or other protected real data must not be copied into the brief.

## Commands

Validate or classify:
```text
node .agents/skills/project-intake/project-intake-gate.mjs --brief-file <brief.json> --context-file PROJECT_CONTEXT.json --pretty
```

Render the deterministic one-page brief:
```text
node .agents/skills/project-intake/project-intake-gate.mjs --brief-file <brief.json> --render
```

Emit the implementation task packet after approval:
```text
node .agents/skills/project-intake/project-intake-gate.mjs --brief-file <brief.json> --context-file PROJECT_CONTEXT.json --packet --pretty
```

## Downstream ownership

The emitted packet points to the existing canonical mechanisms:
- `preflight-audit` for security, ownership, cost, provider and route checks.
- `implementation-orchestrator.mjs` for the qualified implementation route.
- `staged-reality-gate.mjs` and `test-gate` for objective intermediate/final verification.
- `final-pr-audit` for merge-readiness.
- Human Decision Sync for approved human authority.

AI-to-AI transfer uses repository artifacts. Do not make the human copy/paste task state between AIs when a machine-readable repository path exists.

## Ideas

Do not create a second idea database or service. Foundation-wide ideas belong in the Foundation status registry with maturity state `idea`.

## Verification

```text
node .agents/skills/project-intake/project-intake-gate-selftest.mjs
```
