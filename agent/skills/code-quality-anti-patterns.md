# Skill: Code Quality Anti-Patterns

- Keep caches, lazy singletons, and loaded flags at module scope.
- Await async work or attach `.catch()`; never leave floating promises.
- Wrap hot-path callbacks and handlers in error boundaries.
- Mock external boundaries only; avoid over-mocking the module under test.
- Keep tests deterministic and remove dead branches instead of layering guard code.
