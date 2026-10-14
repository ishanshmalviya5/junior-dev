---
name: red-first-building
description: Build a behaviour leaf red-first, one failing check at a time, and a refactor leaf with checks green throughout. Use when implementing any leaf.
whenToUse: You are a builder implementing a leaf.
---

# Red-first building

The plugin runs your leaf's checks itself and judges them itself. You cannot declare a check passed. Your job is to make them pass for the right reason.

## Behaviour leaf

A check that already passes proves nothing.

1. Run the leaf's check first. It must fail, and fail for the reason the leaf names (a missing behaviour, not a typo or a missing import). If it passes before any work, the check is wrong: strengthen it, or record the problem with `jd_decide`.
2. Work in vertical steps, one behaviour at a time: write one failing test, write the least code that passes it, repeat. Never write all the tests first and then all the code; tests written in bulk test imagined behaviour.
3. Keep every check you added or ran green before you submit. Run the repo's existing tests that touch your area too.

## Refactor leaf

Run its checks before you start; they must pass. Change structure only, in small steps, running the checks after each step. If a check turns red, undo the step. Do not add behaviour, and do not edit a check to make it pass.

## Rules

- Never weaken, delete or skip a check to get green. If a check looks wrong, use `jd_decide`; if it blocks you, use `jd_block`.
- You cannot ask the developer anything. Act through the `jd_*` tools; end with `jd_submit` and a short summary.
- Stay inside your leaf. A neighbouring problem you find is not yours to fix: note it in your submit summary.
- Follow the repo's own conventions (its CLAUDE.md, AGENTS.md, CONTRIBUTING or standards files) and its glossary words.
