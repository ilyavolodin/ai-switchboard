# @ai-switchboard/secrets-env

Secret provider type `env`: resolves `secret://env/<NAME>` from the Switchboard process's
environment variables. No network.

## Settings

| Field    | Group  | Default | Description                                                                                                              |
| -------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `prefix` | Lookup | `""`    | Prepended to every name. With `SWITCHBOARD_SECRET_`, `secret://env/GITHUB_TOKEN` reads `SWITCHBOARD_SECRET_GITHUB_TOKEN` |

A prefix keeps secret references from reaching unrelated variables (`DATABASE_URL`, `PATH`).

## Behaviour

- `resolve(name)` returns `process.env[prefix + name]`.
- Names must look like variable names (`[A-Za-z_][A-Za-z0-9_]*`).
- An unset **or empty** variable throws `SecretNotFoundError` naming the variable (never a value).
- Values are read at instance creation; after changing the environment, restart the process
  (environment variables cannot change under a running process) and _Reload instance_.
- `health()` is always `healthy`.
