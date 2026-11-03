# pi-architect design

pi-architect adds an architecture mode to Pi. You use it to design one feature before anyone builds it.
The agent moves through five phases and shows each one visually. You approve every phase before the agent moves on.
The result is a plan file that another agent can build from without any other context.

## Goals

- **The user decides.** The agent proposes. The user approves, picks or asks for changes at every gate.
- **Visual, not chatty.** Each phase has its own screen. The user sees the design, not walls of text.
- **The model sends data, the extension draws it.** The model never draws ASCII art. It sends structured JSON and the extension renders it with Pi's theme.
- **Few tokens.** Rendered cards live in session entries that the model never sees.
- **A plan another agent can build.** The plan file holds every decision, the reasons and a way to verify each slice.

## Scope of a session

One feature per session. `/architect <feature>` starts it. The session ends when the user approves the Blueprint or runs `/architect abort`.

## Phases

The agent moves through the phases in order. It cannot skip one.

| Phase       | What the agent does                                      | Review screen shows                                                       | The user approves            |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| **Frame**   | Writes the goal, constraints, out of scope and done-when | A brief card                                                              | The scope                    |
| **Explore** | Reads the code without changing it                       | A module map with the touched parts highlighted, and key findings         | That the agent understood it |
| **Decide**  | Raises each open question as a decision                  | One decision card per question                                            | Each choice                  |
| **Design**  | Describes components, data flow and sequences            | Component graphs and sequence diagrams, new and changed parts highlighted | The shape                    |
| **Slice**   | Splits the work into buildable slices with dependencies  | A dependency graph of slices, each with files and checks                  | The build order              |

After Slice, the **Blueprint** screen shows everything on one page. Approving it writes the plan file.

### The gate loop

```
 agent works in phase ──▶ agent calls architect_advance ──▶ Phase Review screen
        ▲                                                   │
        └──── "request changes" + your comment ◀────────────┤
                                                            ▼
                                              approve ──▶ next phase
```

`architect_advance` blocks until the user decides. A "request changes" answer returns the user's comment as the tool result.

## The stepper widget

A widget above the editor shows the current phase and what is still open:

```
 ◆ ARCHITECT  Frame ━━ Explore ━━ ●Decide ━━ Design ━━ Slice      3 open · 2 decided · ⚠ 1 risk
```

## The decision card

The model gives 2 to 4 options with pros, cons, effort, risk and one recommendation.

```
╭─ Decision 3/5 · Where do panel events get deduplicated? ─────────────────╮
│                                                                          │
│  ┌ A  In processor ★ ┐  ┌ B  In backend ───┐  ┌ C  Redis stream ──┐      │
│  │ effort ▰▰▱▱▱      │  │ effort ▰▰▰▱▱     │  │ effort ▰▰▰▰▱      │      │
│  │ risk   ▰▱▱▱▱      │  │ risk   ▰▰▱▱▱     │  │ risk   ▰▰▰▱▱      │      │
│  │ + one owner       │  │ + has DB context │  │ + scales out      │      │
│  │ − state per node  │  │ − later dedup    │  │ − new infra       │      │
│  └───────────────────┘  └──────────────────┘  └───────────────────┘      │
│                                                                          │
│  ↵ choose   c comment   e edit option   n new option   ? ask why   esc   │
╰──────────────────────────────────────────────────────────────────────────╯
```

←/→ moves between options. The choice and any comment go back to the model as the tool result.
"Pick B, but only for alarms" is a valid answer.

## Diagrams

The model sends a graph (`{ nodes, edges, groups }`) or a sequence (`{ participants, messages }`).
The extension lays it out and draws it with Unicode box characters in theme colours:

- green for new parts
- yellow for changed parts
- dim for untouched parts

v1 renders Unicode only. Image rendering through Pi's `Image` component can come later.
Every diagram must fit the available width. Tests cover narrow widths.

## The board

`/board` opens a fullscreen overlay with tabs: **Brief · Decisions · Diagrams · Risks · Plan**.
It shows the whole design at once. Every action has a keyboard path. Mouse works in fullscreen mode.

## The model-facing surface

Five tools. Tool schemas are sent on every request, so the surface stays small.

| Tool                | Blocks | Purpose                                                       |
| ------------------- | ------ | ------------------------------------------------------------- |
| `architect_update`  | no     | Fill in phase content: brief, findings, risks                 |
| `architect_decide`  | yes    | Show a decision card and wait for the user's choice           |
| `architect_diagram` | no     | Send a structured graph or sequence for the extension to draw |
| `architect_slice`   | no     | Define slices and their dependencies                          |
| `architect_advance` | yes    | Ask to move to the next phase. Opens the Phase Review screen  |

## User commands

- `/architect <feature>` starts a session.
- `/board` opens the fullscreen overview.
- `/architect abort` ends the session without a plan file.

## Read-only while architecting

- Edit and write tools are off.
- Bash runs through an allowlist of read-only commands, like Pi's plan-mode example.
- The only file the extension writes is the plan file, and only after the user approves the Blueprint.

## State

- Every change is a session entry (`pi.appendEntry`). The extension rebuilds state from the current branch.
- A fork in the session tree is a what-if branch. The user can fork at a decision, pick another option and compare.
- Decision cards and diagrams render in the transcript through `pi.registerEntryRenderer`. They never reach the model.

## The plan file

The plan file is the product. A builder agent with no other context must be able to build from it.

```markdown
---
feature: dedupe-panel-events
status: approved
slices: 4
---

# Brief

Goal, constraints, out of scope, done-when.

# Context

Modules and files involved. Existing patterns to follow.

# Decisions

The chosen option, the rejected options and why. The builder does not reopen these.

# Design

Diagrams in Unicode (readable anywhere) and Mermaid source (renders on GitHub).

# Slices

## 1. <title>

- depends on: –
- files: expected touch points
- steps: concrete changes
- verify: exact commands or tests that prove the slice is done
```

## v1 build order

1. Repository setup: CI, publish workflow, lint, prettier, tsconfig, test harness.
2. State, phases, read-only mode and the stepper widget.
3. Decision card and Phase Review screen.
4. Unicode diagram renderer, with tests at narrow widths.
5. Plan file writer and Blueprint screen.
6. `/board` overlay.
