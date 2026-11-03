# pi-architect

Architect a feature with [Pi](https://github.com/earendil-works/pi) before you build it.

The agent walks through six phases: Frame, Explore, Decide, Design, Slice and Blueprint.
You approve each phase before it moves on. The result is a plan that another agent can build from.

> Work in progress. See [DESIGN.md](./DESIGN.md) for the plan.

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

- Edit and write are off.
- Bash only runs read-only commands. `ls && rm x`, `echo x > file` and `$(…)` are blocked, and the agent is told why.
- The agent records the design with `architect_update`.
- The agent raises each open question with `architect_decide`. A decision card shows the options side by side. You pick one, add a comment, write your own option or ask a question first.
- The agent calls `architect_advance` when a phase is done. A review screen shows the phase. You approve it or ask for changes with a comment.
- The agent splits the work into slices with `architect_slice`. Each slice has files, concrete steps and verify commands.

When you approve the Blueprint, the plan is written to `docs/plans/<feature>.md`. An existing file is never overwritten: the name gets `-2`, `-3` and so on.
Change the directory with `pi --architect-plan-dir <dir>`.

In build mode a line above the editor shows the progress: `▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key`.
The builder ticks the boxes in the plan file as it works, so the plan file is where progress lives.

| Command                          | What it does                                 |
| -------------------------------- | -------------------------------------------- |
| `/architect <feature>`           | Architect mode, on a new feature             |
| `/architect reset`               | Discard the architecture in this session     |
| `/plan`                          | Show the plan and its progress, with actions |
| `/plan build`                    | Build the plan in a new session              |
| `/plan here`                     | Build the plan in this session               |
| `/plan copy`, `/plan open`       | Copy the plan path, or open the file         |
| `/plan write`                    | Write the plan file again when it is missing |
| `/mode architect`, `/mode build` | Switch mode. `/mode` alone opens a picker    |
| `ctrl+alt+a`                     | Toggle the mode                              |
| `pi --architect`                 | Start in architect mode                      |

On the decision card: ←/→, tab or 1–4 move, ↵ chooses, `c` chooses with a comment, `n` adds your own option, `?` asks a question, esc closes.
On a review screen: ↑/↓ and PgUp/PgDn scroll, ↵ approves, `r` requests changes, esc closes.

The footer always shows the mode. In architect mode a stepper above the editor shows the phases, open decisions and risks.

The mode and the design live in the session. They survive reload and resume. Fork the session to try another answer.

## What works so far

- Architect and build mode, with the switch in the transcript and in the footer.
- Read-only mode with a checked bash allowlist.
- Decision cards, and a review screen for every phase with approve and request changes.
- Decisions and verdicts as small cards in the transcript.
- The brief, modules, findings and risks.
- Slices with a checked dependency graph, the plan file and build progress.

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
