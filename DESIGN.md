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

| Mode      | Tools                                                                                | The agent                                              |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| architect | Read-only. Only read, grep, find, ls, read-only bash and the architect tools are on. | Walks through the phases. The user approves each gate. |
| build     | All normal tools. The architect tools are off.                                       | Builds, from the approved plan if there is one.        |

- `/architect` switches to architect mode. In architect mode it opens a picker: the board, a review of the phase, the plan, build mode or reset.
- `/architect build` switches to build mode.
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
│  ↵ choose  c choose with comment  n own option  ? ask  ←→ move  b board  esc close   │
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

- ←/→, tab and 1–4 move between options. Focus starts on the recommendation. ↵ chooses. `b` opens the board.
- `c` chooses with a comment, `n` writes an own option, `?` asks a question instead. Each opens an editor inside the card.
- esc closes the card without a choice, which stops the agent, so it asks first: `Close without choosing? The agent will stop.  ↵ close  esc back`.
- Four options sit two by two when a row does not fit. On narrow or short terminals the options fold into a list with the focused one open.
- The choice and any comment go back to the model as the tool result. "Pick B, but only for alarms" is a valid answer.
  An own option is recorded as a new option and chosen. A question goes back to the model, which answers and asks again with the same id.
- Decision ids are `q1`, `q2` and so on. Diagrams use `d1`. Slices go by their build number, as in the plan file: `slice 3`.
- The header counts the decisions raised so far, like `Decision 3/5`. When the agent estimates more than are raised, it shows the estimate as one: `Decision 1 of about 3`.

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

Long screens scroll with ↑/↓, PgUp/PgDn, space, Home and End. In Pi's fullscreen mode these keys scroll the screen, not the transcript behind it. The right border is the scrollbar. ↵ approves, `r` opens an editor for the requested changes, `b` opens the board.

esc closes the screen, but first asks in the bottom bar: `Close without a verdict? The agent will stop.  ↵ close  esc back`.
A closed review tells the agent the user closed it, and the agent stops. `/architect review` opens the same review again, with the agent's summary.
The verdict then goes to the agent as a message that starts its next turn.

For 300 ms after the card or a screen opens, ↵ and the keys that choose, approve or open an editor do nothing, also ↵ in the close question. A ↵ meant for the chat editor then cannot choose, approve or close by accident. The arrows, `b` and esc still work.

The card and the screens are inline, in place of the editor. The transcript stays in view, and terminals that support it show Pi as waiting for the user. RPC clients get simple select dialogs instead.

## Diagrams

The agent draws each diagram itself in Unicode box characters. A diagram has a title, a body and an optional caption.
The agent marks parts with `[new]`, `[changed]` or `[removed]`.

The extension does not lay anything out. It checks the diagram, for example that it fits the width.
It repairs slips with one clear reading first: a corner or a box side exactly one column off, and a line that meets a box edge without a junction.
A repair is kept only when the linter then finds less and nothing new. The agent hears what changed, so a revision keeps it. Anything else is rejected with findings.
It shows the diagram in theme colours, with the `[new]`, `[changed]` and `[removed]` parts highlighted.

v1 shows Unicode only. Image rendering through Pi's `Image` component can come later. Tests cover narrow widths.

## The board

`/architect board` or `ctrl+alt+b` opens the board: the whole design on one screen, as an overlay over the terminal.
The stepper and the build widget show `ctrl+alt+b board` while there is room for it.

Pi runs extension shortcuts only from the main editor, so `ctrl+alt+b` does nothing while a decision card or review screen is open.
There, `b` opens the board on top. It is read-only: the card or the screen is where the user answers, and the agent waits for that answer.
Closing the board returns to the card or the screen exactly as it was.
When the agent opens a card or a review screen while the board is open, the board closes first, so the card never opens unseen behind it.
Unsent comments stay as a draft and are back the next time the board opens.

```
╭─ ◆ Board  Dedupe panel events ───────────────────────────────────────────────────────────────╮
│  ✓ Frame ━━ ✓ Explore ━━ ✓ Decide ━━ ✓ Design ━━ ● Slice ┄┄ Blueprint                        │
│  Brief   Explore 7   Decisions 2   Diagrams 3   Risks 3 (1 high)   ● Slices 4   Plan draft   │
├─────────────────────━━━━━━━━━━━━━────────────────────────────────────────────────────────────┤
│  ┃ q1  Where do panel events get deduplicated?                                               │
│  ┃     ✓ A  In the processor ★                                                               │
│  ┃       "Yes, and log every skipped duplicate at debug level."                              │
│  ┃       B In the backend · C Redis stream                                                   │
│                                                                                              │
│    q2  How long do dedup keys stay unique?                                                   │
│        ✓ B  Per day                                                                          │
│          A Forever ★                                                                         │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  1-7 tabs  ↑↓ move  ↵ open  c comment  esc close                                             │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

It has seven tabs: **Brief · Explore · Decisions · Diagrams · Risks · Slices · Plan**.

| Tab       | Shows                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| Brief     | Goal, constraints, out of scope and done-when                                          |
| Explore   | The module map and the findings                                                        |
| Decisions | Each decision with its choice. ↵ opens it: every option as a card with effort and risk |
| Diagrams  | Every diagram, grouped by phase. ↵ opens one full size, and ←/→ scroll it sideways     |
| Risks     | The risks, high first, with how to soften each one                                     |
| Slices    | The slices in build order, grouped in steps. ↵ shows files, steps and verify commands  |
| Plan      | The plan as it will be written, or the plan file once it is. Shows the path            |

- The tab bar shows counts and states, like `Decisions 3 (1 open)`. The tab of the current phase has a `●`.
  Tabs whose phase has not started are dim. They still open, and say what will appear there and when.
- On narrow terminals the labels lose their notes, then their counts, then shorten to `Brf Exp Dec`, then to the numbers.
  Short terminals drop the phases line first.
- The board follows the architecture live. When the agent adds a risk while the board is open, it shows up.

Keys: 1–7, tab and shift+tab, or ←/→ switch tabs. ↑/↓ or j/k move between items and scroll through a long one.
PgUp/PgDn, space, Home/End and g/G scroll. ↵ opens an item, `e` opens or closes every item on the tab.
esc steps back from a diagram and closes the board. q does the same.

Mouse, in Pi's fullscreen mode: click a tab to open it, click an item to select it, click it again or double-click to open it.
The wheel scrolls, and shift+wheel scrolls a diagram sideways.

### Comments from the board

The board is where the user co-architects. Select anything (a brief field, a finding, a decision, a diagram, a risk, a slice or the plan) and press `c`.
An editor opens at the bottom: `↵ save  shift+↵ new line  esc back`, worded like the editors on the card and the review screens. esc keeps the text for the next `c` on that item.

- A comment shows under its item. The tab gets a `✎1`, the title says `✎ 2 to send` and the bottom edge lists the items, like `✎ q2 · slice 3`.
- `c` on an item with a comment edits it. Saving it empty or pressing `x` removes it. `m` jumps to the next comment, on any tab. Clicking an item in the bottom edge jumps to it.
- Closing the board with comments asks first, in the bottom bar: `Send 2 comments to the agent?  ↵ send  d discard  esc back`.
  Without comments the board closes at once.
- Sent comments go to the agent as one user message:

  ```
  Board comments:
  - q2 "How long do dedup keys stay unique?": per day is fine, but use the panel's time zone
  - slice 3 "Skip duplicates on insert": also count the skipped ones
  ```

- When the agent is idle the message starts a turn. When it is working, the message is steered in, so the agent reads it before its next step.

In build mode the board is read-only: it shows the approved architecture and the plan file, without comments. So is a board opened from a decision card or review screen.
A session that only builds from a plan file shows that file on the Plan tab.

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

Every command lives under `/architect`. The first words `build`, `board`, `review`, `plan` and `reset` are reserved. Anything else names a feature.
A first word that starts with a reserved word but is not one, like `board6cSplit` typed after autocomplete or `Builder`, asks "Did you mean `/architect board`?" with the command first.
Quotes name a feature as written: `/architect "Build pipeline"`. Questions that discard work, like reset or a new feature over an old one, start on No.

| Command                 | Does                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `/architect`            | Switches to architect mode. In architect mode it opens a picker: board, review, plan, build mode, reset |
| `/architect <feature>`  | Switches to architect mode and starts on a feature                                                      |
| `/architect build`      | Switches to build mode                                                                                  |
| `/architect board`      | Opens the board, the whole design on one screen. `ctrl+alt+b` does the same                             |
| `/architect review`     | Opens the review of the current phase, e.g. again after esc closed it                                   |
| `/architect plan`       | Shows the plan path and progress, and offers the actions                                                |
| `/architect plan open`  | Opens the plan file in the default app                                                                  |
| `/architect plan write` | Writes a missing plan file again                                                                        |
| `/architect plan build` | Starts a new session that builds the plan. It knows the plan, so it shows the progress                  |
| `/architect reset`      | Discards the architecture in this session, after a confirmation                                         |

`/architect plan` alone also offers "Build it here", which switches to build mode and asks the agent to build the plan, and "Copy the path".
The completion lists the subcommands with a short description, and `open`, `write` and `build` after `plan`.

## Read-only in architect mode

- Tools are an allowlist: only read, grep, find, ls, bash and `architect_*` are on. Any other tool call, including tools from other extensions, is blocked with a reason that names the allowed tools and `/architect build`.
  Architect mode also turns every other tool off, so its schema is not sent, and build mode turns exactly those back on.
  The mode event records which tools it turned off, because Pi restores the tool set from the transcript after a reload. A tool that turns on later, like an MCP tool that registers late, is turned off at the start of the next turn, also in the middle of a run, and recorded too.
- Each architect tool is only on in its phases: `architect_update` and `architect_advance` always, `architect_decide` in Decide, `architect_diagram` from Explore on and `architect_slice` in Slice and Blueprint.
- Bash runs only allowlisted read-only commands. Every command in a chain or pipeline must pass. The check fails closed.
- Words must be literal. The lexer refuses anything bash would expand before the command runs: `$` in any form (variables, `$(…)`, `$'…'`, `$"…"`), backticks, brace expansion, `~user` and `~` after `=` or `:`, and process substitution. Otherwise `find . {-exec,} sh` or `find . -exec$U sh` would reach bash as `-exec`. Variable assignments, alone or before a command, are refused too.
- Globs are marked, not refused. A command name can't be a glob. A glob is allowed where a command only takes paths, and only when it starts with a plain character, so it can never match a file named `-exec` or `--output=x`.
- Commands with options that write or run something get an allowlist of options, not a denylist (`src/readonly/options.ts`). Long options must be written in full: GNU tools and git accept any unambiguous prefix, and only the tool knows its whole option list. A value given as the next word may not look like an option, in case a tool reads the option as a flag.
- git is checked in three layers (`src/readonly/git.ts`): global options, the subcommand, and its options. `git -c`, `--exec-path`, `ls-remote`, `--output`, `--ext-diff` and `grep -O` are not on the lists.
- Builtins that evaluate array subscripts are refused: `printf -v` and `test -v` can run `a[$(cmd)]`.
- Dropped, because they could not be made safe with reasonable effort: `xxd` (writes its second argument), `cloc` (Perl option prefixes, `--report-file`, `--vcs`), `ag` and `ack` (pagers, `.ackrc`), `pnpm` and `yarn` (repository hooks and `yarnPath`), `cargo` (repository config runs programs). Runtimes like `node` and `python` only print their version.
- Output redirection goes only to `/dev/null`. Here-documents, subshells and background jobs are blocked.
- A blocked call tells the model why, so it can pick a read-only way, often with the alternative: "use the read tool", "use od or hexdump".
- This is a parser, not a sandbox. Tools still read their own config and write their own caches, and git runs programs a repository's config names (`core.fsmonitor`, textconv). An OS sandbox such as `sandbox-exec` or `bwrap` would be the next layer.
- `tests/readonly-bash.test.ts` runs every allowed attack candidate in a real bash, with a canary file and a fake `PATH` whose `sh` and `touch` only log, to prove nothing ran.
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
6. The board.
