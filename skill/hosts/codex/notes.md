## Host notes (Codex)

- Invocation: the user may type `$miosotis …` or pick it with `/skills`; also act on it whenever the request matches this Skill.
- Images: call the `view_image` tool with the `path` from `source get` or `enrich prepare` before writing `interpretations`. `cat` does not show images.
- Sandbox: miosotis writes to its library (`miosotis doctor` shows the data dir, usually `~/.miosotis`), and saving web links needs network access for `curl`. If a command fails with a permission or sandbox error, don't work around it. Tell the user to allow it once, for example by starting Codex with `--add-dir ~/.miosotis`, or permanently in `~/.codex/config.toml` (use the absolute path):
  ```toml
  [sandbox_workspace_write]
  writable_roots = ["/Users/<you>/.miosotis"]
  network_access = true
  ```
