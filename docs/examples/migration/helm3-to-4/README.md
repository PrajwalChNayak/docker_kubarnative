# helm3-to-4

A command and flag cheatsheet for moving from Helm 3 to Helm 4.

| File | Role |
|---|---|
| `cheatsheet.md` | Flag renames, the server-side-apply default, and the commands whose flags changed - each row checked against `helm <cmd> --help` on the 4.3.0 binary in `.tools/helm.exe`. |

There are no charts to apply here; the migration is entirely about the CLI and
the release apply method. The full narrative, including which behaviours were
verified versus reported, is in `content/migration/helm-3-to-4.md`.

Reproduce the verification yourself (client-side, no cluster):

```bash
.tools/helm.exe upgrade --help | grep -E -- '--(wait|rollback-on-failure|force-replace|server-side|force-conflicts|post-renderer|dry-run)'
.tools/helm.exe version --client   # Error: unknown flag: --client
.tools/helm.exe lint --help        # Usage: helm lint PATH [flags]
```
