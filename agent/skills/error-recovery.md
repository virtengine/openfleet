# Skill: Error Recovery Patterns

- Classify the failure first: syntax, test, dependency, git, network, config, or resource limits.
- Fix the first real error before chasing downstream noise.
- Prefer the smallest safe change that resolves the root cause.
- If the error is external or flaky, retry with limits and stop rather than papering over it.
