# Using cdp-drive with AI coding agents

Agents can run commands but usually can't see the app they just changed. These files give them eyes.

| File | What to do with it |
|---|---|
| [`INSTRUCTIONS.md`](INSTRUCTIONS.md) | Paste into `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md` or a system prompt |
| [`claude-skill/SKILL.md`](claude-skill/SKILL.md) | Copy to `.claude/skills/browser-check/SKILL.md` in your project for Claude Code |

## Claude Code

```bash
npm install -g github:prroha/cdp-drive
mkdir -p .claude/skills/browser-check
curl -o .claude/skills/browser-check/SKILL.md \
  https://raw.githubusercontent.com/prroha/cdp-drive/main/agents/claude-skill/SKILL.md
```

The skill loads itself when the work calls for it. To have Claude reach for it without asking, add a line to `CLAUDE.md`:

```markdown
After changing UI code, verify it in the browser with cdp-drive (see the browser-check skill).
```

Allow the commands to run without a prompt each time, in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(cdp-drive:*)"] } }
```

## Cursor, Copilot, Codex and others

Paste [`INSTRUCTIONS.md`](INSTRUCTIONS.md) into whichever instruction file the tool reads. Nothing else is needed: cdp-drive is a normal command-line program, so any agent that can run shell commands can use it.

## Why structure beats screenshots

A screenshot of a page costs thousands of tokens and still leaves the agent guessing at selectors. `cdp-drive --json snapshot` returns the interactive elements with their ids, roles, names and test ids, usually in a few hundred tokens, and the agent can act on them directly.

Keep screenshots for what they are good at: layout, spacing and visual styling.
