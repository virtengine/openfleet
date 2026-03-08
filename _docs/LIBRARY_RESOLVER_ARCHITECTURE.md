# Library Resolver Architecture

## Why this exists

Bosun's current library manager is a good base, but it is still a **small-registry resolver** rather than a **large-scale knowledge and capability routing system**.

Today, the resolver in `infra/library-manager.mjs` primarily:

- loads manifest metadata from `.bosun/library.json`
- reads agent profile files during resolution
- scores candidates with a weighted heuristic over title patterns, scopes, tags, voice hints, and changed files
- imports remote libraries by cloning a repository and deriving lightweight agent metadata from Markdown

That is the right starting point for a few dozen entries. It is **not** the right final shape for a system expected to hold:

- hundreds of agents
- hundreds of prompts
- thousands of skills
- thousands of tools and MCP integrations
- continuously imported external libraries
- self-evolving knowledge created from successful runtime recovery loops

This document defines the target architecture for making the Bosun library system properly scalable, explainable, composable, and continuously improvable.

## Product goals

### Primary goals

1. **Massive library scale without user-visible slowdown**
   - The user should not feel a difference between 20 entries and 5,000+ entries.
   - Resolution latency must remain bounded by indexed retrieval and staged ranking rather than naive full scans.

2. **Optimal task resolution**
   - The system must determine not just a single agent profile, but the best **execution recipe** for a task:
     - agent profile
     - prompt stack
     - skill bundle
     - tool bundle
     - MCP servers
     - policy and risk gates

3. **Composable external libraries**
   - Bosun must support importing large remote libraries from sources such as `/virtengine/library` without degrading core runtime performance.
   - Imported assets must be versioned, namespaced, attributable, explainable, and easy to update.

4. **Continuous self-evolution**
   - When an agent eventually solves a hard problem after retries, replans, or long reasoning loops, Bosun should be able to convert that outcome into reusable library knowledge.
   - That knowledge must become a future acceleration path for the same or similar tasks.

5. **Auditability and trust**
   - Every resolution decision must be explainable.
   - Every self-created skill must carry provenance, quality signals, and promotion history.

### Non-goals

- Literal zero-cost scaling is not realistic.
- The real target is **flat user-perceived latency** through compiled indexes, bounded candidate sets, caching, and background ingestion.
- The system should prefer correctness and explainability over opaque "magic" routing.

## Current-state constraints

### What works now

- `matchAgentProfiles()` already supports multi-signal scoring.
- The API and UI already expose resolver results and import flows.
- Remote library import already exists for Markdown-based agent templates.
- Auto-apply already has score, confidence, and delta gates.

### Current bottlenecks

1. **Resolution still reads profile files eagerly**
   - `listAgentProfiles()` calls `getEntryContent()` for every agent entry.
   - That means resolution cost grows with profile count.

2. **Resolver is agent-first, not execution-plan-first**
   - It returns a best agent profile, not a fully composed plan.
   - Prompt, skill, tool, and MCP selection are still secondary flows.

3. **No compiled retrieval index**
   - Matching depends on manifest scanning and profile reads.
   - There is no inverted index, capability graph, feature store, or embedding stage.

4. **Import path is repo-clone-centric**
   - Cloning a whole repo is acceptable for curated imports, but not as the long-term ingestion model for a large shared ecosystem.

5. **No learning pipeline**
   - Bosun does not yet harvest repeated successful repair loops into reusable library artefacts.

6. **No quality lifecycle for generated knowledge**
   - There is no distinction between draft, experimental, trusted, deprecated, or superseded skills.

## Target architecture

The final system should be split into five layers:

1. **Registry layer**
2. **Compiled index layer**
3. **Resolver layer**
4. **Execution-plan layer**
5. **Learning and publishing layer**

### 1. Registry layer

The registry is the durable source of truth for all library artefacts.

#### Artefact types

The library must treat the following as first-class artefacts:

- `agent-profile`
- `prompt`
- `skill`
- `tool`
- `tool-bundle`
- `mcp-server`
- `mcp-bundle`
- `policy`
- `resolver-rule`
- `capability-tag`
- `evidence-example`

#### Required metadata on every artefact

- stable `id`
- `namespace`
- `version`
- `kind`
- `title`
- `summary`
- `tags`
- `domains`
- `languages`
- `platforms`
- `repoScopes`
- `dependencies`
- `conflicts`
- `source`
- `createdAt`
- `updatedAt`
- `provenance`
- `quality`
- `status`

#### Required provenance metadata

- imported from repo
- created by human
- created by Bosun synthesis
- derived from successful run
- derived from repeated fix cluster
- derived from postmortem or benchmark

#### Quality lifecycle

Every generated artefact should move through explicit states:

- `draft`
- `experimental`
- `verified`
- `trusted`
- `deprecated`
- `archived`

This matters because self-evolution without quality states becomes prompt spam.

### 2. Compiled index layer

The registry is not the runtime query surface. The runtime query surface must be a **compiled resolver index**.

#### Principle

Resolution must not depend on repeatedly opening and parsing every library file.

Instead, Bosun should compile library artefacts into indexed structures under a dedicated cache directory such as:

```
.bosun/
  library.json
  library-index/
    manifest-compiled.json
    inverted-index.json
    capability-graph.json
    resolver-features.json
    bundles.json
    quality-state.json
    source-snapshots/
```

#### Compiled structures

1. **Manifest-compiled**
   - normalized artefact metadata only
   - no large prompt or skill bodies unless explicitly needed

2. **Inverted index**
   - maps tokens to candidate artefacts
   - covers names, tags, domains, error signatures, frameworks, file patterns, and repo scopes

3. **Capability graph**
   - relationships between tasks, skills, tools, and agent profiles
   - supports composition rather than single-item matching

4. **Bundle index**
   - precomputed tool bundles, skill bundles, and prompt stacks
   - avoids rebuilding common combinations on every resolve

5. **Feature store**
   - compact numeric or categorical features used by the resolver ranker

6. **Quality and lineage index**
   - captures trust, freshness, promotion source, and failure history

#### Incremental invalidation

Any registry change must update only affected index shards.

- add skill -> update tokens, graph edges, quality index, and impacted bundles
- edit tool metadata -> update tool index and any affected bundles
- import new library source -> append namespace, then compile impacted shards only

This is the key to keeping performance flat while library size grows.

### 3. Resolver layer

The resolver should become a staged ranking pipeline, not a one-pass heuristic.

#### Resolver contract

Input:

- task title
- task description
- repo root
- changed files
- diff summary
- runtime mode
- user constraints
- cost and risk constraints
- language and framework hints
- failure traces
- prior attempts
- available tools and MCP servers

Output:

- best execution plan
- alternative plans
- explanation
- confidence
- auto-apply recommendation
- selected artefacts
- rejected artefacts with reasons

#### Resolver pipeline

##### Stage A: task normalization

Convert raw task input into normalized features:

- task intent
- work type: implementation, debugging, review, migration, infra, security, docs, voice, research
- repo and module scope
- language stack
- framework stack
- known error signatures
- file-path hints
- runtime constraints
- required or forbidden tools

##### Stage B: hard filtering

Remove impossible candidates early:

- wrong runtime mode
- wrong platform
- incompatible agent type
- required tools unavailable
- unsafe policy conflicts
- missing repo scope

##### Stage C: lexical retrieval

Use the compiled inverted index to retrieve candidate artefacts quickly.

This stage should produce bounded candidate pools such as:

- top 20 agent profiles
- top 50 skills
- top 20 prompts
- top 30 tool bundles

##### Stage D: structural retrieval

- if a task matches `vitest timeout`, bring related skills, tools, and prompts
- if a task matches `OAuth invalid_scope`, bring prior working recovery patterns
- if a task is `workflow resume crash`, bring reliability-specific plans and tool bundles

##### Stage E: semantic retrieval

Only after narrowing candidates, run semantic similarity or embedding ranking on the short list.

Important: semantic ranking should never be the first pass at this scale.

##### Stage F: execution-plan composition

Compose the best plan from the selected artefacts:

- primary agent profile
- prompt overlay stack
- mandatory skills
- optional situational skills
- tool bundle
- MCP bundle
- policy constraints

##### Stage G: policy and risk gating

Decide whether Bosun may auto-apply the plan.

Inputs should include:

- score
- confidence
- separation from runner-up
- cost estimate
- tool risk
- workspace safety rules
- whether similar plans succeeded before

##### Stage H: explanation

The resolver must always be able to answer:

- why this agent?
- why these skills?
- why these tools?
- why not the next-best alternative?

### 4. Execution-plan layer

The core abstraction should shift from **matched agent profile** to **resolved execution plan**.

#### Execution plan shape

```json
{
  "planId": "resolve-...",
  "agentProfileId": "swe-debugger",
  "promptStack": ["swe-core", "repo-conventions", "debugging-rigor"],
  "skillIds": ["vitest-timeout-triage", "windows-worktree-git-recovery"],
  "toolBundleId": "swe-debug-local",
  "mcpBundleId": "github-docs-minimal",
  "confidence": 0.93,
  "autoApply": false,
  "reasons": ["error-signature", "changed-path", "repo-scope", "prior-success-cluster"]
}
```

#### Why this matters

At large scale, a task is rarely solved by choosing one perfect agent. It is solved by choosing the right **combination** of:

- agent behavior
- knowledge
- tool access
- runtime policy

The plan object becomes the bridge between resolver intelligence and execution reliability.

### 5. Learning and publishing layer

This is the self-evolution engine.

#### What should be learned

Bosun should watch for patterns such as:

- repeated retries before success
- repeated failure signatures with eventual successful fix
- multi-step recovery sequences that later recur
- tool combinations that reliably solve a class of tasks
- repo-specific conventions repeatedly discovered during work

#### Learnable outputs

From these patterns, Bosun should synthesize candidate artefacts such as:

- new skills
- new resolver rules
- new tool bundles
- updated prompt overlays
- error-signature mappings
- domain-specific recovery playbooks

#### Promotion pipeline

1. **Capture**
   - collect task input, attempts, failures, final successful actions, and validation evidence

2. **Cluster**
   - detect similar solved incidents over time

3. **Synthesize**
   - produce a candidate skill or resolver rule draft

4. **Validate**
   - attach proof such as passing tests, command evidence, or repeated success count

5. **Review or gate**
   - optionally human-review before promotion to shared library

6. **Publish**
   - push to a shared repo such as `/virtengine/library`

7. **Track impact**
   - measure whether future tasks resolve faster or with fewer retries

#### Critical rule

Never publish raw reasoning traces as a skill.

The system should publish:

- normalized recovery pattern
- applicability conditions
- concise steps
- validation expectations
- provenance and confidence

That prevents the library from becoming a giant pile of low-signal transcripts.

## Shared library federation model

Bosun should support a federated library model.

### Namespace model

Examples:

- `virtengine/swe/vitest-timeout-triage`
- `virtengine/windows/worktree-git-recovery`
- `open-source/react/accessibility-reviewer`
- `team/security/oauth-invalid-scope-recovery`

### Import model

Long-term, imports should support:

- signed or attributable source manifests
- delta sync instead of full clone
- namespace version pinning
- trust policies by source
- selective import by category

### Import strategies by maturity

#### Phase 1

- keep git clone import for curated sources
- compile imported artefacts immediately into the local resolver index

#### Phase 2

- add manifest-first import
- fetch source metadata before content
- only download changed artefacts

#### Phase 3

- allow remote library feeds with signed snapshots and version ranges

## Performance strategy

### Hard requirements

At the target scale, Bosun should meet these runtime principles:

1. **No full-body skill loading during candidate retrieval**
2. **No full-registry scans for ordinary resolution**
3. **No repo-clone requirement on the hot path**
4. **No expensive semantic search before lexical narrowing**
5. **No synchronous rebuild of the full index for single-entry edits**

### Target latency model

For an ordinary SWE task resolve:

- task normalization: low milliseconds
- lexical and structural retrieval: low tens of milliseconds
- semantic rerank on short list: bounded
- final composition: low milliseconds

The exact numbers depend on machine and corpus size, but the architecture should keep runtime proportional to the **candidate set**, not the **library size**.

### Caching model

- warm resolver cache at startup
- shard cache by namespace and artefact kind
- keep a memory cache for hot metadata
- lazy-load large prompt and skill bodies only for selected plans
- cache compiled regex and token features

## Recommended code refactor

The current `infra/library-manager.mjs` is carrying too many responsibilities.

It should be split into focused modules.

### Recommended module split

- `infra/library-registry.mjs`
  - CRUD
  - manifest persistence
  - provenance and quality metadata

- `infra/library-index.mjs`
  - compiled index build
  - incremental invalidation
  - cache load and save

- `infra/library-resolver.mjs`
  - staged retrieval and ranking
  - execution-plan composition
  - explanation payloads

- `infra/library-importer.mjs`
  - source sync
  - namespace handling
  - version tracking

- `infra/library-learning.mjs`
  - successful-run capture
  - clustering
  - skill draft synthesis
  - promotion workflow

- `infra/library-bundles.mjs`
  - tool bundles
  - skill bundles
  - prompt stacks

### API evolution

Current endpoints should remain backward compatible, but Bosun should add:

- `POST /api/library/resolve`
- `POST /api/library/resolve/explain`
- `GET /api/library/index/status`
- `POST /api/library/index/rebuild`
- `POST /api/library/learn/capture`
- `POST /api/library/learn/promote`
- `GET /api/library/sources/:id/versions`

`/api/library/match-profile` should remain as a compatibility wrapper over the newer resolver.

### Runtime integration changes

- `agent/primary-agent.mjs`
- `workflow/workflow-nodes.mjs`
- `voice/voice-relay.mjs`
- `server/ui-server.mjs`
- `ui/tabs/library.js`

## Phased implementation plan

### Phase 0: benchmark and instrumentation

Before major refactors, add benchmark and telemetry coverage.

#### Deliverables

- synthetic library scale fixtures
  - 500 agents
  - 500 prompts
  - 5,000 skills
  - 5,000 tools and MCP entries
- resolver timing instrumentation
- p50, p95, p99 resolution metrics
- index build metrics
- memory usage metrics

#### Purpose

This creates a baseline so future architecture work is measured rather than guessed.

### Phase 1: compiled metadata index

#### Deliverables

- precompiled agent metadata cache
- no eager profile reads during ordinary resolution
- inverted token index
- compiled regex cache
- incremental index updates on upsert, import, and delete

#### Expected outcome

Resolver becomes effectively flat for hundreds of agents.

### Phase 2: execution-plan resolver

#### Deliverables

- new resolver API that returns full plans
- prompt, skill, tool, and MCP composition
- explanation payloads
- policy and risk gates

#### Expected outcome

Bosun chooses the best plan, not just the best agent.

### Phase 3: bundle system

#### Deliverables

- tool bundles
- skill bundles
- prompt stacks
- composition reuse for common task classes

#### Expected outcome

Selection quality improves while runtime cost stays bounded.

### Phase 4: learning pipeline

#### Deliverables

- capture solved-retry clusters
- synthesize skill drafts
- promotion workflow
- trust states and provenance

#### Expected outcome

Bosun gains continuous self-improvement without ungoverned prompt sprawl.

### Phase 5: shared-library federation

#### Deliverables

- namespaced external library model
- manifest-first sync
- delta import
- source trust policies
- version pinning

#### Expected outcome

Bosun can consume and publish large agent ecosystems cleanly.

## Resolver ranking principles

To avoid a brittle or opaque resolver, ranking should obey these rules:

1. **Fast filters first**
2. **Lexical retrieval before semantic retrieval**
3. **Capability composition over single-label matching**
4. **Explainability is mandatory**
5. **Auto-apply must remain threshold-gated**
6. **Prior success is a feature, not the only signal**
7. **Generated knowledge must compete on quality, not just recency**

## Testing strategy

### Correctness tests

- golden resolver fixtures for representative SWE tasks
- bundle composition tests
- policy gate tests
- provenance and promotion tests

### Scale tests

- synthetic large-library benchmarks
- cold-cache and warm-cache comparisons
- import and incremental-index benchmarks

### Regression tests

- existing `tests/library-manager.test.mjs` coverage remains
- add dedicated resolver benchmark and plan-composition suites
- maintain demo route parity if any API surface changes

## Recommended immediate next steps

These are the highest-leverage changes to make first.

1. Split current resolver code from registry code.
2. Add a compiled metadata index so resolution stops reading every agent profile file.
3. Introduce a new `resolve` API returning execution plans.
4. Add synthetic scale benchmarks for large libraries.
5. Add provenance and quality metadata to imported and generated artefacts.
6. Add a learning capture pipeline for successful retry loops.

## Opinionated conclusion

If the goal is a truly world-class, self-evolving Bosun library, the right architecture is **not**:

- a bigger list of profiles
- more regexes in a single file
- more ad hoc prompt imports

The right architecture is:

- a versioned artefact registry
- a compiled multi-index retrieval system
- a staged resolver that returns execution plans
- a governed learning pipeline that converts successful problem solving into reusable skills
- a federated shared-library model with provenance and trust

That is the path that scales to large agent ecosystems without turning the runtime into a slow, opaque mess.
