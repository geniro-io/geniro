# Custom Instructions

Project-specific rules and steps that apply to core geniro skills (implement, plan, review, refactor, debug, follow-up). Edit this file to customize how skills behave in your project. Skills read this file at the start of each run.

## Rules

Add project-specific rules that all skills should follow. Each rule should be a single, clear constraint.

- For any change that touches cost accounting, pricing aggregation, or numeric display flows (thread usage stats, subagent footers, header cost widgets, analytics rollups), read `.claude/rules/cost-accounting.md` FIRST and present the required test matrix before writing code. User has requested "solid tests both frontend and backend sides to cover all cases" across two consecutive debug rounds (2026-04-20, 2026-04-21) — this is a durable requirement, not a per-task ask.
- When removing a reconciliation/fallback (`Math.max`, `?? 0`, etc.), write the replacement single-source-of-truth policy as a docstring on the function BEFORE deleting the reconciliation. The reviewer checks for the policy, not just the absence of the workaround.

## Additional Steps

Add custom steps that skills should execute at specific points. Use the phase names from each skill (e.g., "After implementation", "Before shipping", "After review").

### After implementation
<!-- Steps to run after code changes are applied (implement Phase 4, follow-up Phase 4) -->

### Before shipping
<!-- Steps to run before committing/pushing (implement Phase 7, follow-up Phase 6) -->

### After review
<!-- Steps to run after code review completes (review Phase 4) -->

## Constraints

Add hard limits that skills must respect.

Examples (replace with your own):
- Maximum PR size: 500 lines changed
- Always include tests for new public functions
- Database migrations must be backwards-compatible
