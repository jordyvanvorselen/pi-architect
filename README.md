# pi-architect

Architect a feature with [Pi](https://github.com/earendil-works/pi) before you build it.

The agent walks through six phases: Frame, Explore, Decide, Design, Slice and Blueprint.
You approve each phase before it moves on. The result is a plan that another agent can build from.

> Work in progress. See [DESIGN.md](https://github.com/jordyvanvorselen/pi-architect/blob/main/DESIGN.md) for the plan.

## Install

```bash
pi install npm:@jordyvanvorselen/pi-architect
```

## Use

```text
/architect Dedupe panel events
```

This switches the session to architect mode and starts the agent on Frame.

Each Pi session has a mode. **Build** is normal Pi and the default. **Architect** is read-only:

- Only read-only tools run: read, grep, find, ls, bash and the architect tools. Edit, write and tools from other extensions are blocked.
- Bash only runs read-only commands. `ls && rm x`, `echo x > file`, `$(…)`, `$HOME` and `sed -i` are blocked, and the agent is told why. See [Read-only bash](#read-only-bash).
- The agent records the design with `architect_update`.
- The agent draws components, data flow and sequences as Unicode diagrams with `architect_diagram`. Each diagram is checked for alignment before you see it, with `[new]`, `[changed]` and `[removed]` parts highlighted.
- The agent raises each open question with `architect_decide`. A decision card shows the options side by side. You pick one, add a comment, write your own option or ask a question first.
- The agent calls `architect_advance` when a phase is done. A review screen shows the phase. You approve it or ask for changes with a comment.
- The agent splits the work into slices with `architect_slice`. Each slice has files, concrete steps and verify commands.

When you approve the Blueprint, the plan is written to `docs/plans/<feature>.md`. An existing file is never overwritten: the name gets `-2`, `-3` and so on.
Change the directory with `pi --architect-plan-dir <dir>`.

In build mode a line above the editor shows the progress: `▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key`.
The builder ticks the boxes in the plan file as it works, so the plan file is where progress lives.

| Command                          | What it does                                                      |
| -------------------------------- | ----------------------------------------------------------------- |
| `/architect`                     | Switch to architect mode. In architect mode it offers the actions |
| `/architect <feature>`           | Architect mode, on a new feature                                  |
| `/architect build`               | Switch to build mode                                              |
| `/architect board`, `ctrl+alt+b` | See the whole design on one screen                                |
| `/architect review`              | Review the current phase, e.g. again after closing its review     |
| `/architect plan`                | Show the plan and its progress, with actions                      |
| `/architect plan open`           | Open the plan file                                                |
| `/architect plan write`          | Write the plan file again when it is missing                      |
| `/architect plan build`          | Build the plan in a new session                                   |
| `/architect reset`               | Discard the architecture in this session                          |
| `ctrl+alt+a`                     | Toggle the mode                                                   |
| `pi --architect`                 | Start in architect mode                                           |

`build`, `board`, `review`, `plan` and `reset` are reserved. A first word that only starts with one, like `Builder`, asks whether you meant the command.
Put a feature name in quotes to use it as written: `/architect "Build pipeline"`. Every question that discards work starts on No.
`/architect plan` alone also offers to build the plan in this session or to copy its path.

On the decision card: ←/→, tab or 1–4 move, ↵ chooses, `c` chooses with a comment, `n` adds your own option, `?` asks a question, `b` opens the board, esc closes.
On a review screen: ↑/↓, PgUp/PgDn, space, Home and End scroll, ↵ approves, `r` requests changes, `b` opens the board, esc closes.
Closing a card or a review without an answer stops the agent, so esc asks first. `/architect review` opens a closed review again.

The board shows the whole design on one screen, with a tab for the brief, the code map, decisions, diagrams, risks, slices and the plan.
Switch tabs with 1–7 or tab, move with ↑/↓, open an item with ↵. Press `c` on anything to comment on it.
When you close the board with comments, it asks whether to send them. ↵ sends them to the agent as one message, with the decision, diagram or slice each one is about. `d` discards them and esc goes back to the board.
In build mode the board is read-only, for reading the approved design. So is the board you open with `b` from a decision card or review screen. Closing it takes you back to where you were.

The footer always shows the mode. In architect mode a stepper above the editor shows the phases, open decisions and risks.

The mode and the design live in the session. They survive reload and resume. Fork the session to try another answer.

## Read-only bash

In architect mode every bash command is checked before it runs. The check fails closed: anything it does not know is blocked.

- Every command in a chain or pipeline must be on an allowlist of commands that only read, like `ls`, `cat`, `grep`, `rg`, `find`, `git log`, `gh pr view` and `npm ls`.
- Commands that can also write or run programs only get the options on their own allowlist. `find -exec`, `sort -o`, `git -c`, `curl -o` and `gh api -X DELETE` are blocked.
- Long options must be written in full. GNU tools read `--outp` as `--output`.
- Words must be literal, so the checker sees what bash runs. `$` in any form, backticks, `{a,b}`, `~user` and variable assignments are blocked. Put text with `$` in single quotes.
- Unquoted globs like `src/*.ts` only work where they can only match file names, never options.
- Output can only go to `/dev/null`. Here-documents, subshells and background jobs are blocked.

The check is a parser, not a sandbox. Tools still read their own config, and git can run programs that a repository's config names. Run Pi in a sandbox if you need a hard guarantee.

## What works so far

- Architect and build mode, with the switch in the transcript and in the footer.
- Read-only mode with a checked bash allowlist.
- Decision cards, and a review screen for every phase with approve and request changes.
- Decisions and verdicts as small cards in the transcript.
- The brief, modules, findings and risks.
- Unicode diagrams, checked for alignment and highlighted.
- Slices with a checked dependency graph, the plan file and build progress.
- The board, with comments for the agent.

## Develop

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:coverage
```

## License

MIT
