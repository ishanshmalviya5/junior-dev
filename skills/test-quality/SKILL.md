---
name: test-quality
description: What makes a check worth keeping: test behaviour through public interfaces, independent expected values, mocks only at system boundaries. Use when writing or editing tests.
whenToUse: You are a builder writing or changing tests for a leaf.
---

# Test quality

A good test survives refactoring because it describes what the software does, not how.

- **Public interfaces only.** Call the code the way its users do (exported functions, routes, the CLI). Do not reach into private state or assert on internal call order. If a test breaks when you rename an internal helper while behaviour is unchanged, it is testing the wrong thing.
- **Independent expected values.** Write the expected result from the requirement, as a literal. Never compute it with the same logic you are testing, and never paste in what the code currently returns without checking it is right.
- **Mock only at system boundaries.** Fake the network, the clock, randomness, the file system outside a temp dir, and paid or remote services. Do not mock your own modules or internal collaborators; use the real thing. Prefer small fakes you can read over call-counting mocks.
- **One behaviour per test**, named for that behaviour ("rejects an empty name"), not for the function.
- **Real failures.** Cover the error paths and edges the requirement names, not only the happy path.
- **Deterministic.** No sleeps, no order dependence, no shared state between tests. A flaky check is a defect; fix it or record it in your submit summary.
- **Fast and local.** Tests must run without secrets or a network unless the requirement is about them.
