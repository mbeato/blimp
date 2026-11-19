# Contributing to blimp

Thank you for your interest in blimp. Bug reports, ideas and pull requests are all welcome.

## Report a bug

Open an [issue](https://github.com/mbeato/blimp/issues/new/choose) with the bug report form. It asks for these things, because most bugs depend on them:

- The app's version (**blimp > About blimp**) and your macOS version.
- blimpd's version: run `~/.local/bin/blimpd --version` on the server.
- The server's system (for example Debian 13 on x86_64, or macOS 15 on a Mac with an Apple chip).
- What you did, what you expected, and what happened. If blimp showed an error, copy its text.

Look at [Troubleshooting](README.md#troubleshooting) first. It covers the common problems with SSH, systemd and zmx.

## Change the code

[Development](README.md#development) in the README says how the repository is laid out, and how to build and test each part. [docs/DESIGN.md](docs/DESIGN.md) says how the parts talk to each other.

Before you open a pull request:

- For a large change, open an issue first, so we can agree on the approach before you write the code.
- Run the tests for the part you changed: `bun test --parallel` in the repository root for blimpd, and `bun run test` in `app/` for the interface. If you changed how the interface behaves, also run the Playwright tests (`bun run e2e` in `app/`).
- If you changed what a user sees or does, change the README in the same pull request.
- Keep one subject per pull request.

## Style

- A commit title starts with the part it changes, then says what is different for the user. For example: `blimpd: the show tool gives up on a blimpd that doesn't answer within 15 s`. The parts in use are `blimpd`, `Mac app`, `iPhone`, `relay`, `Docs` and `Spec`.
- The docs use short, plain sentences, one idea in each. Write new text the same way.
- Match the code around your change. Do not reformat lines that you did not change.

## License

blimp has the [MIT license](LICENSE). Your contribution gets the same license.
