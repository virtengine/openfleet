# Library Resolver Benchmark

Runs synthetic scale benchmarks for the Phase 0 and Phase 1 library-resolver work.

## Usage

```bash
npm run bench:library:resolver
node bench/library/library-resolver-bench.mjs --agents=500 --prompts=500 --skills=5000 --mcps=1000 --iterations=30
```

## What it measures

- fixture population time
- manifest rebuild time
- compiled agent-index build time
- compiled agent-index load time
- cold resolve latency
- cold plan-resolve latency
- warm resolve latency percentiles
- warm plan-resolve latency percentiles

## Notes

- This harness focuses on resolver hot-path behavior after synthetic libraries are populated.
- The current Phase 1 compiled index covers agent-profile metadata used by resolver matching.
- Prompt, skill, MCP, and tool indexing are the next expansion steps after the agent-profile path is stable.
