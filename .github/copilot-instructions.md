<!-- SPECKIT START -->
Active plan for the feature on this branch:

- Plan: [specs/002-babylon-perf-stage-timings/plan.md](../specs/002-babylon-perf-stage-timings/plan.md)
- Spec: [specs/002-babylon-perf-stage-timings/spec.md](../specs/002-babylon-perf-stage-timings/spec.md)
- Research: [specs/002-babylon-perf-stage-timings/research.md](../specs/002-babylon-perf-stage-timings/research.md)
- Data model: [specs/002-babylon-perf-stage-timings/data-model.md](../specs/002-babylon-perf-stage-timings/data-model.md)
- UI + engine contract: [specs/002-babylon-perf-stage-timings/contracts/stage-breakdown.md](../specs/002-babylon-perf-stage-timings/contracts/stage-breakdown.md)
- Quickstart: [specs/002-babylon-perf-stage-timings/quickstart.md](../specs/002-babylon-perf-stage-timings/quickstart.md)

Constitution: [.specify/memory/constitution.md](../.specify/memory/constitution.md)
(v1.3.0). Key gates for this feature: Principle III (Display-Seam Isolation —
`src/engine/types.ts` may widen its own public contract with the optional
`stages?` field, but no Cornerstone/React imports under `src/engine/`);
Principle IV (exactly one `readPixels()` per `run()` preserved — stage
boundaries are observation-only); Protected Branches (PRs target `bruno`,
never main/master/develop).
<!-- SPECKIT END -->
