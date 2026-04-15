# Contributing to Mobile Mode

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or behaviour |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no behaviour change |
| `chore` | Build, deps, config — no production code |
| `test` | Adding or fixing tests |
| `ci` | CI/CD pipeline changes |

### Scopes

| Scope | What it covers |
|-------|---------------|
| `frontend` | `src/index.tsx` |
| `backend` | `main.py` |
| `assets` | Files in `assets/` |
| `deps` | Dependency changes |
| *(none)* | Cross-cutting or repo-wide |

### Examples

```
feat(frontend): inject Switch to Mobile into Power Menu
fix(backend): handle missing steamosctl gracefully
docs: add Power Menu research notes to CLAUDE.md
chore(deps): update @decky/ui to 4.12.0
refactor(backend): simplify _install_session_files
```

### Breaking changes

Add `!` after the type/scope and a `BREAKING CHANGE:` footer:

```
feat(backend)!: change enable_mobile return shape

BREAKING CHANGE: result now includes `session` field
```

---

## Branch strategy

- `main` — stable, always builds
- Feature branches: `feat/<name>` or `fix/<name>`
- Open a PR into `main` when ready

---

## Development setup

```bash
pnpm i
pnpm run watch   # rebuild on save
```

Deploy to device — see [`.claude/CLAUDE.local.md`](.claude/CLAUDE.local.md).

## Testing on device

1. Deploy plugin
2. Open Power Menu → verify "Switch to Mobile" appears after "Switch to Desktop"
3. Tap "Switch to Mobile" → KDE starts in portrait
4. Verify rotation, Maliit keyboard on text input
5. "Return to Gaming" → back to Gaming Mode

## Reporting issues

Open an issue on GitHub. Include:
- SteamOS version (`cat /etc/os-release`)
- Steam build date (visible in DevTools console on load)
- Decky Loader version
- `~/.config/mobile-mode/session.log`
- Decky logs: `journalctl -u plugin_loader --since "10 min ago"`
