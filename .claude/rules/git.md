# Git conventions

- Conventional Commits: `type(scope): summary`, where type is `feat`, `fix`, `test`, `docs`,
  `refactor`, `chore`, `build` or `ci`, and scope is `sdk`, `core`, `ui`, `cli`, `plugins`,
  `deploy` or `docs`. Use a plugin's short name as the scope when only that plugin changes
  (`fix(source-github): ...`).
- Breaking SDK changes use `!` (`feat(sdk)!: ...`) and a `BREAKING CHANGE:` footer.
- Run `pnpm check` before committing. Don't commit with failing typecheck, lint or unit tests.
- Commit generated Drizzle migrations together with the schema change that produced them.
- Never commit secrets, `.env` files or recorded fixtures that contain real tokens. Scrub them
  with `scrubRequest` from the SDK's testing kit.
