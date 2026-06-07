---
name: improve-system-agents
description: "Improve system agent instructions or instruction block definitions using prompt engineering best practices. Rewrites the target markdown file with better structure, clarity, and effectiveness."
context: main
model: opus
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion, WebSearch]
argument-hint: "<agent-or-block-id> [improvement request]"
disable-model-invocation: false
---

# Improve System Agents

Rewrites a system agent or instruction block definition using prompt engineering best practices. Performs live research, rewrites with a subagent, and runs a self-review pass before presenting the result for approval.

## When to use

- A system agent is producing poor output or making wrong tool choices
- An instruction block is too vague, too long, or structurally weak
- You want to apply prompt engineering best practices to an existing definition
- You have a specific improvement in mind and want it applied cleanly

## When NOT to use

- To add entirely new agents or blocks (create the file manually first)
- To change frontmatter metadata (id, name, tools — edit those directly)
- For code changes unrelated to agent instructions

---

## How System Agents Work (Architecture Context)

Understanding this architecture is critical for writing effective rewrites. The system agent markdown body is **not the complete system prompt** — it is one layer in a multi-layer assembly.

### System Prompt Assembly (runtime)

The final system prompt sent to the LLM is assembled by concatenating these blocks in order:

1. **Agent markdown body** — the `instructions` from the `.md` file (re-read live each invocation, enabling hot-reload)
2. **Instruction block content** — from any connected Instruction nodes in the graph (wrapped in `<instruction_block>` tags)
3. **Tool group instructions** — from connected Tool node groups (wrapped in `<tool_group_instructions>` tags)
4. **Individual tool instructions** — each tool's `__instructions` field with detailed usage guidance (wrapped in `<tool_description>` tags)
5. **MCP instructions** — from connected MCP services (wrapped in `<mcp_instructions>` tags)

### What this means for the markdown body

- **Do NOT describe individual tools.** Tool descriptions, usage guidance, and disambiguation are injected automatically from each tool's own definition. Writing "use shell-tool to run commands" or "use files-tool to read files" in the markdown body is redundant.
- **DO write cross-tool orchestration guidance.** The injected tool descriptions don't know about each other. If tool sequencing matters (e.g., "always read a file before editing it", "run tests after making changes"), that belongs in the markdown body.
- **DO write behavioral constraints and quality standards.** Anti-patterns, code quality rules, verification discipline, git workflow — these shape how the agent uses tools, not what the tools do.
- **Team context comes from the communication tool.** If a communication tool is connected, the agent already knows about other agents in the flow. No need to hardcode team member names.
- **Agents must be independent.** Never write instructions that assume a specific external workflow or the presence of other agents (e.g., "when you receive an architect spec", "handle reviewer feedback"). Each agent definition must work standalone. If the agent happens to receive input from another agent at runtime, it should handle it generically (e.g., "if you receive a specification, treat it as authoritative") — not reference specific roles or workflow steps.
- **Repository context is discovered at runtime.** The agent learns about the repo (language, package manager, conventions) by reading the `agentInstructions` field from `gh_clone`. This cannot be templated in advance.

### Frontmatter fields

```yaml
---
id: engineer              # Unique identifier
name: Engineer            # Display name
description: ...          # Short description for UI/registry
tools:                    # Tool template IDs — auto-instantiated with defaults
  - shell-tool
  - files-tool
defaultModel: null        # Optional model override
---
```

Tools listed in `tools:` are automatically instantiated and their instructions injected. Users can also manually connect additional tools via the graph editor, which override predefined tools of the same template ID.

#### Tool grants vs. the body — check on every rewrite (but FLAG, don't silently edit frontmatter)

This skill rewrites the **body**, not the frontmatter (see "When NOT to use"). But you must still read the frontmatter and surface mismatches for a human to resolve:

- **Read-only is prompt-enforced, not grant-enforced.** `files-tool` always includes edit actions; `shell-tool` can mutate. If the body claims the agent is "read-only" / does "no technical work", the frontmatter *should* pin the grant to match where a flag exists — `files-tool|{"includeEditActions":false}`, `gh-tool|{"readOnly":true}` — and drop `shell-tool` unless the body gives it explicit read-only orchestration. Where a write grant is genuinely needed (an implementation coordinator running verification or applying small registration edits), it should stay, with a one-clause self-aware note in the body that the restraint is prompt-enforced. Never reword a read-only claim away just because the grant is write-capable — flag the grant instead.
- **Grants must match body dependencies.** Every capability the body invokes must be in `tools:` or be a core tool (`finish`, `wait_for`). If the body relies on a tool that is neither (e.g. references the clone / `agentInstructions` flow without `gh-tool`, or coordinates a team of agents without `agent-communication-tool`), that is a grant-vs-body mismatch. Surface it — never silently delete behavior the body depends on to "resolve" it.

### Tool Catalog (all available tool template IDs)

Each tool template injects its own description and usage guidance at runtime. The markdown body should **never** describe what a tool does — but it **should** include cross-tool orchestration patterns relevant to the agent's connected tools.

Below is the complete catalog. When rewriting, check the agent's `tools:` field in frontmatter to determine which orchestration patterns are relevant.

#### Core tools (always available, not listed in frontmatter)

| Template ID | Purpose | Cross-tool orchestration implications |
|---|---|---|
| `finish` | Signal work completion or request missing info | Must be called to end every turn. All output goes in the `message` field. Never call alongside other tools — always in its own turn. |
| `wait_for` | Schedule delayed thread resumption | Use when waiting on async external processes (CI pipelines, deployments, PR reviews). Call instead of polling in a loop. |

#### Connectable tools (listed in frontmatter `tools:` or connected via graph editor)

| Template ID | Purpose | Cross-tool orchestration implications |
|---|---|---|
| `files-tool` | File read/search/edit operations | **Read before editing** — never modify a file not read in this session. Use semantic codebase search as the preferred first exploration step. Batch independent reads in parallel. For large files, read specific line ranges rather than the full file. |
| `shell-tool` | Execute shell commands in sandbox | Run install/build/test/lint commands from the repository's instruction file. Use for verification after code changes. Prefer project scripts over ad-hoc commands. |
| `gh-tool` | GitHub operations (clone, branch, commit, push, PR) | Sequential dependency chain: clone → branch → implement → commit → push → PR. **Push must complete before PR creation** — never parallelize these two. Read the `agentInstructions` field from clone output for repo conventions. |
| `knowledge-tools` | Knowledge base search and retrieval | Search the knowledge base **before** starting non-trivial work (code changes, research, design). Follow the pattern: search docs → search chunks → get specific chunks. Skip for simple questions that don't need project context. Don't re-search within the same conversation unless the topic changed significantly. |
| `subagents-tool` | Spawn autonomous subagents | Delegate research-heavy tasks to save main context window. **Always parallelize independent subagent calls** — never chain them sequentially when they don't depend on each other. **Four tiers** (verified in `apps/api/src/v1/subagents/subagent-definitions.ts`): `system:explorer` (read-only, small/fast model — default for research), `system:smart-explorer` (read-only, parent/large model — deep review, audits, validating findings), `system:simple` (full access, small model, 70k-token context — small mechanical edits), `system:smart` (full access, parent/large model — complex changes). Read-only tiers = explorer + smart-explorer; write-capable = simple + smart. Give subagents maximum context — they start with a blank window. |
| `agent-communication-tool` | Send messages to connected agents | Trust agent responses — **do not re-explore files** they already analyzed. If the response includes an `exploredFiles` list, skip reading those files. If details are missing, ask the same agent again rather than re-investigating yourself. |
| `web-search-tool` | Web search for current information | Use to research best practices, verify API documentation, or find solutions for unfamiliar technologies. Search before making assumptions about external APIs or libraries. |

#### How to use the catalog during rewrites

1. Read the agent's `tools:` field from frontmatter to identify connected tools.
2. For each connected tool, check the "Cross-tool orchestration implications" column above.
3. Include relevant orchestration guidance in the rewritten body — but phrase it as behavioral guidance (e.g., "always read a file before editing it"), not as tool descriptions (e.g., "use files_read to read files").
4. The core tools (`finish`, `wait_for`) apply to every agent — include their orchestration patterns when they affect workflow (e.g., "deliver all output through the completion tool, not in intermediate messages").
5. **Do NOT name specific tool functions** (e.g., `files_read`, `codebase_search`, `gh_clone`) in the agent body — those names are injected by the tools themselves. Use generic references: "read the file", "search the codebase", "clone the repository".

---

## Process

### Phase 1: Target Resolution

Parse `$ARGUMENTS`:
- First word = target id (e.g. `architect`, `js-agent`)
- Remaining words = the user's improvement request (may be empty)

Glob both directories to find candidate files:
- `apps/api/system-agents/*.md`
- `apps/api/instruction-blocks/*.md`

Read each file and match by the `id:` field in frontmatter. Record:
- `target_path` — absolute path to the matched file
- `file_type` — `system-agent` or `instruction-block` (based on directory)
- `improvement_request` — the user's words after the id (may be empty)

**If no arguments provided:**
List all available ids from both directories and ask via `AskUserQuestion`:
```
Which agent or instruction block do you want to improve?

Available system agents: architect, engineer, reviewer
Available instruction blocks: js-agent

Enter the id and optionally describe what to improve (e.g. "architect add better tool sequencing guidance")
```

**If no match found:**
Show the available ids and ask the user to try again via `AskUserQuestion`.

Read the full content of the matched file and store it as `original_content`.

---

### Phase 2: Live Research

Use WebSearch to find domain-specific best practices for the agent's role. Construct the search query from the agent's name and role, for example:

- `architect` agent → search `"software architecture agent system prompt best practices"`
- `engineer` agent → search `"software engineering AI agent instructions prompt engineering"`
- `js-agent` block → search `"JavaScript TypeScript AI coding agent instructions best practices"`

Extract 3-5 concrete, actionable insights from the search results. These supplement the embedded best practices below and make the rewrite domain-aware.

---

### Phase 3: Rewrite

Spawn a rewrite subagent (model=sonnet):

```
Agent(prompt="""
You are a prompt engineer specializing in system prompt design for LLM-powered agents.

CRITICAL: You are a RESEARCH-ONLY agent. Do NOT use Write, Edit, or any file-writing tools. Do NOT create or modify any files. Your ONLY output is the rewritten file content as plain text in your response. If you write to any file, you will overwrite unrelated files and cause damage.

Your task: rewrite the BODY of the following agent definition file to make it clearer, more structured, and more effective. Preserve the frontmatter exactly as-is.

=== ORIGINAL FILE ===
{original_content}

=== FILE TYPE ===
{file_type}
(system-agent = full system prompt for a LangGraph agent running in a sandboxed environment
 instruction-block = supplementary domain instructions appended to an agent's system prompt)

=== SYSTEM PROMPT ASSEMBLY (how the final prompt is built) ===
The agent markdown body is NOT the complete system prompt. At runtime, the final prompt is assembled by concatenating:
1. The markdown body (what you are rewriting)
2. Instruction block content from connected Instruction nodes
3. Tool group instructions from connected Tool nodes
4. Individual tool instructions — each tool's detailed usage guidance (auto-injected)
5. MCP service instructions

CRITICAL IMPLICATIONS:
- Do NOT describe what individual tools do or when to use them. Each tool injects its own description and usage guidance automatically. Writing "use shell-tool to run commands" is redundant.
- DO write cross-tool orchestration logic (sequencing, verification workflows) — the injected tool descriptions don't know about each other.
- DO write behavioral constraints, quality standards, and work approach — these shape HOW the agent works, not WHAT tools it has.
- Repository-specific context (language, package manager, commands) is discovered at runtime via `agentInstructions` from `gh_clone` — never hardcode these.
- Team context (other agents in the flow) comes from the communication tool if connected — never hardcode agent names.
- INDEPENDENCE RULE: Never write instructions that assume a specific external workflow or the presence of other agents. No "when you receive an architect spec", no "handle reviewer feedback", no "delegate to subagents". Each agent must work standalone. If it receives structured input from another agent at runtime, handle it generically ("if you receive a specification, treat it as authoritative") without naming specific roles.

=== AGENT'S CONNECTED TOOLS ===
The agent's frontmatter lists these tool template IDs: {tools_from_frontmatter}
Core tools (finish, wait_for) are always available regardless of frontmatter.

For each connected tool, include relevant CROSS-TOOL ORCHESTRATION guidance in the rewritten body. Use the catalog below to determine what patterns matter. Phrase guidance as behavioral rules ("read a file before editing it"), NOT as tool descriptions ("use files_read to read files"). Never name specific tool functions — those are injected automatically.

TOOL ORCHESTRATION CATALOG:
- files-tool: Read before editing (never modify unread files). Prefer semantic search for initial exploration. Batch independent reads. Use line ranges for large files.
- shell-tool: Run install/build/test/lint from the repository's instruction file. Use for verification after code changes. Prefer project scripts over ad-hoc commands.
- gh-tool: Clone → branch → implement → commit → push → PR (sequential chain). Push must complete before PR creation. Read agentInstructions from clone output for repo conventions.
- knowledge-tools: Search knowledge base BEFORE starting non-trivial work. Pattern: search docs → search chunks → get chunks. Skip for simple questions. Don't re-search same topic within a conversation.
- subagents-tool: Delegate research to save context. ALWAYS parallelize independent subagent calls. FOUR tiers — system:explorer (read-only, small/fast model), system:smart-explorer (read-only, parent/large model — deep review/validation), system:simple (full access, small model, 70k ctx), system:smart (full access, parent/large model). Read-only = explorer + smart-explorer; write-capable = simple + smart. system:smart-explorer IS a valid tier — never "correct" it away. Give subagents maximum context — they start blank.
- agent-communication-tool: Trust agent responses — don't re-explore files they analyzed. If response includes exploredFiles, skip reading those. Ask the same agent again if details are missing.
- web-search-tool: Research best practices and verify API docs before making assumptions about external technologies.
- finish (core): All output goes in the completion message — not in intermediate messages. Call once when done, never alongside other tools.
- wait_for (core): Use for async waits (CI, deployments, PR reviews) instead of polling loops.

=== USER'S IMPROVEMENT REQUEST ===
{improvement_request or "(none — apply general best practices)"}

=== LIVE RESEARCH INSIGHTS ===
{live_research_results}

=== EMBEDDED BEST PRACTICES ===

**Structure Principles**
- Use a clear section hierarchy: Identity/Role → Goal/Objective → Approach → Behavioral Constraints → Output Format
- Use markdown headings (##) to create navigable structure — flat prose walls are an anti-pattern
- Front-load the most critical instructions — models pay more attention to content near the start
- Group related rules under descriptive headings — scattered rules get lost

**Role & Identity**
- Define a specific, actionable role — not just "be helpful" but "You are a senior code reviewer specializing in..."
- Include a goal statement that explains WHAT the agent should accomplish
- Add contextual backstory/motivation that shapes HOW the agent approaches tasks

**Cross-Tool Orchestration (what belongs in the markdown body)**
- Sequencing guidance when tool order matters ("read before editing", "test after implementing")
- Verification workflows that span multiple tools
- Fallback strategies when a tool fails
- Do NOT describe individual tool capabilities — those are auto-injected
- Use the TOOL ORCHESTRATION CATALOG above to determine which patterns apply based on the agent's connected tools
- Phrase orchestration as behavioral guidance ("always read a file before editing it"), never as tool usage instructions ("use files_read before files_apply_changes")

**Constraints & Rules**
- Prefer affirmative rules ("Always do X") over prohibitive ("Never do Y") — but use both
- Prioritize constraints: state which wins when rules conflict
- Add brief justification for each constraint ("why" improves adherence)
- Make constraints testable — if you can't verify compliance, the rule is too vague
- Group constraints by topic, not randomly scattered

**The Goldilocks Principle**
- Too specific/brittle: enumerating every edge case overstuffs context and breaks on unlisted scenarios
- Too vague: "be helpful and accurate" gives no actionable signal
- Sweet spot: strong heuristics + diverse canonical examples, not exhaustive rule lists

**Anti-Patterns to Eliminate**
- Vague role definitions ("be helpful", "assist the user")
- Flat prose walls without structure
- Contradictory rules without priority
- Hardcoded repo-specific details (commands, filenames, paths)
- Redundant tool descriptions that duplicate auto-injected tool guidance
- No examples or demonstrations of correct behavior
- Laundry-list edge cases instead of general heuristics
- Workflow-specific assumptions about other agents (see Independence Rule below)

**Independence Rule (CRITICAL)**
- Every agent and instruction block must work as a standalone unit — never assume a specific external workflow or the presence of other agents.
- Never write instructions like "when you receive an architect spec", "handle reviewer feedback", "delegate to subagents", or "report to the engineering manager". These couple the agent to a specific graph topology that may not exist.
- If the agent might receive structured input from another agent, handle it generically: "if you receive a specification or detailed plan, treat it as authoritative" — not "when the architect sends you a spec".
- Never hardcode agent role names (architect, reviewer, manager, explorer) in the instructions.
- The agent's behavior should be complete and useful even if it is the only agent in the graph.

**For System Agents Specifically**
- Instructions become the system prompt for a LangGraph agent in a sandboxed Docker environment
- Instructions must be GENERIC — not repo-specific — since they run against various user repos
- Instructions must be INDEPENDENT — must not assume specific workflows or other agents exist
- Tool descriptions are injected separately at runtime — the markdown body focuses on role, approach, and constraints
- Reference "the repository's instruction file" or "the agentInstructions field from gh_clone" rather than specific filenames (CLAUDE.md) or commands (pnpm run full-check)
- Subagent tiers: the four real tiers are system:explorer and system:smart-explorer (read-only) and system:simple and system:smart (write-capable). system:smart-explorer IS valid — never treat it as an error or "correct" it away. Never invent a tier name that is not one of these four.
- Read-only is prompt-enforced, not grant-enforced. You edit only the BODY, so if a "read-only" claim sits next to a write-capable grant, keep the claim and leave a note that the discipline is the agent's to keep — do NOT reword the read-only claim away, and do NOT touch the frontmatter (flag grant issues for the human instead).

**For Instruction Blocks Specifically**
- These are supplementary instruction sets appended to an agent's system prompt
- Keep them focused on a specific domain/technology
- They must be complementary (not contradictory) to the base agent instructions
- They must not introduce workflow-specific assumptions that don't exist in the base agent
- Make them actionable and concrete — not vague best practices

=== YOUR OUTPUT ===
Return the COMPLETE rewritten file — frontmatter (unchanged) followed by the rewritten body.
Do NOT include commentary or explanation. Return ONLY the file content as plain text in your response.
Do NOT write to any files. Do NOT use Write, Edit, or Bash tools. Output text only.
""")
```

Store the result as `rewritten_content`.

---

### Phase 4: Self-Review

Spawn a reviewer subagent (model=sonnet) to evaluate the rewrite:

```
Agent(prompt="""
You are a prompt engineering reviewer. Evaluate the rewritten agent definition below against the original and the checklist.

=== ORIGINAL ===
{original_content}

=== REWRITTEN ===
{rewritten_content}

=== CHECKLIST ===
1. Clear role/identity definition (not vague, not just "be helpful")
2. Structured with markdown headings (not a flat prose wall)
3. Goal/objective stated explicitly
4. No redundant tool descriptions (tools self-describe via auto-injection)
5. Cross-tool orchestration guidance present for the agent's connected tools (check frontmatter `tools:` field) — sequencing, parallelization, verification patterns
6. Constraints are prioritized and include brief justifications
7. No anti-patterns: vague roles, contradictions, hardcoded repo-specific content
8. Appropriate altitude — strong heuristics, not exhaustive edge cases or empty platitudes
9. User's specific request addressed: {improvement_request or "(none)"}
10. For system agents: no repo-specific commands, filenames, or paths
11. INDEPENDENCE: no references to specific agent roles (architect, reviewer, manager), no workflow-specific sections (architect spec handling, reviewer feedback, subagent delegation), no assumptions about other agents existing in the graph. The agent must work standalone.
12. Subagent tiers named in the body are valid — only `system:explorer`, `system:smart-explorer` (read-only), `system:simple`, `system:smart` (write-capable). `system:smart-explorer` is valid; flag any other tier name and never remove `smart-explorer` as if it were an error.
13. Grant-vs-body consistency surfaced (not silently mutated): any capability the body relies on that is not in frontmatter `tools:` or a core tool (`finish`/`wait_for`) is flagged, and any "read-only" claim sitting next to a write-capable grant is flagged. Read-only is prompt-enforced, not grant-enforced.
14. Overall quality strictly better than the original

=== YOUR OUTPUT ===
Verdict: PASS or REVISE

If PASS: write only "PASS" followed by a 1-2 sentence summary of key improvements made.
If REVISE: write "REVISE" followed by a numbered list of specific issues that must be fixed. Be concrete — point to exact problems, not general advice.
""")
```

Parse the reviewer verdict:
- **PASS** — proceed to Phase 5
- **REVISE** — spawn the rewrite subagent again, appending the reviewer's issues to the prompt under a `=== REVIEWER FEEDBACK ===` section. Then proceed to Phase 5 with the revised output. (Max 1 revision loop — do not loop indefinitely.)

---

### Phase 5: Diff Presentation

Show the user the full rewritten file content so they can read and evaluate it:

```
=== REWRITTEN FILE CONTENT ===

{rewritten_content}
```

Then ask via `AskUserQuestion`:

```
The rewrite is ready. What would you like to do?

A) Apply — save the rewritten file to {target_path}
B) Adjust — describe what to change and I'll revise
C) Reject — discard changes
```

**If "Adjust"**: ask the user what to change, then loop back to Phase 3 with the additional feedback appended as `=== USER ADJUSTMENT REQUEST ===`. Skip Phase 4 on adjustment loops.

**If "Reject"**: confirm discarded and end.

---

### Phase 6: Apply

Write the rewritten content to `target_path` using the Write tool.

Confirm to the user:

```
Done. Updated: {target_path}

The file has been rewritten in place. No git operations were performed.
```

---

## Example invocations

```
/improve-system-agents architect
/improve-system-agents engineer add clearer tool sequencing guidance
/improve-system-agents js-agent the constraints section is too vague
/improve-system-agents reviewer make the role definition more specific
```
