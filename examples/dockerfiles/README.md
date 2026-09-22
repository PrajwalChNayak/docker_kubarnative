# Focused Dockerfile demos

Small, self-contained Dockerfiles that each isolate one lesson from
[Part C: Docker, intermediate](../../content/docker-intermediate). Every
Dockerfile passes `hadolint` and pins its base image by digest.

| Directory | Demonstrates |
|---|---|
| [`signal-forms/`](signal-forms) | Exec vs shell `ENTRYPOINT` and how the shell form swallows `SIGTERM` (measure `docker stop` timing). |
| [`init-and-zombies/`](init-and-zombies) | PID 1 responsibilities: with and without an init (`tini`) reaping zombies. |
| [`cache-ordering/`](cache-ordering) | How instruction order changes layer-cache hits on rebuild. |
| [`size-naive-vs-optimised/`](size-naive-vs-optimised) | Image-size difference between a naive and an optimised multi-stage build. |

Each subdirectory has its own README with the exact `docker build`, `docker run`
and inspection commands, and the captured output shown on the docs pages comes
from `captures/requests/docker-intermediate.txt`.
