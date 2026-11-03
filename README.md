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
- The agent calls `architect_advance` when a phase is done. You approve it or ask for changes with a comment.

| Command                          | What it does                              |
| -------------------------------- | ----------------------------------------- |
| `/architect <feature>`           | Architect mode, on a new feature          |
| `/architect reset`               | Discard the architecture in this session  |
| `/mode architect`, `/mode build` | Switch mode. `/mode` alone opens a picker |
| `ctrl+alt+a`                     | Toggle the mode                           |
| `pi --architect`                 | Start in architect mode                   |

The footer always shows the mode. In architect mode a stepper above the editor shows the phases, open decisions and risks.

The mode and the design live in the session. They survive reload and resume. Fork the session to try another answer.

## What works so far

- Architect and build mode, with the switch in the transcript and in the footer.
- Read-only mode with a checked bash allowlist.
- The phase gate with a simple approve or request-changes dialog.
- The brief, modules, findings and risks.

Decision cards, diagrams, slices, the plan file and `/board` come next.

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
