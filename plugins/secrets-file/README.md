# @ai-switchboard/secrets-file

Secret provider type `file`: resolves `secret://file/<name>` from one file per secret in a
directory: the Docker secrets and Kubernetes secret-volume pattern. No network.

## Settings

| Field       | Group  | Default        | Description                                      |
| ----------- | ------ | -------------- | ------------------------------------------------ |
| `directory` | Lookup | `/run/secrets` | Absolute path of the directory holding the files |

## Behaviour

- `resolve(name)` reads `<directory>/<name>` as UTF-8 and strips trailing newlines (`\n` or
  `\r\n`); inner newlines, such as in a PEM key, are kept.
- Names must be bare file names: a name containing `/`, `\`, `..` or NUL is rejected, so a
  reference cannot escape the directory.
- Symlinks inside the directory are followed (Kubernetes mounts each key as a symlink into
  `..data/`).
- A missing, unreadable or empty file throws `SecretNotFoundError` naming the path (never a value).
- `health()` is `healthy` when the directory exists and is readable, `unhealthy` otherwise.

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
