# cdp-drive instructions for an AI coding agent

Paste this into the file your agent reads: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`, or a system prompt. Trim what doesn't apply.

---

## Checking the running app in a browser

`cdp-drive` reads and drives a real browser from the command line. Use it to verify UI work instead of guessing, and prefer it to screenshots: `snapshot` returns structured JSON and costs far fewer tokens.

### Before anything else

```bash
cdp-drive doctor || cdp-drive launch http://localhost:3000
```

`doctor` reports Node, the browser and the debugging port. `launch` starts a browser with debugging on, in a throwaway profile.

### Reading the page

| Goal | Command |
|---|---|
| What is on screen | `cdp-drive snapshot` |
| Which tabs are open | `cdp-drive tabs` |
| Text of one element | `cdp-drive text "<selector>"` |
| Markup of one element | `cdp-drive dom "<selector>"` |
| One attribute | `cdp-drive attr "<selector>" <name>` |
| Anything else | `cdp-drive eval "<js expression>"` |
| Console output and errors | `cdp-drive logs 5` |
| A picture, when structure isn't enough | `cdp-drive shot /tmp/page.png` |

### Driving the page

| Goal | Command |
|---|---|
| Click | `cdp-drive click "<selector>"` |
| Type into a field | `cdp-drive fill "<selector>" "<value>"` |
| Press a key | `cdp-drive press "<selector>" Enter` |
| Wait for something | `cdp-drive wait "<selector>" --timeout 5000` |
| Navigate | `cdp-drive goto <url>` · `cdp-drive reload` |
| Work inside an iframe | `cdp-drive frames`, then `cdp-drive --frame "<selector>" <command>` |

### Flags worth knowing

- `--json` — machine-readable results **and** errors (`{"error": "...", "code": 1}`)
- `--quiet` — drop confirmation lines like `clicked #save`
- `--page <substring>` / `--tab <index>` — choose the tab when several are open
- Exit codes: `0` ok, `1` error (no match, bad selector, eval threw), `2` timeout, `3` no browser reachable

### The loop to run after changing UI code

```bash
cdp-drive doctor || cdp-drive launch http://localhost:3000
cdp-drive reload
cdp-drive wait "#app" --timeout 10000
cdp-drive --json snapshot
cdp-drive --json logs 3
```

If `snapshot` shows what you expected and `logs` is empty, the change works in the browser. If not, the output says what went wrong.

### Rules

- **Check before claiming.** Don't report UI work as done without a `snapshot` or a `text` read that shows it.
- **Prefer `snapshot` to screenshots.** Take a screenshot only when layout or visual styling is the question.
- **Wait, don't sleep.** Use `wait "<selector>"` rather than a fixed delay.
- **Read `logs` after an action** that could throw.
- **Don't use a real user's browser profile without asking.** `launch` uses a throwaway profile by default; a real profile carries live logins.
- **Never send the debugging port beyond `127.0.0.1`.** Anything that reaches it controls the browser.
