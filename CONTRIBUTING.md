# Contributing to InstaRide

Thanks for considering a contribution. This is a real-time ride-matching
platform with a dual-engine spatial index (TypeScript PR-QuadTree + native
C++ `-O3`) wired together through atomic CAS lock leases and a deterministic
trip state machine.

## Prerequisites

| Tool | Version | Required? |
| --- | --- | --- |
| Node.js | >= 20 | yes |
| pnpm | 9.x | yes |
| Redis | any recent | yes — the suites exercise the Redis lock and trip-store invariants |
| GCC / MinGW-w64 or Clang | C++14 | only for the native engine |

## Setup

```bash
git clone https://github.com/Souma061/InstaRide.git
cd InstaRide
pnpm install
cp .env.example .env          # edit REDIS_* if your Redis is not on 127.0.0.1:6379
pnpm build:frontend
pnpm build:cpp                # required: two core suites drive engine_bridge.exe
```

`pnpm build:cpp` is not optional for tests. `test_cpp_bridge.ts` and
`test_cpp_engine_e2e.ts` are in the core tier and both invoke the compiled
bridge through koffi. The `.exe` is gitignored, so a fresh clone has none.

> Use pnpm 9.x. The repo pins `packageManager`, so corepack handles this
> automatically. A newer global pnpm (10/11) rejects this repo's
> `pnpm-workspace.yaml`.

## Verifying your change

```bash
pnpm typecheck    # tsc --noEmit, must be 0 errors
pnpm test         # 13 core suites, non-zero exit on any failure
```

`pnpm test` is the gate CI runs — it is the aggregate runner
(`tests/integration_all.ts`), not a single suite. A suite counts as passing
only when it exits `0` *and* prints no failure marker, because several suites
assert via console output rather than exit code.

Run one suite while iterating:

```bash
pnpm test:quadtree
pnpm test:concurrency
pnpm test:e2e            # boots a real server on ports 3997-3999
pnpm exec tsx tests/integration_all.ts --only redis
```

### The stress tier

`pnpm test:all:stress` adds four long-running suites that need the H3
libraries (`libh3.dll`, `hexgrid.dll`). Those are third-party prebuilt
binaries and are gitignored, so build them from `cpp-engine/h3api.h` first.
CI does not run the stress tier.

## Making a change

1. Branch off `main` — never commit directly to it.
   `git checkout -b feat/short-description`, or `fix/...` / `chore/...`.
2. Keep a change to one concern. The suite layout in `tests/` mirrors the
   source layout, so a fix in `src/utils/min_heap.ts` wants coverage
   alongside it.
3. Do not commit build output, `.env`, or scratch files. `.gitignore` already
   covers `*.exe`, `*.dll`, `*.a`, `*.gch` and `.env` — if something gets
   through, that is a `.gitignore` bug worth fixing in the same PR.
4. Preserve the invariants. The matching engine relies on the trip state
   machine's transition matrix and on CAS lock leases staying leak-free. A
   change that lets one driver hold two trips, or that leaks a lock, is a
   regression even if the suite happens to pass.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: reap e2e server on Ctrl+C so the next run finds a free port
feat: add stale driver eviction to the region reset path
chore: remove dead root-level prototype scripts
```

Recent history mostly follows this, so matching it keeps the log greppable.
Keep the subject imperative and under ~72 characters.

## Pull requests

- Open a PR rather than pushing to `main`. CI must be green: `typecheck` plus
  the 13 core suites.
- Describe the behaviour change and how you verified it.
- If you touch the spatial engines, matching service, trip FSM, or the Redis
  locking layer, say which invariant you relied on — those parts have subtle
  concurrency behaviour and deserve explicit review.
- One logical change per PR. Behaviour-preserving refactors are fine, but
  keep them separate from fixes.

## Reporting bugs

Open an issue with reproduction steps, which engine you ran (TypeScript or
C++), and the relevant suite output. For concurrency or lock-leak bugs,
include the harness counts (`STRESS_DRIVERS`, `STRESS_RIDES`,
`STRESS_WAVES`) — these failures are usually load-dependent.

## License

By contributing you agree that your work is licensed under the
[MIT License](LICENSE).
