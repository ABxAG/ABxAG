<!-- ABxAG PR checklist (HANDOFF.md §5: every fix lands via PR to DEV) -->
## What changed

-
## Why

-
## Verify (paste results)

- [ ] `npm run lint` clean
- [ ] `npm run test:agent` green (___/___)
- [ ] `npm run test:python` green (___/___)
- [ ] Touched `.cjs` passes `node --check`
- [ ] Secret-scan of the diff clean (no keys/tokens)
- [ ] Browser check (website changes only): desktop + mobile screenshots

## Safety

- [ ] `D:\APPs\*` untouched (no installed-app processes killed)
- [ ] Only intended files staged (no line-ending noise commits)
