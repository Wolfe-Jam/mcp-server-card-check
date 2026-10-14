# Contributing

Thanks for helping. The checker is only useful if its verdicts are right, so the most valuable contribution is telling us when one isn't.

## A wrong verdict

[Open a "Wrong verdict" issue](https://github.com/Wolfe-Jam/mcp-server-card-check/issues/new?template=wrong-verdict.yml) with the URL, the check id and the spec text you're reading. The spec decides: every check names the section it comes from, and its level (MUST or SHOULD) follows the spec's wording.

## Code

```sh
npm ci
npm test          # node:test, offline: fake servers answer through an injected fetch
npm run typecheck
```

- A new or changed check needs a test with a fake server that gets it wrong, and an entry in `src/refs.ts` linking the spec section.
- Keep default runs read-only (GET and OPTIONS). Anything that POSTs runs only with `--transport`.
- `npm run smoke` packs and installs the package and runs both commands, as `prepublishOnly` does.

Pull requests run CI on Ubuntu, macOS and Windows with Node 22 and 24.
