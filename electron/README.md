# Electron input-injection spike

Goal: prove that **nut.js can inject synthetic input (move + click + type + Enter)
into other applications on your Mac** — the one feature that does NOT come for
free in Electron and that decides whether migrating `screensound` is worth it.

This is throwaway proof-of-concept code. It is NOT the migration.

## Run it (on the Mac)

```bash
cd electron
npm install
npm start
```

`npm install` builds a native module (`node-gyp`). If it fails, you need Xcode
command line tools: `xcode-select --install`.

If the `@nut-tree-fork/nut-js` version fails to resolve, install the latest:

```bash
npm install @nut-tree-fork/nut-js@latest
```

## Grant permission (macOS)

Synthetic input requires Accessibility permission. The first run will fail until
you grant it:

- **System Settings → Privacy & Security → Accessibility** → enable the app that
  runs it (during `npm start` that's **Electron**; in a packaged build it's the
  app itself).

You may need to quit and relaunch after granting.

## What success looks like

1. Open TextEdit (or any text field) and note where its text area sits on screen.
2. Put those coordinates in the X / Y fields, hit **Run**.
3. During the 5s countdown, don't touch anything.
4. nut.js clicks that point and types the text + Enter into TextEdit.

Log shows `RESULT: nut.js injection WORKS ✅` → the migration is viable.
Log shows `FAILED ❌` → read the error; usually missing Accessibility permission.

## If it works

Next step is porting the pure domain (freeze state machine, RMS, edge-trigger)
to TypeScript — it has no OS dependencies and ports 1:1. See the migration order
discussed with the team.
