# @ai-switchboard/secrets-env

Secret provider type `env`: resolves `secret://env/<NAME>` from the Switchboard process's
environment variables. No network.

## Settings

| Field     | Group   | Default | Description                                                                                                                                         |
| --------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`  | Lookup  | `""`    | Prepended to every name. With `SWITCHBOARD_SECRET_`, `secret://env/GITHUB_TOKEN` reads `SWITCHBOARD_SECRET_GITHUB_TOKEN`                            |
| `include` | Listing | `""`    | Comma-separated globs (`GITHUB_*,SLACK_URL`) that narrow the names `list()` shows, matched after the prefix is stripped. Resolution is not affected |

A prefix keeps secret references from reaching unrelated variables (`DATABASE_URL`, `PATH`).

## Behaviour

- `resolve(name)` returns `process.env[prefix + name]`.
- Names must look like variable names (`[A-Za-z_][A-Za-z0-9_]*`).
- An unset **or empty** variable throws `SecretNotFoundError` naming the variable (never a value).
- Values are read at instance creation; after changing the environment, restart the process
  (environment variables cannot change under a running process) and _Reload instance_.
- `list()` (SDK 1.1) returns variable **names only**, never values: with a prefix, the non-empty
  variables that start with it (prefix stripped); without one, every non-empty variable except
  shell, locale and runtime plumbing (`PATH`, `HOME`, `SHELL`, `PWD`, `TERM*`, `LANG`, `LC_*`,
  `NODE_*`, `npm_*`, `XDG_*`, …; see `SYSTEM_VARIABLES`). `include` narrows it further.
- `health()` is always `healthy`.
