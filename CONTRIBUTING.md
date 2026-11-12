# Contributing to Station 256

Thanks for wanting to help. Please read this short guide first.

## Before you start

- Read [docs/03-how-it-works.md](docs/03-how-it-works.md) and [docs/04-decisions-and-gotchas.md](docs/04-decisions-and-gotchas.md). The second one lists decisions that are already settled and traps that have already been hit.
- For anything bigger than a small fix, open an issue first and describe what you want to change.
- Report security problems privately, not in an issue. See [SECURITY.md](SECURITY.md).

## Setting up

Follow [docs/02-rebuild-step-by-step.md](docs/02-rebuild-step-by-step.md) to get a working house, then work in a branch. The app lives in `panel/`; run `npm install` there, and start it with `panel/start.sh`.

## Making a change

- Keep changes small and focused. One idea per pull request.
- Match the style around you: plain JavaScript in the renderer (no framework), short plain comments that explain why.
- Do not add a dependency unless there is a clear reason. Say why in the pull request.
- Never commit secrets, tokens, Microsoft fonts or compiled launcher programs (`.exe`, `.dll`).
- Update the docs and `CHANGELOG.md` when behaviour changes.

## Testing

Run the tests that sit next to what you changed. The root scripts (`safety-test.sh`, `room-test.sh`, `rules-test.sh`, `web-rule-test.sh`) and the tests in `panel/test/` are described in [docs/05-tests.md](docs/05-tests.md). Read its rules first: some tests touch rooms and the firewall, and they must be run the way it says. Say in your pull request which tests you ran.

## Licence

By contributing, you agree that your work is released under The Unlicense, except changes inside `editor/`, which stay under the MIT licence of OpenCut.
