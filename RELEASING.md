# Releasing

Published artifacts and git must stay in **lockstep**: every version pushed to
npm or PyPI gets a matching git tag + GitHub release in the same session, on
the commit that bumped the version. Never publish a package version without
tagging the repo.

## Version map

| Artifact | Source | Version file |
|---|---|---|
| `pingio-mcp-server` (npm) | `packages/mcp-server` | `packages/mcp-server/package.json` |
| `pingio` (PyPI) | `python/` | `python/pyproject.toml` |

Tags use the npm convention: `<package>@<version>`
(e.g. `pingio-mcp-server@0.1.4`, `pingio@0.1.2`).

## npm (pingio-mcp-server)

```bash
npm run test --workspace=pingio-mcp-server
npm run build --workspace=pingio-mcp-server
# bump "version" in packages/mcp-server/package.json, then:
npm install --package-lock-only          # keep lockfile in sync (npm ci in Docker breaks otherwise)
npm publish --workspace=pingio-mcp-server --access public
npm view pingio-mcp-server version       # confirm it landed
git add -A && git commit -m "release pingio-mcp-server X.Y.Z"
git tag -a "pingio-mcp-server@X.Y.Z" -m "npm pingio-mcp-server X.Y.Z"
git push origin main --follow-tags
gh release create "pingio-mcp-server@X.Y.Z" --title "pingio-mcp-server X.Y.Z" --notes "..."
```

## PyPI (pingio)

```bash
# bump version in python/pyproject.toml, then:
python -m build python/
twine upload python/dist/*
pip index versions pingio                # confirm it landed
git add -A && git commit -m "release pingio X.Y.Z"
git tag -a "pingio@X.Y.Z" -m "PyPI pingio X.Y.Z"
git push origin main --follow-tags
gh release create "pingio@X.Y.Z" --title "pingio (Python) X.Y.Z" --notes "..."
```

## Rules

- Publish → tag → GitHub release, in that order, every time. No exceptions.
- The tag points at the release commit (the one containing the version bump).
- Never commit registry tokens; they go in ephemeral env/npmrc files only and
  are deleted immediately after publishing.
- Production deploys (auth/relay on the hosted box) are separate from
  releases — see `infrastructure/DEPLOYMENT.md` and the git-bundle deploy path
  documented in the project memory.
