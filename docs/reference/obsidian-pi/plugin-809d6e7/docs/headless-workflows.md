# Headless pi Workflows — Examples & Recipes

> Phase 5 of obsidian-pi introduces **headless / note-triggered operations**: run pi
> one-shot prompts directly from your notes without opening the chat sidebar.
> This note demonstrates every trigger mechanism with practical, real-world examples.

See also: [[ROADMAP#Phase 5: Headless / Note-Triggered Operations (JSON mode)]]

---

## Trigger Mechanisms

There are **three ways** to trigger a headless pi run:

| Mechanism | How | Best for |
|---|---|---|
| **Frontmatter trigger** | Add `pi-trigger: "prompt"` to frontmatter → `Cmd+P` → "Run pi trigger" | Quick instructions about the current note |
| **`pi` codeblock** | Write a `` ```pi `` codeblock → click "▶ Run" in reading view | Structured prompts, reusable recipes |
| **One-shot modal** | `Cmd+P` → "Run pi one-shot prompt" | Ad-hoc prompts with `[[wikilink]]` and `/command` autocomplete |

All three run `pi --mode json --no-session` (ephemeral — no session saved).

---

## 1. Frontmatter Triggers

The simplest trigger. Add a `pi-trigger` field to your note's frontmatter. The **entire note content** is automatically included as context.

### Example: Summarize a meeting note

```markdown
---
pi-trigger: "Extract all action items, decisions, and follow-ups from this meeting. Format as a checklist."
---

# Design Review — 2026-06-18

## Attendees
Sarah, Tom, Lisa

## Discussion
- Sarah likes the new color scheme but is worried about contrast on dark backgrounds
- Tom raised performance concerns about the animation library
- Lisa needs to schedule an accessibility audit before launch
- We agreed to push the deadline by one week to accommodate testing

## Decisions
- Switch to a lighter accent color for accessibility
- Replace the animation library with CSS transitions
- New deadline: June 25
```

**How to run:** `Cmd+P` → "Run pi trigger (frontmatter)"

pi sees the full note content + your instruction. The result appears in a modal where you can append, replace, copy, or create a new note.

### Example: Generate a project brief from raw notes

```markdown
---
pi-trigger: "Turn these rough notes into a structured project brief with sections: Overview, Goals, Scope, Risks, and Timeline."
---

# Project: Vault Search Index

notes from call with team...
want full-text search across all markdown files
need fuzzy matching like VS Code
should index frontmatter fields separately
Lucene vs MiniSearch vs Lunr?
budget: 2 weeks
Sarah available frontend, Tom backend
```

---

## 2. `pi` Codeblocks — Plain Text

Write a `` ```pi `` codeblock with a plain-text prompt. In reading view, a **"▶ Run with pi"** button appears below the codeblock.

### Example: Weekly status report from daily notes

````markdown
# Weekly Status — Week of June 16

Read my daily notes from this week (June 16-20) and generate a status report.
Look for:
- Tasks marked with ✅ (completed)
- Tasks marked with 🔄 (in progress)
- Any blockers or notes about delays
- Key technical learnings

Format the report as:
## [Project Name]
- **Completed:** ...
- **In Progress:** ...
- **Blockers:** ...

Save your output — I'll review it before sending to the team.
````

### Example: Code review from a linked note

````markdown
Review the code in [[auth-module]] for:
1. Security vulnerabilities (injection, XSS, auth bypass)
2. Error handling gaps
3. Performance issues
4. Code style consistency

Provide specific line references and suggested fixes.
````

> **Wikilink resolution:** `[[auth-module]]` is automatically resolved to the
> absolute vault path before sending to pi. Since pi runs with `cwd = vault root`,
> it can read the file directly with its `read` tool.

---

## 3. `pi` Codeblocks — JSON (with options)

Use JSON when you need to override the model or include the note content.

### Example: Use a specific model + include the note

````markdown
# Research Note: Vector Databases

I want to compare pgvector, Qdrant, and Weaviate for our use case.
We need: hybrid search, million-scale vectors, Docker deployment, Rust or Go.

```pi
{
  "prompt": "Compare the three databases I described above. Create a decision matrix table and recommend one.",
  "model": "claude-sonnet-4-5",
  "includeNote": true
}
```
````

| JSON Field | Type | Description |
|---|---|---|
| `prompt` | string | **Required.** The prompt to send to pi. |
| `model` | string | Override the default model (e.g. `"claude-sonnet-4-5"`). |
| `includeNote` | boolean | When `true`, prepends the full note content as context. |

### Example: Quick translation (different model)

````markdown
# Meeting Notes — Q2 Planning

[meeting notes in English...]

```pi
{
  "prompt": "Translate the note above into Spanish, preserving all markdown formatting and wikilinks.",
  "includeNote": true,
  "model": "claude-haiku-4-5"
}
```
````

---

## 4. One-Shot Modal (with autocomplete)

`Cmd+P` → "Run pi one-shot prompt" opens a modal with a textarea that supports:

- **`[[` → wikilink autocomplete** (files, headings via `#`, block IDs via `^`)
- **`/` → slash command autocomplete** (extensions, prompts, skills)
- **Enter** runs the prompt (Shift+Enter for newline)

### Example: Research a linked note

```
Summarize [[ARCHITECTURE]] and suggest 3 improvements based on best practices for Obsidian plugin development.
```

### Example: Invoke a skill

```
/skill:brave-search latest developments in vector database benchmarks 2026
```

---

## 5. Writing Results Back

After pi completes, a result modal opens with the assistant's output. You can:

| Button | What it does |
|---|---|
| **Write below codeblock** | Inserts a `` ```pi-result `` block under the source codeblock (idempotent — replaces if one exists) |
| **Append to note** | Appends to the note you were last editing |
| **Replace selection** | Replaces the current selection in the last editor |
| **New note** | Creates a new note with the result |
| **Copy** | Copies to clipboard |

> **Idempotency:** "Write below codeblock" checks for an existing `pi-result`
> block below the source. If found, it replaces it instead of duplicating.
> Re-running the same codeblock always produces one result block, not many.

---

## Practical Recipes

### Recipe: Meeting Notes → Action Items

````markdown
---
pi-trigger: "Extract every action item, decision, and follow-up from these meeting notes. Format as a markdown checklist with @assignees where mentioned. Group by category (Action Items, Decisions, Follow-ups)."
---

# Sprint Retro — June 18

## What went well
- Shipped the search feature ahead of schedule
- CI pipeline is 40% faster after caching improvements

## What didn't
- @Tom blocked on API rate limits all week
- Design review took 3 days longer than planned
- @Sarah couldn't test dark mode — no staging env

## Action items discussed
- Tom to file a ticket with the API provider about rate limits
- Need to set up a staging environment by end of next week
- Schedule a design review template meeting
````

### Recipe: Daily Note → Evening Summary

````markdown
# 2026-06-18

## Tasks
- [x] Fixed authentication bug in login flow
- [x] Wrote unit tests for password reset
- [ ] Review PR #142
- [ ] Update documentation for new API endpoints

## Notes
- Learned that JWT refresh tokens should be short-lived (15 min max)
- Discovered the `httpOnly` cookie flag prevents XSS token theft
- Coffee count: 4

## Random thoughts
- Should we switch to OAuth2 for the mobile app?
- The meeting at 2pm ran long — need better timeboxing

```pi
{
  "prompt": "Create a concise evening summary of today's note. Include: what I accomplished, what I learned, what's pending, and one thing to focus on tomorrow.",
  "includeNote": true
}
```
````

### Recipe: Research Note Generation

````markdown
# Research: Edge Computing for IoT

I'm evaluating edge computing platforms for our IoT fleet (5000+ devices).
Key requirements: low latency (<50ms), offline capability, MQTT support,
Kubernetes-native, and support for model inference on edge nodes.

```pi
Research edge computing platforms that meet these requirements. Compare:
1. AWS IoT Greengrass
2. Azure IoT Edge
3. KubeEdge
4. Akri

Create a comparison table with columns: Platform, Latency, Offline Support,
MQTT, K8s Native, Model Inference, License, and Notes.
End with a recommendation and rationale.
```
````

### Recipe: Book Notes → Flashcards

````markdown
# Atomic Habits — Reading Notes

## Chapter 2: How Habits Shape Identity
- Focus on who you want to become, not what you want to achieve
- "Every action is a vote for the type of person you wish to become"
- Identity-based habits are more durable than outcome-based habits

## Chapter 3: The 4 Laws of Behavior Change
1. Make it obvious (cue)
2. Make it attractive (craving)
3. Make it easy (response)
4. Make it satisfying (reward)

```pi
{
  "prompt": "Generate 10 Anki-style flashcards from these reading notes. Each card should have a question and a concise answer. Focus on the key concepts and quotable insights. Format as a markdown table with Question and Answer columns.",
  "includeNote": true
}
```
````

### Recipe: Code Documentation Generator

````markdown
# API Documentation Needed

```pi
Read the file at [[api-routes]] and generate comprehensive API documentation in markdown.
Include for each endpoint:
- HTTP method and path
- Description
- Request parameters (query, body, headers)
- Response schema with examples
- Error codes
- Authentication requirements

Format as a clean reference document.
```
````

### Recipe: Project Status from Linked Notes

````markdown
# Q2 Project Status

This note links to all my project sub-notes. Generate a consolidated status report.

```pi
Read the following notes and create a Q2 project status report:
- [[project-alpha]]
- [[project-beta]]
- [[project-gamma]]

For each project, summarize: current status, completion percentage estimate,
key milestones reached, blockers, and next steps. Add an executive summary at the top.
```
````

### Recipe: Content Rewriting / Humanizing

````markdown
# Blog Draft: Why I Switched to Obsidian

[Draft content here — a bit rough, needs polishing]

```pi
{
  "prompt": "Rewrite this blog post to be more engaging and conversational. Keep my voice and opinions, but tighten the prose, cut unnecessary words, add transitions between sections, and make the opening hook stronger. Preserve all markdown formatting.",
  "includeNote": true
}
```
````

### Recipe: Extract Key Terms from a Technical Note

````markdown
# Kubernetes Networking Deep Dive

[Long technical note about Services, Ingress, NetworkPolicies, CNI plugins, etc.]

```pi
{
  "prompt": "Extract every domain-specific term, proper noun, and acronym from this note. Create a glossary table with columns: Term, Type (Concept/Tool/Protocol/Acronym), Definition (in the context of this note), and First Mention (heading where it appears). Sort alphabetically.",
  "includeNote": true
}
```
````

### Recipe: Weekly Review from Daily Notes

````markdown
# Weekly Review — Week of June 16

```pi
Read my daily notes from this week. They are in the "Daily Notes" folder with filenames like 2026-06-16.md, 2026-06-17.md, etc.

Analyze and generate a weekly review with:
1. **Accomplishments** — what got done (✅ items)
2. **In Progress** — what's still active (🔄 items)
3. **Patterns** — productivity observations (best times of day, what derailed plans)
4. **Learnings** — key technical or personal insights
5. **Next Week Focus** — top 3 priorities

Be honest and specific. Reference the actual notes where relevant.
```
````

---

## Tips & Patterns

### Start small
Don't automate everything at once. Pick one recurring task (like meeting note extraction) and build a codeblock recipe for it. Once it works reliably, expand.

### Use `includeNote: true` for note-specific tasks
When the prompt is about the note's own content (summarize, translate, extract), use `includeNote: true` so pi sees the full note. For prompts that reference other files (read `[[link]]`), don't include the note — pi will read the linked files with its `read` tool.

### Chain with "Write below codeblock"
Results written as `` ```pi-result `` blocks stay with the source. This makes it easy to:
- Re-run and see updated results
- Keep a history of what pi produced
- Share notes with embedded AI output

### Use different models for different tasks
- **Haiku** for quick tasks (summarize, extract, translate) — fast and cheap
- **Sonnet** for analysis, comparison, code review — balanced
- **Opus** for deep research, complex reasoning — best quality

```pi
{"prompt": "...", "model": "claude-haiku-4-5"}
```

### Wikilinks resolve to absolute paths
When you write `[[ROADMAP]]` in a prompt, it's resolved to the full vault path before pi receives it. Since pi's `cwd` is the vault root, it can read the file directly. You don't need to paste file contents — just link.

### One-shot modal for exploration
Use `Cmd+P` → "Run pi one-shot prompt" when you want to ask a quick question without creating a permanent codeblock. The modal supports `[[` and `/` autocomplete just like the chat input.

---

## Commands Reference

| Command | What it does |
|---|---|
| **Run pi trigger (frontmatter)** | Runs the `pi-trigger` from the active note's frontmatter |
| **Run pi codeblock in active note** | Finds and runs the first `` ```pi `` codeblock |
| **Run pi one-shot prompt** | Opens a modal to type an ad-hoc prompt (with autocomplete) |

In reading view, `` ```pi `` codeblocks show a "▶ Run with pi" button inline.