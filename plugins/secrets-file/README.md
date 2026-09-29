# @ai-switchboard/secrets-file

Secret provider type `file`: resolves `secret://file/<name>` from one file per secret in a
directory: the Docker secrets and Kubernetes secret-volume pattern. No network.

## Settings

| Field       | Group  | Default        | Description                                                              |
| ----------- | ------ | -------------- | ------------------------------------------------------------------------ |
| `directory` | Lookup | `/run/secrets` | Absolute path of the directory holding the files                         |
| `writable`  | Writes | `false`        | Let Switchboard store credentials instances rotate here (see **Writes**) |

## Behaviour

- `resolve(name)` reads `<directory>/<name>` as UTF-8 and strips trailing newlines (`\n` or
  `\r\n`); inner newlines, such as in a PEM key, are kept.
- Names must be bare file names: a name containing `/`, `\`, `..` or NUL is rejected, so a
  reference cannot escape the directory.
- Symlinks inside the directory are followed (Kubernetes mounts each key as a symlink into
  `..data/`).
- A missing, unreadable or empty file throws `SecretNotFoundError` naming the path (never a value).
- `list()` (SDK 1.1) returns the **names** of the non-empty regular files in the directory (symlinks
  followed, dotfiles such as `..data` skipped) with `updatedAt` from the file's mtime. It never
  reads a file's contents. A directory that cannot be read throws `SecretNotFoundError`.
- `health()` is `healthy` when the directory exists and is readable, `unhealthy` otherwise.

## Writes

With `writable: true` the provider also implements `set` and `delete` (SDK 2.2). The host uses them
for credentials that instances rotate themselves (`ctx.secrets`, for example the Claude Routines
seat's OAuth refresh token), stored as `switchboard-<instance id>-<key>`.

- `set` writes a temporary dotfile in the same directory, then renames it over the target, so a
  reader sees the old value or the new one, never half of either. A new file gets mode `0600`; a
  replaced one keeps its mode.
- `delete` removes the file; a missing file is not an error.
- Names follow the read rules, and dotfiles are refused as well. Errors name the path, never the
  value.
- `health()` is also `unhealthy` when the directory is not writable.
- Use a persistent volume shared by every replica, not a read-only Kubernetes secret mount. Each
  replica must see the newest rotated value.

Rotation: update the file (Kubernetes does this in place), then _Reload instance_ on the
instances that use it.

## Kubernetes

```yaml
volumes:
  - name: switchboard-secrets
    secret: { secretName: switchboard }
containers:
  - name: switchboard
    volumeMounts:
      - { name: switchboard-secrets, mountPath: /run/secrets, readOnly: true }
```

`secret://file/github-app-key` then reads the `github-app-key` key of the `switchboard` secret.
