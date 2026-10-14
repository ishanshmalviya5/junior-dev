---
name: slicing
description: Break a work item into leaves that each cut one complete path and can be proved alone. Use when planning how to split an item with jd_split.
whenToUse: You are a planner and must split an item into child leaves.
---

# Slicing

You split an item into leaves. A leaf is small enough for one worker to build and prove in one sitting. You write no code.

## Rules

- **Vertical, not horizontal.** Each leaf cuts a narrow but complete path through every layer it touches (data, logic, interface, checks). Never make a leaf that is "all the schema" or "all the UI".
- **Provable alone.** Each leaf has its own check: a shell command that exits 0 when the leaf is done. A leaf with no way to be checked is too vague; sharpen it.
- **Prefactor first.** If the code is awkward for the change, make the first leaf a refactor leaf that reshapes it with no behaviour change ("make the change easy, then make the easy change"). Later leaves depend on it.
- **Mark every leaf.** A behaviour leaf changes what the software does: its check must fail before the work and pass after (red-first). A refactor leaf changes structure only: its check must pass both before and after. Say which in the leaf title or goal.
- **Wide refactors are the exception.** When one mechanical change (a rename, a retyped shared symbol) breaks many call sites at once, do not force vertical slices. Use expand, migrate, contract: (1) expand by adding the new form beside the old; (2) migrate callers in batches, one leaf per package or directory, each depending on the expand; (3) contract by deleting the old form in a leaf that depends on every migrate leaf. Everything stays green throughout.
- **Order with dependencies.** Give each leaf `dependsOn` only for what truly gates it. No loops.
- **Cover everything.** The children's done-when must together cover every criterion of the parent, and every leaf traces to requirements.

## Doubt

You cannot ask the developer. If the documents do not settle a split, use `jd_decide` with your evidence. If something blocks you, use `jd_block`.
