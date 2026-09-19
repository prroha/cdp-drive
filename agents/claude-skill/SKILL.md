---
name: browser-check
description: Use after changing UI code, or when asked whether something works in the browser — verifies the running app with cdp-drive instead of guessing. Also use to debug a page, read console errors, fill a form, or check what a page renders.
---

# Checking the app in a browser

Verify UI work against the real browser. Read structure, not screenshots: `snapshot` is JSON and costs a fraction of the tokens.

Install once: `npm install -g github:prroha/cdp-drive`

## 1. Make sure a browser is attached

```bash
cdp-drive doctor || cdp-drive launch http://localhost:3000
```

If the dev server isn't running, start it first, then `launch` its URL.

## 2. Look at the page

```bash
cdp-drive --json snapshot
```

Returns `{ url, title, interactive: [{ tag, role, type, name, id, testid, href }] }` for up to 150 visible elements, so you can pick a selector without a screenshot.

Read specific things with `cdp-drive text "<selector>"`, `cdp-drive dom "<selector>"`, `cdp-drive attr "<selector>" <name>` or `cdp-drive eval "<js>"`.

## 3. Drive it

```bash
cdp-drive fill "#email" "user@example.com"
cdp-drive click "button[type=submit]"
cdp-drive wait ".result" --timeout 8000
cdp-drive text ".result"
```

Inside an iframe, list frames first and pass the selector it gives you:

```bash
cdp-drive frames
cdp-drive --frame "iframe#checkout" snapshot
```

## 4. Check for errors

```bash
cdp-drive --json logs 3
```

Console messages, exceptions and browser logs, with repeats folded into counts.

## Interpreting exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Worked | Continue |
| 1 | No match, bad selector, eval threw | Re-read with `snapshot`; the selector is probably wrong |
| 2 | Timed out | The element never appeared, or the page is stuck |
| 3 | No browser reachable | `cdp-drive launch <url>` |

## Rules

- Never report UI work as done without a check that shows it working.
- Use `wait` instead of sleeping.
- Screenshots (`cdp-drive shot`) are for layout and styling questions only.
- Ask before driving the user's everyday browser profile; it holds live logins.
