# pi-architect design

pi-architect adds an architect mode to Pi. You use it to design one feature before anyone builds it.
The agent moves through the phases and shows each one visually. You approve every phase before the agent moves on.
The result is a plan file that another agent can build from without any other context.

## Goals

- **The user decides.** The agent proposes. The user approves, picks or asks for changes at every gate.
- **Visual, not chatty.** Each phase has its own screen. The user sees the design, not walls of text.
- **The model sends data, the extension draws it.** Cards come from structured JSON, drawn with Pi's theme. Diagrams are the one exception: the agent draws them in Unicode, and the extension checks and highlights them.
- **Few tokens.** Rendered cards live in session entries that the model never sees.
- **A plan another agent can build.** The plan file holds every decision, the reasons and a way to verify each slice.

## Modes

Every Pi session has a mode: **architect** or **build**. The user sets it. A new session starts in build mode, which is normal Pi.

| Mode      | Tools                                                          | The agent                                              |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| architect | Read-only. Edit and write are off. The architect tools are on. | Walks through the phases. The user approves each gate. |
| build     | All normal tools. The architect tools are off.                 | Builds, from the approved plan if there is one.        |

- `/mode architect` and `/mode build` switch. `/mode` alone opens a picker.
- `ctrl+alt+a` toggles the mode. Pi does not bind this key.
- `pi --architect` starts in architect mode.
- `/architect <feature>` switches to architect mode, names the feature and starts the agent on Frame.
- `/architect reset` discards the architecture in this session, after a confirmation.

The mode is stored in the session, so it survives reload and resume. The footer always shows it: `◆ architect · Decide` or `▸ build`.

If the user enters architect mode without naming a feature, their first prompt describes it. The agent names it in Frame.

Leaving architect mode before the Blueprint is approved asks for confirmation. Coming back resumes at the same phase.
Each switch shows as a small line in the transcript. The model hears about it once, on its next turn.

One architecture per session. A new `/architect <feature>` replaces it, after a confirmation.

## Phases

The agent moves through the phases in order. It cannot skip one.

| Phase       | What the agent does                                      | Review screen shows                                               | The user approves            |
| ----------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| **Frame**   | Writes the goal, constraints, out of scope and done-when | A brief card                                                      | The scope                    |
| **Explore** | Reads the code without changing it                       | A module map with the touched parts highlighted, and key findings | That the agent understood it |
| **Decide**  | Raises each open question as a decision                  | One decision card per question                                    | Each choice                  |
| **Design**  | Draws components, data flow and key flows as diagrams    | The diagrams, with new, changed and removed parts highlighted     | The shape                    |
| **Slice**   | Splits the work into buildable slices with dependencies  | A dependency graph of slices, each with files and checks          | The build order              |

After Slice, the **Blueprint** phase shows everything on one page. Approving it makes the plan final and writes the plan file.

A phase cannot go to review while it is incomplete. `architect_advance` then tells the agent what is missing, for example the goal or a verify step.

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

In architect mode a widget above the editor shows the phases and what is still open:

```
 ◆ ARCHITECT  dedupe-panel-events  ✓ Frame ━━ ✓ Explore ━━ ● Decide ┄┄ Design ┄┄ Slice ┄┄ Blueprint   3 open · 2 decided · ⚠ 1 risk
```

Approved phases are green, the current one is in the accent colour and the pending ones are dim.
A phase in review is yellow. On narrow terminals the line drops the feature name, then the counters, then shortens the phase names.

In build mode with an approved plan, the widget shows slice progress instead:

```
 ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key
```

Progress lives in the plan file. The builder ticks a box for each step and one for "Verified" per slice.
The extension reads the file again after an edit or write of that file, after bash and after each run.
This needs no extra tool, works in any session and in any tool that edits markdown.
On narrow terminals the line cuts the title, then drops the plan name, the title and the numbers.

## The decision card

The model gives 2 to 4 options with pros, cons, effort, risk and one recommendation with a reason.

```
╭─ ◆ Decision 3/5 ─────────────────────────────────────────────── dedupe-panel-events ─╮
│                                                                                      │
│  Where do panel events get deduplicated?                                             │
│  Panels resend every event during a failover.                                        │
│                                                                                      │
│  ┏━ A  In processor ★ ━━━━┓  ┌─ B  In backend ────────┐  ┌─ C  Redis stream ──────┐  │
│  ┃ effort ▰▰▱▱▱           ┃  │ effort ▰▰▰▱▱           │  │ effort ▰▰▰▰▱           │  │
│  ┃ risk   ▰▱▱▱▱           ┃  │ risk   ▰▰▱▱▱           │  │ risk   ▰▰▰▱▱           │  │
│  ┃ + one owner            ┃  │ + has DB context       │  │ + scales out           │  │
│  ┃ − state per node       ┃  │ − later dedup          │  │ − new infra            │  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━┛  └────────────────────────┘  └────────────────────────┘  │
│                                                                                      │
│  ★ Agent recommends A  In processor                                                  │
│    One owner, no new infra.                                                          │
│                                                                                      │
│  ↵ choose  c choose with comment  n own option  ? ask  ←→ move  esc close            │
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

- ←/→, tab and 1–4 move between options. Focus starts on the recommendation. ↵ chooses.
- `c` chooses with a comment, `n` writes an own option, `?` asks a question instead. Each opens an editor inside the card.
- Four options sit two by two when a row does not fit. On narrow or short terminals the options fold into a list with the focused one open.
- The choice and any comment go back to the model as the tool result. "Pick B, but only for alarms" is a valid answer.
  An own option is recorded as a new option and chosen. A question goes back to the model, which answers and asks again with the same id.
- Decision ids are `q1`, `q2` and so on. Diagrams use `d1`.

## Phase Review screens

`architect_advance` opens a review screen for the phase: a frame with the agent's summary, the phase and the verdict keys.

| Phase     | The screen shows                                                      |
| --------- | --------------------------------------------------------------------- |
| Frame     | The brief: goal, constraints beside out of scope, done-when           |
| Explore   | The module map as a tree, with touched, new and context markers       |
| Decide    | Each decision with the choice and comment. Rejected options are dim   |
| Design    | The diagrams, drawn by the diagram renderer                           |
| Slice     | The slices in build order, with arrows, files, steps and verify       |
| Blueprint | Everything on one page, and the path the plan file will be written to |

Long screens scroll with ↑/↓, PgUp/PgDn, Home and End. The right border is the scrollbar. ↵ approves, `r` opens an editor for the requested changes, esc closes.

For 300 ms after the card or a screen opens, ↵ and the keys that choose, approve or open an editor do nothing. A ↵ meant for the chat editor then cannot choose or approve by accident. The arrows and esc still work.

The card and the screens are inline, in place of the editor. The transcript stays in view, and terminals that support it show Pi as waiting for the user. RPC clients get simple select dialogs instead.

## Diagrams

The agent draws each diagram itself in Unicode box characters. A diagram has a title, a body and an optional caption.
The agent marks parts with `[new]`, `[changed]` or `[removed]`.

The extension does not lay anything out. It checks the diagram, for example that it fits the width.
It shows the diagram in theme colours, with the `[new]`, `[changed]` and `[removed]` parts highlighted.

v1 shows Unicode only. Image rendering through Pi's `Image` component can come later. Tests cover narrow widths.

## The board

`/board` opens a fullscreen overlay with tabs: **Brief · Decisions · Diagrams · Risks · Plan**.
It shows the whole design at once. Every action has a keyboard path. Mouse works in fullscreen mode.

## The model-facing surface

Five tools. Tool schemas are sent on every request, so the surface stays small.
The tools are only active in architect mode, so build mode does not pay for them.

| Tool                | Blocks | Purpose                                                              |
| ------------------- | ------ | -------------------------------------------------------------------- |
| `architect_update`  | no     | Fill in phase content: feature name, brief, modules, findings, risks |
| `architect_decide`  | yes    | Show a decision card and wait for the user's choice                  |
| `architect_diagram` | no     | Send a Unicode diagram for the extension to check and show           |
| `architect_slice`   | no     | Define slices and their dependencies                                 |
| `architect_advance` | yes    | Ask to move to the next phase. Opens the Phase Review screen         |

## User commands

- `/mode [architect|build]` switches the mode.
- `/architect <feature>` switches to architect mode and starts on a feature.
- `/architect reset` discards the architecture.
- `/board` opens the fullscreen overview.
- `/plan` shows the plan path and progress and offers the actions below.
- `/plan build` starts a new session that builds the plan. The new session knows the plan, so it shows the progress.
- `/plan here` switches to build mode and asks the agent to build the plan.
- `/plan copy`, `/plan open` and `/plan write` copy the path, open the file and write a missing file again.

## Read-only in architect mode

- Edit and write tools are off. A call that gets through anyway is blocked with a reason.
- Bash runs only allowlisted read-only commands. Every command in a chain or pipeline must pass.
  Output redirection to files, command substitution, subshells, here-documents and background jobs are blocked.
  Commands that can also write, like `git`, `sed`, `find` and `sort`, are checked argument by argument.
- A blocked call tells the model why, so it can pick a read-only way.
- The only file the extension writes is the plan file, and only after the user approves the Blueprint.

## State

- Every change, including a mode switch, is a session entry (`pi.appendEntry`). A pure reducer rebuilds the state from the current branch.
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

Each diagram body in a fenced code block, with its title and caption.

# Slices

## 1. <title>

- depends on: –
- files: expected touch points
- steps: concrete changes
- verify: exact commands or tests that prove the slice is done
```

The real file starts with a short "How to build this plan" section for the builder.
Slices come in build order, with steps as checkboxes and verify commands in a `bash` block.
The output is deterministic and stable under prettier.

- It goes to `docs/plans/<slug>.md`, or the directory from `--architect-plan-dir`.
- It never overwrites a file. A taken name gets `-2`, `-3` and so on.
- The extension writes it with Node, not through the edit or write tools, so the read-only guard stays as strict.
- `architect_slice` rejects duplicate ids, unknown dependencies, cycles, vague steps and slices without a verify command.

## v1 build order

1. Repository setup: CI, publish workflow, lint, prettier, tsconfig, test harness.
2. State, modes, phases, read-only mode and the stepper widget.
3. Decision card and Phase Review screen.
4. Unicode diagram renderer, with tests at narrow widths.
5. Plan file writer and Blueprint screen.
6. `/board` overlay.
