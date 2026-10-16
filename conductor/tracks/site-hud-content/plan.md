# Plan: site-hud-content

1. Edit `website/index.html` (nav, spotlight section, feature-card line).
2. Edit `website/RoadMap/index.html` (nav, Era 6 card, DETAILS[6]).
3. Edit `website/DownLoad/index.html` (nav, FAQ entry).
4. Serve on 8901+ (own python http.server, kill afterwards with
   CommandLine verification); Playwright screenshots 1280 + 390, console
   errors must be 0; verify pills + anchors.
5. PR to DEV (intended files only) → CI green → merge → report Pages deploy.
