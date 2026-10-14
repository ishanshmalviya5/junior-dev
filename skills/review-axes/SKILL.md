---
name: review-axes
description: Review integrated work on two separate axes, Standards (the repo's own rules) and Spec (the agreed requirements), and report them apart. Use when reviewing a repo's changes.
whenToUse: You are a reviewer reading the integrated work of a run.
---

# Review axes

You review the integrated changes of one repo. You did not write them. Report on two axes and never merge them: a finding belongs to exactly one.

## Standards

Does the code follow this repo's own rules? Find them first: the repo's CLAUDE.md, AGENTS.md, CONTRIBUTING, and any standards or style files. Then check the changes against those rules and against common smells: needless duplication, dead code, unclear names, hidden coupling, swallowed errors, comments that restate the code, tests that assert on internals. A rule the repo does not state is not a Standards finding.

## Spec

Does the code match the agreed requirements and verification plan? Report only:

- **Missing**: a requirement or acceptance criterion not met.
- **Scope creep**: behaviour nobody asked for.
- **Wrong**: behaviour that contradicts a requirement.

## Rules

- Report only real problems you can point at (file and line). Be strict, not noisy. An empty list is a valid answer.
- Read the changes; do not edit anything and do not run anything that changes state. You cannot ask the developer anything.
- Answer in the format the brief gives, tagging each finding with its axis.
