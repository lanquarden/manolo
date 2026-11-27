# Sample Blueprint bundle

Copy this directory to the worker's `MANOLO_BLUEPRINTS_DIR` and edit the manifest for the deployment:

- `profiles` names model ids the worker can reach. The sample `manolo-default` model-proxy id and `medium` reasoning are
  examples; an unresolvable profile is dropped and its Blueprints are not offered. A `model-proxy` worker also checks the
  proxy's `GET /v1/models` catalog, so an alias the proxy does not list is not offered even if it is named here.
- `repositories.manolo.handoff` is an owned fork account. A GitHub handoff must target `lanquarden` or
  `manolo-mistalibio`; a local path is accepted for fixtures.
- `general` is the default generic Task. `manolo-repo` is the sample repository Task. `conversation` is never offered as
  a Task target.
- Every Task Blueprint lists the lifecycle tools `report_progress`, `post_inbox`, and `finish` explicitly. Unknown tool
  names fail closed. A conversation Blueprint may omit `tools` (or set `null`) for the default set, or use `[]` for none.
- Install it by copying the directory to the worker and setting `MANOLO_BLUEPRINTS_DIR`, or in Helm with
  `agents.<id>.blueprintsDir` / `agents.<id>.blueprintsMount.configMap` (see `deploy/helm/manolo/values.yaml`). A
  configured directory without `manifest.json` stops worker startup rather than running unconfigured.
