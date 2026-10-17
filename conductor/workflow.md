# Workflow

1. Context -> Spec & Plan -> Implement
2. TDD where possible, small commits
3. Never move physical cursor for background AI work — use UIA/PostMessage
4. Physical cursor = user only. Virtual cursor = software only.
5. Safety switches must always work even if backend hangs.
6. Public release: `npm run dist:public` (VITE_ABxAG_PUBLIC=1) → `release-public/` —
   git-ignored local build folder (`electron-builder.public.yml`); then GitHub release
   (tag vX.Y.Z) + `website/releases.json` refresh + Cloudflare Pages deploy of `website/`.
